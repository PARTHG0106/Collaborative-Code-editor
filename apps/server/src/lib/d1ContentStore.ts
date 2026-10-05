import { createHash } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import axios from 'axios';

export interface ContentStore {
  put(content: string): Promise<string>;
  get(key: string): Promise<string>;
}

export interface D1Options {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

export const D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS content_blobs (
    content_key TEXT PRIMARY KEY, byte_length INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS content_chunks (
    content_key TEXT NOT NULL, chunk_index INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (content_key, chunk_index)
  )`,
];

// Each base64 SQLite value is 256 KiB, well below D1's 2 MB row/value limit.
// UTF-16LE preserves JS strings exactly, including lone surrogate code units.
export const CHUNK_BYTES = 192 * 1024;
const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_TIMEOUT_MS = 15_000;
// The agent options also reach the proxy's CONNECT socket; setting family only
// on the HTTP request would leave the proxy hostname free to resolve to IPv6.
const TLS_AGENT = new HttpsAgent({ keepAlive: true, rejectUnauthorized: true, family: 4 });
type D1Transport = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

// Node 20 fetch does not honor the platform's HTTP(S)_PROXY settings. The
// Node HTTP adapter does, and IPv4 avoids an unusable IPv6 egress route.
const nodeHttpTransport: D1Transport = async (url, init) => {
  const response = await axios.request<string>({
    adapter: 'http', url, method: 'POST', data: init.body,
    headers: init.headers as Record<string, string>, signal: init.signal ?? undefined,
    family: 4, timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0,
    httpsAgent: TLS_AGENT,
    // read() pages four chunks (1 MiB base64 plus JSON) per response, even for
    // a 100 MiB file. This cap applies to a page, not the whole stored file.
    maxBodyLength: 2 * 1024 * 1024, maxContentLength: 8 * 1024 * 1024,
    responseType: 'text', transformResponse: [data => data], validateStatus: () => true,
    // Deliberately leave proxy unset so Axios honors HTTPS_PROXY/ALL_PROXY and
    // NO_PROXY. Never log its resolved proxy URL or authentication details.
  });
  return { ok: response.status >= 200 && response.status < 300, status: response.status,
    json: async () => JSON.parse(response.data) as unknown };
};

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
  'ERR_NETWORK', 'ERR_INVALID_URL', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** A fixed allowlist prevents provider errors or proxy credentials reaching logs. */
export function d1NetworkDiagnostic(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let code = 'UNKNOWN';
  let cause = error;
  for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
    const item = cause as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && NETWORK_CODES.has(item.code)) code = item.code;
    else if (item.name === 'TimeoutError' || item.name === 'AbortError') code = 'TIMEOUT';
    cause = item.cause;
  }
  const configured = (name: string) => Boolean(env[name.toLowerCase()]?.trim() || env[name]?.trim());
  return `transport=node-http; family=4; code=${code}; httpsProxy=${configured('HTTPS_PROXY')}; httpProxy=${configured('HTTP_PROXY')}; allProxy=${configured('ALL_PROXY')}; noProxy=${configured('NO_PROXY')}`;
}

export function contentKey(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf16le')).digest('hex');
}

export class D1Client {
  private readonly endpoint: string;

  constructor(private readonly options: D1Options, private readonly fetcher: D1Transport = nodeHttpTransport) {
    if (!/^[a-f0-9]{32}$/i.test(options.accountId) ||
        !/^[a-f0-9-]{36}$/i.test(options.databaseId) || !options.apiToken.trim()) {
      throw new Error('Invalid D1 configuration: set account ID, database ID, and API token.');
    }
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
  }

  async query<T>(sql: string, params: (string | number | null)[] = []): Promise<T[]> {
    let response: Pick<Response, 'ok' | 'status' | 'json'>;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Never include request headers, SQL values, or provider bodies in logs.
      throw new Error(`D1 request failed (${d1NetworkDiagnostic(error)}).`);
    }
    if (!response.ok) throw new Error(`D1 request failed (HTTP ${response.status}).`);
    let body: { success?: boolean; result?: { success?: boolean; results?: T[] }[] };
    try { body = await response.json() as typeof body; }
    catch { throw new Error('D1 returned an invalid response.'); }
    if (body.success !== true || !Array.isArray(body.result) || body.result.length === 0 ||
        body.result.some(result => result.success !== true)) {
      throw new Error('D1 rejected the query.');
    }
    return body.result.flatMap(result => result.results ?? []);
  }

  async initialize(): Promise<void> {
    for (const sql of D1_SCHEMA) await this.query(sql);
  }

  async check(): Promise<void> {
    const rows = await this.query<{ ok: number }>('SELECT 1 AS ok');
    if (rows.length !== 1 || rows[0].ok !== 1) {
      throw new Error('D1 connectivity check returned an unexpected result.');
    }
  }
}

interface Manifest { byte_length: number; chunk_count: number }
interface Chunk { chunk_index: number; data: string }

export class D1ContentStore implements ContentStore {
  // Small bounded cache avoids a second network read immediately after a save.
  private readonly cache = new Map<string, string>();
  private cacheBytes = 0;
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly client: D1Client) {}

  private remember(key: string, content: string): void {
    const bytes = content.length * 2;
    if (bytes > 8 * 1024 * 1024 || this.cache.has(key)) return;
    while (this.cache.size >= 64 || this.cacheBytes + bytes > 8 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value as string;
      this.cacheBytes -= this.cache.get(oldest)!.length * 2;
      this.cache.delete(oldest);
    }
    this.cache.set(key, content);
    this.cacheBytes += bytes;
  }

  async put(content: string): Promise<string> {
    const bytes = Buffer.from(content, 'utf16le');
    if (bytes.length > MAX_CONTENT_BYTES) throw new Error('File exceeds the 100 MiB D1 content limit.');
    const key = contentKey(content);
    if (this.cache.has(key)) return key;
    const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    // Identical concurrent uploads are harmless. A failed upload cannot become
    // visible through Postgres: publish the manifest only after every chunk.
    for (let index = 0; index < chunkCount; index++) {
      const data = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64');
      await this.client.query(
        'INSERT OR IGNORE INTO content_chunks (content_key, chunk_index, data) VALUES (?, ?, ?)',
        [key, index, data],
      );
    }
    await this.client.query(
      'INSERT OR IGNORE INTO content_blobs (content_key, byte_length, chunk_count) VALUES (?, ?, ?)',
      [key, bytes.length, chunkCount],
    );
    // INSERT OR IGNORE can reuse a blob left by an earlier upload. Check the
    // persisted bytes before allowing SQL to discard its inline copy; trusting
    // the caller here would hide a damaged existing chunk until process restart.
    await this.read(key);
    return key;
  }

  async get(key: string): Promise<string> {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid stored content key.');
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const reading = this.read(key);
    this.pending.set(key, reading);
    try { return await reading; }
    finally { this.pending.delete(key); }
  }

  private async read(key: string): Promise<string> {
    const [manifest] = await this.client.query<Manifest>(
      'SELECT byte_length, chunk_count FROM content_blobs WHERE content_key = ?', [key],
    );
    if (!manifest || !Number.isSafeInteger(manifest.byte_length) || manifest.byte_length < 0 ||
        manifest.byte_length > MAX_CONTENT_BYTES || manifest.byte_length % 2 !== 0 ||
        manifest.chunk_count !== Math.max(1, Math.ceil(manifest.byte_length / CHUNK_BYTES))) {
      throw new Error('Stored content is missing or incomplete.');
    }
    const buffers: Buffer[] = [];
    // Page reads to keep individual API responses bounded for large files.
    for (let index = 0; index < manifest.chunk_count; index += 4) {
      const chunks = await this.client.query<Chunk>(
        'SELECT chunk_index, data FROM content_chunks WHERE content_key = ? AND chunk_index >= ? AND chunk_index < ? ORDER BY chunk_index',
        [key, index, Math.min(index + 4, manifest.chunk_count)],
      );
      const expected = Math.min(4, manifest.chunk_count - index);
      if (chunks.length !== expected) throw new Error('Stored content is missing or incomplete.');
      for (let offset = 0; offset < chunks.length; offset++) {
        const chunk = chunks[offset];
        if (chunk.chunk_index !== index + offset || typeof chunk.data !== 'string' ||
            chunk.data.length > CHUNK_BYTES * 4 / 3) throw new Error('Stored content is corrupt.');
        buffers.push(Buffer.from(chunk.data, 'base64'));
      }
    }
    const bytes = Buffer.concat(buffers);
    if (bytes.length !== manifest.byte_length || createHash('sha256').update(bytes).digest('hex') !== key) {
      throw new Error('Stored content failed its integrity check.');
    }
    const content = bytes.toString('utf16le');
    this.remember(key, content);
    return content;
  }
}

export interface ContentStorage { writeToD1: boolean; store?: ContentStore }

export function contentStorageFromEnv(env: NodeJS.ProcessEnv = process.env): ContentStorage {
  const mode = env.FILE_CONTENT_STORAGE || 'postgres';
  if (mode !== 'postgres' && mode !== 'd1') throw new Error('FILE_CONTENT_STORAGE must be postgres or d1.');
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = env.CLOUDFLARE_D1_API_TOKEN;
  if (!accountId && !databaseId && !apiToken && mode === 'postgres') return { writeToD1: false };
  if (!accountId || !databaseId || !apiToken) throw new Error('D1 requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_D1_API_TOKEN.');
  return { writeToD1: mode === 'd1', store: new D1ContentStore(new D1Client({ accountId, databaseId, apiToken })) };
}
