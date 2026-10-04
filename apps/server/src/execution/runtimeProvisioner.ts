import { createHash, createHmac } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';

export function runtimeToken(workspaceId: string): string {
  return createHmac('sha256', process.env.RUNTIME_SIGNING_SECRET || config.jwt.accessSecret)
    .update(`syncscript-workspace-runtime-v1:${workspaceId}`).digest('hex');
}

export function runtimeRepo(workspaceId: string): string {
  const owner = process.env.HF_RUNTIME_OWNER || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(owner)) throw new Error('HF_RUNTIME_OWNER must name the account hosting workspace runtimes.');
  return `${owner}/syncscript-ws-${createHash('sha256').update(workspaceId).digest('hex').slice(0,24)}`;
}

/** Account credentials go only to the Hugging Face control plane, never to code containers. */
async function hubRequest(route: string, init: RequestInit = {}): Promise<Response> {
  return hfRequest(`https://huggingface.co/api/${route}`, init);
}

async function hfRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('The runtime host needs an HF_TOKEN with Space write access.');
  try {
    return await fetch(url, {
      ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(45_000),
    });
  } catch { throw new Error('The Hugging Face runtime request failed or timed out. Please retry.'); }
}

async function checked(route: string, init?: RequestInit): Promise<Response> {
  const response = await hubRequest(route, init);
  if (response.status === 402) throw new Error('Hugging Face requires PRO to create a Docker workspace runtime. Configure a container host or enable PRO; no subscription has been purchased.');
  if (!response.ok) throw new Error(`Runtime provisioning failed (Hugging Face HTTP ${response.status}).`);
  return response;
}

const provisioning = new Map<string, Promise<void>>();
const MANIFEST = '.syncscript-runtime.json';
// This must include the lockfile and every module copied by the Dockerfile.
const SOURCE_FILES = ['Dockerfile', 'package.json', 'package-lock.json', 'server.mjs', 'runtime.mjs', 'safe-files.py', 'README.md'];
type SpaceMetadata = { private?: boolean; sdk?: string; sha?: string; siblings?: { rfilename: string }[]; runtime?: { stage?: string } };
type SourceManifest = { schema: number; workspace: string; apiOrigin: string; credential: string; source: string; files: Record<string, string> };
const digest = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

async function sourceBundle(workspaceId: string, apiOrigin: string): Promise<{ manifest: SourceManifest; records: object[] }> {
  const directory = path.resolve(__dirname, '../../../workspace-runtime');
  const files: Record<string, string> = {};
  const records: object[] = [];
  for (const filename of SOURCE_FILES) {
    const content = await fs.readFile(path.join(directory, filename));
    files[filename] = digest(content);
    records.push({ key: 'file', value: { path: filename, encoding: 'base64', content: content.toString('base64') } });
  }
  const manifest = { schema: 1, workspace: digest(workspaceId), apiOrigin, credential: digest(runtimeToken(workspaceId)), source: digest(JSON.stringify(files)), files };
  records.push({ key: 'file', value: { path: MANIFEST, encoding: 'base64', content: Buffer.from(JSON.stringify(manifest)).toString('base64') } });
  return { manifest, records };
}

async function inspect(repo: string): Promise<SpaceMetadata | undefined> {
  const response = await hubRequest(`spaces/${repo}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Cannot inspect workspace runtime (HTTP ${response.status}).`);
  const metadata = await response.json() as SpaceMetadata;
  if (!metadata.private) throw new Error('Refusing to reuse a public workspace runtime Space.');
  if (metadata.sdk !== 'docker') throw new Error('Refusing to reuse a Space that is not a Docker workspace runtime.');
  // A fixed revision lets the commit reject concurrent changes instead of
  // overwriting source files created after this inspection.
  if (!metadata.sha || !/^[a-f0-9]{40,64}$/i.test(metadata.sha) || !Array.isArray(metadata.siblings)) {
    throw new Error('Cannot verify workspace runtime source revision. Please retry.');
  }
  return metadata;
}

async function readSource(repo: string, revision: string, filename: string): Promise<string> {
  const response = await hfRequest(`https://huggingface.co/spaces/${repo}/resolve/${revision}/${encodeURIComponent(filename)}`);
  if (!response.ok) throw new Error(`Cannot verify workspace runtime source (HTTP ${response.status}).`);
  return response.text();
}

export async function provisionRuntime(workspaceId: string): Promise<void> {
  if (process.env.RUNTIME_PROVIDER !== 'huggingface') {
    throw new Error('Start the dedicated workspace runtime and connect it to this API, or configure RUNTIME_PROVIDER=huggingface.');
  }
  const pending = provisioning.get(workspaceId);
  if (pending) return pending;
  const task = provision(workspaceId).finally(() => provisioning.delete(workspaceId));
  provisioning.set(workspaceId, task);
  return task;
}

