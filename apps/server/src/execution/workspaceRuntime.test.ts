import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectedRuntime, ensureRuntime, initializeRuntimeGateway, workspaceFiles } from './workspaceRuntime.js';
import { provisionRuntime, runtimeToken } from './runtimeProvisioner.js';

vi.mock('./runtimeProvisioner.js', async importOriginal => ({
  ...await importOriginal<typeof import('./runtimeProvisioner.js')>(),
  provisionRuntime: vi.fn(),
}));

const file = (id: string, name: string, parentId: string | null = null, type = 'FILE', content: string | null = 'code') => ({ id, name, parentId, type, content });

describe('workspace file boundaries', () => {
  it('serializes nested files and empty folders without losing empty contents', () => {
    expect(workspaceFiles([file('code', 'main.py', 'src', 'FILE', ''), file('src', 'src', null, 'FOLDER', null)]))
      .toEqual([{ path: 'src/main.py', type: 'FILE', content: '' }, { path: 'src', type: 'FOLDER' }]);
  });

  it.each(['', '.', '..', '../secret', '/absolute', 'a/b', 'a\\b', 'C:drive', 'line\nname', 'nul\u0000name'])('rejects invalid filename %j', name => {
    expect(() => workspaceFiles([file('file', name)])).toThrow('filename');
  });

  it('rejects orphaned, cyclic and non-folder parents', () => {
    expect(() => workspaceFiles([file('child', 'code', 'missing')])).toThrow('parent');
    expect(() => workspaceFiles([file('child', 'code', 'parent'), file('parent', 'file')])).toThrow('parent');
    expect(() => workspaceFiles([file('one', 'one', 'two', 'FOLDER'), file('two', 'two', 'one', 'FOLDER')])).toThrow('hierarchy');
  });

  it('rejects duplicate IDs, duplicate paths, and unknown item types', () => {
    expect(() => workspaceFiles([file('same', 'one'), file('same', 'two')])).toThrow('identifier');
    expect(() => workspaceFiles([file('one', 'same.py'), file('two', 'same.py')])).toThrow('path');
    expect(() => workspaceFiles([file('one', 'link', null, 'SYMLINK')])).toThrow('type');
  });

  it('enforces the runtime path-length and depth limits even with cached parents', () => {
    expect(() => workspaceFiles([file('file', 'x'.repeat(1025))])).toThrow('limit');
    const folders = Array.from({ length: 64 }, (_, index) => file(`folder-${index}`, 'dir', index ? `folder-${index - 1}` : null, 'FOLDER', null));
    expect(workspaceFiles(folders)).toHaveLength(64);
    expect(() => workspaceFiles([...folders, file('file', 'main.py', 'folder-63')])).toThrow('limit');
    expect(() => workspaceFiles([file('file', 'main.py', 'folder-63'), ...folders])).toThrow('hierarchy');
  });
});

let http: HttpServer;
let io: Server;
let endpoint: string;
const clients: ClientSocket[] = [];

async function runtimeClient(workspaceId: unknown, token: unknown): Promise<ClientSocket> {
  const socket = connect(`${endpoint}/runtime`, { auth: { workspaceId, token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting test runtime')), 3000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });
}

describe('workspace runtime gateway', () => {
  beforeEach(async () => {
    vi.mocked(provisionRuntime).mockReset();
    vi.mocked(provisionRuntime).mockResolvedValue(undefined);
    vi.stubEnv('RUNTIME_SIGNING_SECRET', 'runtime-test-signing-secret-0123456789abcdef');
    http = createServer();
    io = new Server(http);
    initializeRuntimeGateway(io);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    clients.splice(0).forEach(client => client.disconnect());
    await new Promise<void>(resolve => io.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it('accepts a scoped runtime token and never registers it under another workspace', async () => {
    await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    expect(connectedRuntime('workspace-a')?.connected).toBe(true);
    await expect(runtimeClient('workspace-b', runtimeToken('workspace-a'))).rejects.toThrow('Invalid runtime credentials');
    expect(connectedRuntime('workspace-b')).toBeUndefined();
  });

  it.each([
    ['../workspace', 'a'.repeat(64)], ['workspace', 'short'], ['workspace', 'g'.repeat(64)],
    ['workspace', 'a'.repeat(65)], [null, 'a'.repeat(64)], ['workspace', { token: 'a'.repeat(64) }],
  ])('rejects malformed workspace/token credentials (%j)', async (workspaceId, token) => {
    await expect(runtimeClient(workspaceId, token)).rejects.toThrow('Invalid runtime credentials');
  });

  it('rejects duplicate live connections without replacing the existing runtime', async () => {
    const first = await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    const registered = connectedRuntime('workspace-a');
    const duplicate = await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    await vi.waitFor(() => expect(duplicate.connected).toBe(false));
    expect(first.connected).toBe(true);
    expect(connectedRuntime('workspace-a')).toBe(registered);
  });

  it('routes requests and output only through the authenticated workspace connection', async () => {
    const a = await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    const b = await runtimeClient('workspace-b', runtimeToken('workspace-b'));
    const otherRequests = vi.fn();
    const outputA = vi.fn();
    const outputB = vi.fn();
    b.on('runtime:request', otherRequests);
    a.on('runtime:request', (request, ack) => ack({ ok: true, result: request.action }));
    connectedRuntime('workspace-a')!.on('terminal-output', outputA);
    connectedRuntime('workspace-b')!.on('terminal-output', outputB);
    expect(await connectedRuntime('workspace-a')!.request('terminal-create', { terminalId: 'terminal-a' })).toBe('terminal-create');
    a.emit('runtime:terminal-output', { workspaceId: 'workspace-b', terminalId: 'terminal-a', data: 'scoped output' });
    await vi.waitFor(() => expect(outputA).toHaveBeenCalledOnce());
    expect(outputB).not.toHaveBeenCalled();
    expect(otherRequests).not.toHaveBeenCalled();
  });

  it('propagates failed runtime requests and removes disconnected runtimes', async () => {
    const client = await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    const runtime = connectedRuntime('workspace-a')!;
    client.on('runtime:request', (_request, ack) => ack({ ok: false, error: 'task failed' }));
    await expect(runtime.request('sync-files', {})).rejects.toThrow('task failed');
    client.disconnect();
    await vi.waitFor(() => expect(connectedRuntime('workspace-a')).toBeUndefined());
    await expect(runtime.request('sync-files', {})).rejects.toThrow('disconnected');
  });

  it('returns an already connected runtime without provisioning', async () => {
    await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    expect(await ensureRuntime('workspace-a')).toBe(connectedRuntime('workspace-a'));
    expect(provisionRuntime).not.toHaveBeenCalled();
  });

  it('coalesces startup, receives a connection after provisioning, and retries failures', async () => {
    vi.mocked(provisionRuntime).mockRejectedValueOnce(new Error('host unavailable'));
    await expect(ensureRuntime('workspace-a')).rejects.toThrow('host unavailable');
    let release!: () => void;
    vi.mocked(provisionRuntime).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = ensureRuntime('workspace-a');
    const second = ensureRuntime('workspace-a');
    release();
    await runtimeClient('workspace-a', runtimeToken('workspace-a'));
    expect(await first).toBe(await second);
    expect(provisionRuntime).toHaveBeenCalledTimes(2);
  });
});
