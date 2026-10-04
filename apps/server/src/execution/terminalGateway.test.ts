import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTerminalGateway, terminalGeometry } from './terminalGateway.js';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), ensureRuntime: vi.fn(), files: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ default: { fileSystemItem: { findMany: mocks.files } } }));
vi.mock('../lib/socketAuthz.js', () => ({ WRITE_ROLES: ['OWNER', 'EDITOR'], requireWorkspaceRole: mocks.authorize }));
vi.mock('./workspaceRuntime.js', () => ({
  ensureRuntime: mocks.ensureRuntime,
  workspaceFiles: (items: Array<{ name: string; type: string; content: string }>) => items.map(item => ({ path: item.name, type: item.type, content: item.content })),
}));

class Client {
  connected = true;
  data = { user: { id: 'user' } };
  emit = vi.fn();
  listeners = new Map<string, Array<(payload?: unknown) => unknown>>();
  on(event: string, listener: (payload?: unknown) => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), listener]);
  }
  async receive(event: string, payload?: unknown) {
    await Promise.all((this.listeners.get(event) || []).map(listener => listener(payload)));
  }
}
class Runtime extends EventEmitter { request = vi.fn(async (_action: string, _payload: Record<string, unknown>) => ({})); }
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('workspace terminal gateway', () => {
  let runtime: Runtime;
  let clients: Client[];
  const files = [{ id: 'file', name: 'main.py', parentId: null, type: 'FILE', content: 'print(42)' }];
  const client = () => {
    const socket = new Client();
    registerTerminalGateway(socket as unknown as Socket);
    clients.push(socket);
    return socket;
  };
  const requests = (action: string) => runtime.request.mock.calls.filter(([name]) => name === action);
  const terminalId = () => requests('terminal:spawn')[0][1].terminalId as string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    clients = [];
    runtime = new Runtime();
    mocks.authorize.mockResolvedValue('OWNER');
    mocks.ensureRuntime.mockResolvedValue(runtime);
    mocks.files.mockResolvedValue(files);
  });
  afterEach(async () => {
    for (const socket of clients) { socket.connected = false; await socket.receive('disconnect'); }
    vi.useRealTimers();
  });

  it('forwards initial output before readiness, keeps repeated spawn idempotent, and resizes the PTY', async () => {
    runtime.request.mockImplementation(async (action, payload) => {
      if (action === 'terminal:spawn') runtime.emit('terminal-output', { terminalId: payload.terminalId, data: '$ ' });
      return {};
    });
    const socket = client();
    await socket.receive('terminal:spawn', { workspaceId: 'workspace', cols: 120, rows: 35 });
    const output = socket.emit.mock.calls.findIndex(([event, payload]) => event === 'terminal:output' && payload.data === '$ ');
    const ready = socket.emit.mock.calls.findIndex(([event]) => event === 'terminal:ready');
    expect(output).toBeGreaterThan(-1);
    expect(output).toBeLessThan(ready);
    expect(requests('sync')[0][1]).toEqual({ files: [{ path: 'main.py', type: 'FILE', content: 'print(42)' }], preserveExisting: true });
    expect(requests('terminal:spawn')[0][1]).toMatchObject({ cols: 120, rows: 35 });
    await socket.receive('terminal:spawn', { workspaceId: 'workspace', cols: 120, rows: 35 });
    expect(requests('terminal:spawn')).toHaveLength(1);
    await socket.receive('terminal:resize', { workspaceId: 'workspace', cols: 140, rows: 42 });
    await flush();
    expect(requests('terminal:resize')[0][1]).toEqual({ terminalId: terminalId(), cols: 140, rows: 42 });
  });

  it.each(['authorization', 'provisioning', 'files', 'sync', 'reauthorization', 'acknowledgement'])('cannot resurrect a terminal closed during %s', async stage => {
    const pending = deferred<unknown>();
    if (stage === 'authorization') mocks.authorize.mockReturnValueOnce(pending.promise);
    if (stage === 'provisioning') mocks.ensureRuntime.mockReturnValueOnce(pending.promise);
    if (stage === 'files') mocks.files.mockReturnValueOnce(pending.promise);
    if (stage === 'reauthorization') mocks.authorize.mockResolvedValueOnce('OWNER').mockReturnValueOnce(pending.promise);
    if (stage === 'sync' || stage === 'acknowledgement') {
      runtime.request.mockImplementation(async action => action === (stage === 'sync' ? 'sync' : 'terminal:spawn') ? pending.promise as Promise<object> : {});
    }
    const socket = client();
    const opening = socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    await flush();
    await socket.receive('terminal:close', { workspaceId: 'workspace' });
    pending.resolve(stage === 'provisioning' ? runtime : stage === 'files' ? files : {});
    await opening;
    expect(socket.emit).not.toHaveBeenCalledWith('terminal:ready', expect.anything());
    expect(requests('terminal:spawn')).toHaveLength(stage === 'acknowledgement' ? 1 : 0);
    expect(runtime.listenerCount('terminal-output')).toBe(0);
    expect(runtime.listenerCount('terminal-exit')).toBe(0);
    expect(runtime.listenerCount('disconnected')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a late rejected spawn after disconnect and accepts a new shell on reconnect', async () => {
    const pending = deferred<object>();
    runtime.request.mockImplementation(async action => action === 'terminal:spawn' ? pending.promise : {});
    const socket = client();
    const opening = socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    await flush();
    socket.connected = false;
    await socket.receive('disconnect');
    pending.reject(new Error('Spawn acknowledgement lost'));
    await opening;
    expect(runtime.listenerCount('terminal-output')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    socket.connected = true;
    runtime.request.mockResolvedValue({});
    await socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    expect(socket.emit).toHaveBeenCalledWith('terminal:ready', expect.objectContaining({ workspaceId: 'workspace' }));
  });

  it('isolates two clients, rejects mismatched workspace input, and preserves ordered raw bytes', async () => {
    const first = client();
    const second = client();
    await first.receive('terminal:spawn', { workspaceId: 'workspace' });
    await second.receive('terminal:spawn', { workspaceId: 'workspace' });
    const firstId = requests('terminal:spawn')[0][1].terminalId;
    const secondId = requests('terminal:spawn')[1][1].terminalId;
    expect(firstId).not.toBe(secondId);
    first.emit.mockClear();
    second.emit.mockClear();
    runtime.emit('terminal-output', { terminalId: firstId, data: 'private prompt' });
    expect(first.emit).toHaveBeenCalledWith('terminal:output', { workspaceId: 'workspace', data: 'private prompt' });
    expect(second.emit).not.toHaveBeenCalled();
    await first.receive('terminal:data', { workspaceId: 'other', data: 'forbidden\r' });
    await first.receive('terminal:close', { workspaceId: 'other' });
    const auth = deferred<string>();
    mocks.authorize.mockReturnValueOnce(auth.promise);
    await first.receive('terminal:data', { workspaceId: 'workspace', data: 'one\r' });
    await first.receive('terminal:data', { workspaceId: 'workspace', data: '\x03' });
    await flush();
    expect(requests('terminal:data')).toHaveLength(0);
    auth.resolve('OWNER');
    await flush();
    expect(requests('terminal:data').map(([, payload]) => payload)).toEqual([
      { terminalId: firstId, data: 'one\r' }, { terminalId: firstId, data: '\x03' },
    ]);
    runtime.emit('terminal-exit', { terminalId: firstId, exitCode: 0 });
    expect(first.emit).toHaveBeenCalledWith('terminal:exit', { workspaceId: 'workspace', exitCode: 0, signal: undefined });
    expect(runtime.listenerCount('terminal-output')).toBe(1);
  });

  it('waits for readiness and drops queued input when the shell is closed during authorization', async () => {
    const ack = deferred<object>();
    runtime.request.mockImplementation(async action => action === 'terminal:spawn' ? ack.promise : {});
    const socket = client();
    const opening = socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    await flush();
    await socket.receive('terminal:data', { workspaceId: 'workspace', data: 'too early\r' });
    expect(requests('terminal:data')).toHaveLength(0);
    ack.resolve({});
    await opening;
    const auth = deferred<string>();
    mocks.authorize.mockReturnValueOnce(auth.promise);
    await socket.receive('terminal:data', { workspaceId: 'workspace', data: 'must not execute\r' });
    await socket.receive('terminal:close', { workspaceId: 'workspace' });
    auth.resolve('OWNER');
    await flush();
    expect(requests('terminal:data')).toHaveLength(0);
  });

  it.each(['input', 'reopen', 'idle'])('closes a revoked terminal when checked by %s', async action => {
    const socket = client();
    await socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    mocks.authorize.mockRejectedValue(new Error('Workspace access revoked'));
    if (action === 'input') await socket.receive('terminal:data', { workspaceId: 'workspace', data: 'ls\r' });
    if (action === 'reopen') await socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    if (action === 'idle') await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(socket.emit).toHaveBeenCalledWith('terminal:error', { workspaceId: 'workspace', message: 'Workspace access revoked' });
    expect(requests('terminal:data')).toHaveLength(0);
    expect(requests('terminal:close')).toHaveLength(1);
    expect(runtime.listenerCount('terminal-output')).toBe(0);
  });

  it('handles runtime loss and malformed payloads without leaving a live terminal', async () => {
    const socket = client();
    for (const event of ['terminal:spawn', 'terminal:data', 'terminal:resize', 'terminal:close']) await socket.receive(event, null);
    await socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    await socket.receive('terminal:data', { workspaceId: 'workspace', data: 'x'.repeat(65 * 1024) });
    expect(requests('terminal:data')).toHaveLength(0);
    runtime.emit('disconnected');
    expect(socket.emit).toHaveBeenCalledWith('terminal:error', expect.objectContaining({ message: expect.stringContaining('disconnected') }));
    expect(vi.getTimerCount()).toBe(0);
    expect(terminalGeometry({ toString: 'invalid' }, Infinity)).toEqual({ cols: 80, rows: 24 });
    expect(terminalGeometry(999, -20)).toEqual({ cols: 500, rows: 5 });
  });

  it('closes a terminal when stalled authorization lets queued input exceed 256 KiB', async () => {
    const socket = client();
    await socket.receive('terminal:spawn', { workspaceId: 'workspace' });
    const auth = deferred<string>();
    mocks.authorize.mockReturnValueOnce(auth.promise);
    for (let index = 0; index < 5; index++) {
      await socket.receive('terminal:data', { workspaceId: 'workspace', data: 'x'.repeat(64 * 1024) });
    }
    expect(requests('terminal:close')).toHaveLength(1);
    auth.resolve('OWNER');
    await flush();
    expect(requests('terminal:data')).toHaveLength(0);
    expect(socket.emit).toHaveBeenCalledWith('terminal:error', expect.objectContaining({ message: expect.stringContaining('input') }));
  });
});