async function provision(workspaceId: string): Promise<void> {
  const repo = runtimeRepo(workspaceId);
  const apiUrl = process.env.RUNTIME_API_URL || '';
  let parsed: URL;
  try { parsed = new URL(apiUrl); }
  catch { throw new Error('RUNTIME_API_URL must be the public HTTPS origin of the API.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('RUNTIME_API_URL must be the public HTTPS origin of the API.');
  }
  // Verify the local source bundle before creating an incomplete remote repo.
  const bundle = await sourceBundle(workspaceId, parsed.origin);
  let metadata = await inspect(repo);
  let createdHere = false;
  if (!metadata) {
    const created = await hubRequest('repos/create', {
      method: 'POST', body: JSON.stringify({ type: 'space', name: repo.split('/')[1], organization: repo.split('/')[0], sdk: 'docker', private: true, hardware: 'cpu-basic' }),
    });
    if (created.status === 402) throw new Error('Hugging Face requires PRO to create a Docker workspace runtime. Configure a container host or enable PRO; no subscription has been purchased.');
    // Another API instance may win creation; inspect its repo before resuming.
    if (!created.ok && created.status !== 409) throw new Error(`Runtime provisioning failed (Hugging Face HTTP ${created.status}).`);
    createdHere = created.ok;
    metadata = await inspect(repo);
    if (!metadata) throw new Error('The workspace runtime repository is not ready. Please retry.');
  }
  const filenames = metadata.siblings!.map(file => file.rfilename);
  if (filenames.includes(MANIFEST)) {
    let manifest: SourceManifest;
    try { manifest = JSON.parse(await readSource(repo, metadata.sha!, MANIFEST)) as SourceManifest; }
    catch { throw new Error('Cannot verify the existing workspace runtime manifest. No source files were changed.'); }
    const expected = bundle.manifest;
    if (!manifest || manifest.schema !== 1 || manifest.workspace !== expected.workspace || manifest.apiOrigin !== expected.apiOrigin ||
        manifest.credential !== expected.credential || manifest.source !== expected.source ||
        JSON.stringify(manifest.files) !== JSON.stringify(expected.files) || SOURCE_FILES.some(filename => !filenames.includes(filename))) {
      throw new Error('Workspace runtime source or configuration differs. Back up its files before an explicit rebuild; no source files were changed.');
    }
    const actual = await Promise.all(SOURCE_FILES.map(async filename => digest(await readSource(repo, metadata!.sha!, filename))));
    if (actual.some((hash, index) => hash !== expected.files[SOURCE_FILES[index]])) {
      throw new Error('Workspace runtime source differs from its manifest. No source files were changed.');
    }
    // A source commit rebuilds the container and may reset its ephemeral home.
    // Completed runtimes are reused, never silently updated on reconnect.
    if (metadata.runtime?.stage === 'SLEEPING' || metadata.runtime?.stage === 'PAUSED') {
      await checked(`spaces/${repo}/restart`, { method: 'POST' });
    }
    return;
  }
  if (['RUNNING', 'RUNNING_BUILDING', 'SLEEPING', 'PAUSED'].includes(metadata.runtime?.stage || '')) {
    throw new Error('The existing runtime has no provisioning manifest. Back up its files before an explicit rebuild.');
  }
  // Resume only empty repositories or previously uploaded, byte-identical
  // runtime source. Unknown files belong to the user and are never replaced.
  for (const filename of filenames) {
    if (filename === '.gitattributes') continue;
    if (createdHere && filename === 'README.md') continue; // Hub-created card in our just-created repo.
    if (!SOURCE_FILES.includes(filename) || digest(await readSource(repo, metadata.sha!, filename)) !== bundle.manifest.files[filename]) {
      throw new Error('The incomplete runtime contains unrecognized files. No source files were changed.');
    }
  }
  const variables = { SYNCSCRIPT_API_URL: parsed.origin, SYNCSCRIPT_WORKSPACE_ID: workspaceId };
  for (const [key, value] of Object.entries(variables)) {
    await checked(`spaces/${repo}/variables`, { method: 'POST', body: JSON.stringify({ key, value }) });
  }
  await checked(`spaces/${repo}/secrets`, { method: 'POST', body: JSON.stringify({ key: 'SYNCSCRIPT_RUNTIME_TOKEN', value: runtimeToken(workspaceId) }) });
  const records = [{ key: 'header', value: { summary: 'Initialize isolated SyncScript workspace runtime', parentCommit: metadata.sha } }, ...bundle.records];
  // Source and completion marker are one atomic commit, after settings succeed.
  await checked(`spaces/${repo}/commit/main`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: records.map(record => JSON.stringify(record)).join('\n') });
}
