import { describe, expect, it, vi } from 'vitest';
import { CHUNK_BYTES, contentKey, contentStorageFromEnv, D1Client, D1ContentStore } from './d1ContentStore.js';

const options = { accountId: 'a'.repeat(32), databaseId: '11111111-1111-1111-1111-111111111111', apiToken: 'private-test-token' };

function memoryD1() {
  const manifests = new Map<string, { byte_length: number; chunk_count: number }>();
  const chunks = new Map<string, Map<number, string>>();
  const query = vi.fn(async (sql: string, params: (string | number | null)[] = []) => {
    const key = params[0] as string;
    if (sql.startsWith('INSERT OR IGNORE INTO content_chunks')) {
      const rows = chunks.get(key) || new Map<number, string>();
      if (!rows.has(params[1] as number)) rows.set(params[1] as number, params[2] as string);
      chunks.set(key, rows);
      return [];
    }
    if (sql.startsWith('INSERT OR IGNORE INTO content_blobs')) {
      if (!manifests.has(key)) manifests.set(key, { byte_length: params[1] as number, chunk_count: params[2] as number });
      return [];
    }
    if (sql.startsWith('SELECT byte_length')) return manifests.has(key) ? [manifests.get(key)] : [];
    return [...(chunks.get(key)?.entries() || [])]
      .filter(([index]) => index >= (params[1] as number) && index < (params[2] as number))
      .map(([chunk_index, data]) => ({ chunk_index, data }));
  });
  return { client: { query } as unknown as D1Client, query, chunks, manifests };
}

describe('D1 content storage', () => {
  it('round-trips multi-megabyte content, emoji, and lone surrogates after process restart', async () => {
    const db = memoryD1();
    const content = 'const emoji = "🙂";\n\ud800\u0000' + 'x'.repeat(2_100_000);
    const key = await new D1ContentStore(db.client).put(content);
    expect(await new D1ContentStore(db.client).get(key)).toBe(content);
    expect([...db.chunks.get(key)!.values()].every(value => value.length <= CHUNK_BYTES * 4 / 3)).toBe(true);
    expect(key).toBe(contentKey(content));
  });

  it('round-trips empty content and deduplicates repeated saves', async () => {
    const db = memoryD1();
    const store = new D1ContentStore(db.client);
    const key = await store.put('');
    const requests = db.query.mock.calls.length;
    expect(await store.put('')).toBe(key);
    expect(db.query.mock.calls).toHaveLength(requests);
    expect(await new D1ContentStore(db.client).get(key)).toBe('');
  });

  it('does not publish a manifest after a partial upload fails', async () => {
    const db = memoryD1();
    db.query.mockImplementationOnce(async () => []).mockRejectedValueOnce(new Error('Unavailable'));
    await expect(new D1ContentStore(db.client).put('x'.repeat(CHUNK_BYTES))).rejects.toThrow('Unavailable');
    expect(db.manifests.size).toBe(0);
  });

  it('rejects missing chunks and altered content instead of returning empty or damaged text', async () => {
    const db = memoryD1();
    const key = await new D1ContentStore(db.client).put('original');
    db.chunks.get(key)!.set(0, Buffer.from('tampered', 'utf16le').toString('base64'));
    await expect(new D1ContentStore(db.client).get(key)).rejects.toThrow('integrity');
    db.chunks.get(key)!.clear();
    await expect(new D1ContentStore(db.client).get(key)).rejects.toThrow('incomplete');
    await expect(new D1ContentStore(db.client).get('b'.repeat(64))).rejects.toThrow('incomplete');
  });

  it('does not acknowledge a reused damaged blob as a successful upload', async () => {
    const db = memoryD1();
    const content = 'the only intact inline copy';
    const key = contentKey(content);
    db.chunks.set(key, new Map([[0, Buffer.from('damaged', 'utf16le').toString('base64')]]));
    const store = new D1ContentStore(db.client);
    await expect(store.put(content)).rejects.toThrow('integrity');
    // A failed upload must not cache the caller's intact string and make a
    // retry appear successful while the stored bytes are still damaged.
    await expect(store.put(content)).rejects.toThrow('integrity');
  });

  it('keeps raw provider errors and credentials out of errors', async () => {
    const fetcher = vi.fn(async () => new Response('secret-token-and-file-content', { status: 403 }));
    await expect(new D1Client(options, fetcher as typeof fetch).query('SELECT ?', ['private-code'])).rejects.toThrow(/^D1 request failed \(HTTP 403\)\.$/);
    const init = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[0]).toContain('api.cloudflare.com/client/v4/accounts/');
    expect(JSON.parse(init[1].body as string).params).toEqual(['private-code']);
  });

  it('checks both envelope and per-query success', async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: [{ success: false, error: 'private content' }] }));
    await expect(new D1Client(options, fetcher as typeof fetch).query('SELECT 1')).rejects.toThrow('D1 rejected the query.');
  });

  it('defaults to Postgres and requires complete configuration when D1 is enabled', () => {
    expect(contentStorageFromEnv({})).toEqual({ writeToD1: false });
    expect(() => contentStorageFromEnv({ FILE_CONTENT_STORAGE: 'd1' })).toThrow('D1 requires');
    expect(() => contentStorageFromEnv({ FILE_CONTENT_STORAGE: 'unknown' })).toThrow('must be');
    const env = { CLOUDFLARE_ACCOUNT_ID: options.accountId, CLOUDFLARE_D1_DATABASE_ID: options.databaseId, CLOUDFLARE_D1_API_TOKEN: options.apiToken };
    expect(contentStorageFromEnv({ ...env, FILE_CONTENT_STORAGE: 'postgres' }).store).toBeDefined();
    expect(contentStorageFromEnv({ ...env, FILE_CONTENT_STORAGE: 'd1' }).writeToD1).toBe(true);
  });
});
