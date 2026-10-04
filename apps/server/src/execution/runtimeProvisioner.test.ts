import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config/index.js';
import { provisionRuntime, runtimeRepo, runtimeToken } from './runtimeProvisioner.js';

vi.mock('fs/promises', () => ({ default: { readFile: vi.fn() } }));

type Call = { url: string; init: RequestInit; body?: Record<string, unknown> };
let calls: Call[];
let files: Map<string, string>;
let exists: boolean;
let privateSpace: boolean;
let stage: string;
let revision: string;
let failNext: string | undefined;
let loseCommitResponse: boolean;

function json(body: unknown, status = 200): Response { return Response.json(body, { status }); }

beforeEach(() => {
  vi.stubEnv('RUNTIME_PROVIDER', 'huggingface');
  vi.stubEnv('HF_RUNTIME_OWNER', 'runtime-owner');
  vi.stubEnv('HF_TOKEN', 'hf-private-control-plane-test-key');
  vi.stubEnv('RUNTIME_API_URL', 'https://api.example.test');
  vi.stubEnv('RUNTIME_SIGNING_SECRET', 'runtime-signing-secret-0123456789abcdef');
  calls = [];
  files = new Map([['.gitattributes', 'provider metadata']]);
  exists = false;
  privateSpace = true;
  stage = 'NO_APP_FILE';
  revision = 'a'.repeat(40);
  failNext = undefined;
  loseCommitResponse = false;
  vi.mocked(fs.readFile).mockReset();
  vi.mocked(fs.readFile).mockImplementation(async filename => Buffer.from(`fixture source: ${path.basename(String(filename))}\n`));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body && (init.headers as Record<string, string>)?.['Content-Type'] !== 'application/x-ndjson'
      ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, init, body });
    if (failNext && url.endsWith(failNext)) { failNext = undefined; return json({ error: 'provider-private-error' }, 503); }
    if (url.endsWith('/api/repos/create')) { exists = true; return json({ url: 'private-repo' }); }
    if (url.includes('/resolve/')) {
      const filename = decodeURIComponent(url.split('/').at(-1)!);
      return files.has(filename) ? new Response(files.get(filename)) : json({}, 404);
    }
    if (url.endsWith('/commit/main')) {
      const records = String(init.body).split('\n').map(line => JSON.parse(line));
      expect(records[0].value.parentCommit).toBe(revision);
      for (const record of records.slice(1)) files.set(record.value.path, Buffer.from(record.value.content, 'base64').toString());
      revision = 'b'.repeat(40);
      stage = 'BUILDING';
      if (loseCommitResponse) { loseCommitResponse = false; throw new Error('Network interrupted after successful commit'); }
      return json({ commitOid: revision });
    }
    if (url.endsWith('/variables') || url.endsWith('/secrets') || url.endsWith('/restart')) return json({ ok: true });
    return exists ? json({ private: privateSpace, sdk: 'docker', sha: revision, siblings: [...files.keys()].map(rfilename => ({ rfilename })), runtime: { stage } }) : json({}, 404);
  }));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('workspace runtime provisioning', () => {
  it('creates one private basic Docker Space and uploads only runtime source plus a completion manifest', async () => {
    await provisionRuntime('workspace-a');
    const create = calls.find(call => call.url.endsWith('/repos/create'))!;
    expect(create.body).toMatchObject({ type: 'space', sdk: 'docker', private: true, hardware: 'cpu-basic', organization: 'runtime-owner' });
    expect([...files.keys()].sort()).toEqual(['.gitattributes', '.syncscript-runtime.json', 'Dockerfile', 'README.md', 'package-lock.json', 'package.json', 'runtime.mjs', 'safe-files.py', 'server.mjs'].sort());
    expect(JSON.parse(files.get('.syncscript-runtime.json')!)).toMatchObject({ schema: 1, apiOrigin: 'https://api.example.test' });
    const commitIndex = calls.findIndex(call => call.url.endsWith('/commit/main'));
    expect(calls.findIndex(call => call.url.endsWith('/secrets'))).toBeLessThan(commitIndex);
  });

  it('separates control-plane/JWT secrets from the workspace-scoped runtime credential', async () => {
    await provisionRuntime('workspace-a');
    const settings = calls.filter(call => call.url.endsWith('/variables') || call.url.endsWith('/secrets'));
    expect(settings.map(call => call.body)).toEqual([
      { key: 'SYNCSCRIPT_API_URL', value: 'https://api.example.test' },
      { key: 'SYNCSCRIPT_WORKSPACE_ID', value: 'workspace-a' },
      { key: 'SYNCSCRIPT_RUNTIME_TOKEN', value: runtimeToken('workspace-a') },
    ]);
    expect(runtimeToken('workspace-a')).not.toBe(runtimeToken('workspace-b'));
    expect(runtimeToken('workspace-a')).not.toBe(config.jwt.accessSecret);
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe('https://huggingface.co');
      expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer hf-private-control-plane-test-key');
      expect(String(call.init.body)).not.toContain('hf-private-control-plane-test-key');
      expect(String(call.init.body)).not.toContain(config.jwt.accessSecret);
    }
  });

  it.each(['/variables', '/secrets', '/commit/main'])('resumes an incomplete initial provision after %s fails', async failingRoute => {
    failNext = failingRoute;
    await expect(provisionRuntime('workspace-retry')).rejects.toThrow('HTTP 503');
    expect(files.has('.syncscript-runtime.json')).toBe(false);
    await provisionRuntime('workspace-retry');
    expect(calls.filter(call => call.url.endsWith('/repos/create'))).toHaveLength(1);
    expect(files.has('.syncscript-runtime.json')).toBe(true);
  });

  it('coalesces simultaneous starts of the same workspace', async () => {
    await Promise.all([provisionRuntime('workspace-a'), provisionRuntime('workspace-a'), provisionRuntime('workspace-a')]);
    expect(calls.filter(call => call.url.endsWith('/repos/create'))).toHaveLength(1);
    expect(calls.filter(call => call.url.endsWith('/commit/main'))).toHaveLength(1);
  });

  it('recognizes a completed commit after its HTTP response was lost without rebuilding again', async () => {
    loseCommitResponse = true;
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('timed out');
    expect(files.has('.syncscript-runtime.json')).toBe(true);
    await provisionRuntime('workspace-a');
    expect(calls.filter(call => call.url.endsWith('/commit/main'))).toHaveLength(1);
  });

  it('resumes a stopped partial repository only when its existing source bytes match', async () => {
    exists = true;
    files.set('server.mjs', 'fixture source: server.mjs\n');
    await provisionRuntime('workspace-a');
    expect(files.has('.syncscript-runtime.json')).toBe(true);
    expect(calls.some(call => call.url.endsWith('/repos/create'))).toBe(false);
  });

  it('reuses completed running runtimes without writing source or settings', async () => {
    await provisionRuntime('workspace-a');
    calls.length = 0;
    stage = 'RUNNING';
    await provisionRuntime('workspace-a');
    expect(calls.every(call => !call.init.method || call.init.method === 'GET')).toBe(true);
  });

  it('wakes a completed sleeping runtime without rebuilding its source', async () => {
    await provisionRuntime('workspace-a');
    calls.length = 0;
    stage = 'SLEEPING';
    await provisionRuntime('workspace-a');
    expect(calls.filter(call => call.init.method === 'POST').map(call => call.url)).toEqual([`https://huggingface.co/api/spaces/${runtimeRepo('workspace-a')}/restart`]);
  });

  it('refuses public Spaces, unknown files, and unmarked running runtimes', async () => {
    exists = true;
    privateSpace = false;
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('public');
    privateSpace = true;
    files.set('user-project.py', 'private user code');
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('unrecognized');
    files.delete('user-project.py');
    stage = 'RUNNING';
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('no provisioning manifest');
    expect(calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('refuses source/configuration drift without rebuilding a workspace', async () => {
    await provisionRuntime('workspace-a');
    calls.length = 0;
    vi.stubEnv('RUNTIME_API_URL', 'https://different.example.test');
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('configuration differs');
    expect(calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it('detects source modifications hidden behind an unchanged completion manifest', async () => {
    await provisionRuntime('workspace-a');
    calls.length = 0;
    files.set('Dockerfile', 'user-modified container image');
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('differs from its manifest');
    expect(calls.some(call => call.init.method === 'POST')).toBe(false);
  });

  it.each(['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?secret=x', 'not a url'])('rejects invalid API origin %s before any remote mutation', async origin => {
    vi.stubEnv('RUNTIME_API_URL', origin);
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('public HTTPS origin');
    expect(calls).toHaveLength(0);
  });

  it('fails before creating a Space if a required local source file is missing', async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('missing runtime source'));
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('missing runtime source');
    expect(calls).toHaveLength(0);
  });

  it('reports host billing rejection without purchasing a plan or proceeding', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/repos/create') ? json({}, 402) : json({}, 404)));
    await expect(provisionRuntime('workspace-a')).rejects.toThrow('no subscription has been purchased');
  });
});
