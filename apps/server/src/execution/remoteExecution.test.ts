import { EventEmitter } from 'node:events';
import type { Server, Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRemoteExecutionInput, runRemoteExecution } from './remoteExecution.js';

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
  constructor(readonly id: string) {}
  on(event: string, listener: (payload?: unknown) => unknown) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); }
  async receive(event: string, payload?: unknown) { await Promise.all((this.listeners.get(event) || []).map(listener => listener(payload))); }
}
class Runtime extends EventEmitter { request = vi.fn(async (_action: string, _payload: Record<string, unknown>) => ({})); }
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

describe('remote workspace execution', () => {
  let runtime: Runtime;
  let clients: Client[];
  let io: { to: ReturnType<typeof vi.fn> };
  let messages: Array<{ room: string; event: string; payload: unknown }>;
  const files = [{ id: 'file', name: 'main.py', parentId: null, type: 'FILE', content: 'print(42)' }];
  const client = (id = 'socket') => {
    const socket = new Client(id);
    registerRemoteExecutionInput(io as unknown as Server, socket as unknown as Socket);
    clients.push(socket);
    return socket;
  };
  const start = (socket: Client, sessionId = 'run', overrides = {}) => runRemoteExecution(io as unknown as Server, socket as unknown as Socket, {
    sessionId, workspaceId: 'workspace', fileId: 'file', language: 'python', code: 'print(42)', ...overrides,
  });
  const requests = (action: string) => runtime.request.mock.calls.filter(([name]) => name === action);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    clients = [];
    messages = [];
    io = { to: vi.fn((room: string) => ({ emit: (event: string, payload: unknown) => { messages.push({ room, event, payload }); } })) };
    runtime = new Runtime();
    mocks.authorize.mockResolvedValue('OWNER');
    mocks.ensureRuntime.mockResolvedValue(runtime);
    mocks.files.mockResolvedValue(files);
  });
  afterEach(async () => {
    for (const socket of clients) { socket.connected = false; await socket.receive('disconnect'); }
    await flush();
    vi.useRealTimers();
  });

  it('authorizes before provisioning and forwards immediate output and exit with the actual session ID', async () => {
    runtime.request.mockImplementation(async (action, payload) => {
      if (action === 'execution:start') {
        runtime.emit('execution-output', { executionId: payload.executionId, channel: 'stdout', data: '42\n' });
        runtime.emit('execution-exit', { executionId: payload.executionId, exitCode: 0 });
      }
      return {};
    });
    await expect(start(client())).resolves.toBe(0);
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensureRuntime.mock.invocationCallOrder[0]);
    expect(requests('execution:start')[0][1]).toEqual({ executionId: 'run', language: 'python', code: 'print(42)', path: 'main.py' });
    expect(messages).toContainEqual({ room: 'exec:run', event: 'execution:stdout', payload: { sessionId: 'run', data: '42\n', timestamp: expect.any(Number) } });
    expect(runtime.listenerCount('execution-output')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['authorization', 'provisioning', 'files', 'sync', 'reauthorization', 'acknowledgement'])('cancels pending work during %s without resurrecting a process', async stage => {
    const pending = deferred<unknown>();
    if (stage === 'authorization') mocks.authorize.mockReturnValueOnce(pending.promise);
    if (stage === 'provisioning') mocks.ensureRuntime.mockReturnValueOnce(pending.promise);
    if (stage === 'files') mocks.files.mockReturnValueOnce(pending.promise);
    if (stage === 'reauthorization') mocks.authorize.mockResolvedValueOnce('OWNER').mockReturnValueOnce(pending.promise);
    if (stage === 'sync' || stage === 'acknowledgement') {
      runtime.request.mockImplementation(async action => action === (stage === 'sync' ? 'sync' : 'execution:start') ? pending.promise as Promise<object> : {});
    }
    const socket = client();
    const running = start(socket);
    await flush();
    await socket.receive('execution:cancel', { sessionId: 'run' });
    await expect(running).resolves.toBe(-1);
    pending.resolve(stage === 'provisioning' ? runtime : stage === 'files' ? files : {});
    await flush();
    expect(requests('execution:start')).toHaveLength(stage === 'acknowledgement' ? 1 : 0);
    if (stage === 'acknowledgement') expect(requests('execution:cancel')).toHaveLength(2);
    expect(runtime.listenerCount('execution-output')).toBe(0);
    expect(runtime.listenerCount('execution-exit')).toBe(0);
    expect(runtime.listenerCount('disconnected')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a disconnected client while runtime provisioning is pending', async () => {
    const pending = deferred<Runtime>();
    mocks.ensureRuntime.mockReturnValueOnce(pending.promise);
    const socket = client();
    const running = start(socket);
    await flush();
    socket.connected = false;
    await socket.receive('disconnect');
    await expect(running).resolves.toBe(-1);
    pending.resolve(runtime);
    await flush();
    expect(runtime.request).not.toHaveBeenCalled();
  });

  it('rejects failed start acknowledgements and cleans up instead of resolving a generic exit first', async () => {
    runtime.request.mockImplementation(async action => {
      if (action === 'execution:start') throw new Error('Compiler process could not start');
      return {};
    });
    await expect(start(client())).rejects.toThrow('Compiler process could not start');
    expect(requests('execution:cancel')).toHaveLength(1);
    expect(runtime.listenerCount('execution-output')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps two clients separate and preserves stdin order through asynchronous authorization', async () => {
    const first = client('first');
    const second = client('second');
    const one = start(first, 'one');
    const two = start(second, 'two');
    await flush();
    runtime.emit('execution-output', { executionId: 'one', channel: 'stdout', data: 'first output' });
    runtime.emit('execution-output', { executionId: 'two', channel: 'stderr', data: 'second output' });
    expect(messages.map(message => [message.room, message.event])).toEqual([['exec:one', 'execution:stdout'], ['exec:two', 'execution:stderr']]);
    await second.receive('execution:stdin', { sessionId: 'one', data: 'forbidden' });
    await second.receive('execution:cancel', { sessionId: 'one' });
    expect(requests('execution:stdin')).toHaveLength(0);
    expect(requests('execution:cancel')).toHaveLength(0);
    const auth = deferred<string>();
    mocks.authorize.mockReturnValueOnce(auth.promise);
    await first.receive('execution:stdin', { sessionId: 'one', data: 'line one\n' });
    await first.receive('execution:stdin', { sessionId: 'one', data: 'line two\n' });
    await flush();
    expect(requests('execution:stdin')).toHaveLength(0);
    auth.resolve('OWNER');
    await flush();
    expect(requests('execution:stdin').map(([, payload]) => payload)).toEqual([
      { executionId: 'one', data: 'line one\n' }, { executionId: 'one', data: 'line two\n' },
    ]);
    runtime.emit('execution-exit', { executionId: 'one', exitCode: 0 });
    await expect(one).resolves.toBe(0);
    expect(runtime.listenerCount('execution-output')).toBe(1);
    await second.receive('execution:cancel', { sessionId: 'two' });
    await expect(two).resolves.toBe(-1);
  });

  it('drops stdin waiting on authorization when that execution exits', async () => {
    const socket = client();
    const running = start(socket);
    await flush();
    const auth = deferred<string>();
    mocks.authorize.mockReturnValueOnce(auth.promise);
    await socket.receive('execution:stdin', { sessionId: 'run', data: 'stale input\n' });
    runtime.emit('execution-exit', { executionId: 'run', exitCode: 0 });
    auth.resolve('OWNER');
    await flush();
    await expect(running).resolves.toBe(0);
    expect(requests('execution:stdin')).toHaveLength(0);
  });

  it('rechecks access after slow synchronization and refuses files outside the workspace', async () => {
    const sync = deferred<object>();
    runtime.request.mockImplementation(async action => action === 'sync' ? sync.promise : {});
    const socket = client();
    const running = start(socket);
    const rejected = expect(running).rejects.toThrow('Access revoked');
    await flush();
    mocks.authorize.mockRejectedValueOnce(new Error('Access revoked'));
    sync.resolve({});
    await rejected;
    expect(requests('execution:start')).toHaveLength(0);
    await expect(start(socket, 'missing-file', { fileId: 'another-workspaces-file' })).rejects.toThrow('no longer exists in this workspace');
    expect(requests('execution:start')).toHaveLength(0);
  });

  it.each(['stdin', 'idle'])('stops a running program when access revocation is discovered by %s', async action => {
    const socket = client();
    const running = start(socket);
    await flush();
    mocks.authorize.mockRejectedValue(new Error('Access revoked'));
    if (action === 'stdin') await socket.receive('execution:stdin', { sessionId: 'run', data: 'not allowed\n' });
    if (action === 'idle') await vi.advanceTimersByTimeAsync(30_000);
    await expect(running).resolves.toBe(1);
    expect(requests('execution:stdin')).toHaveLength(0);
    expect(requests('execution:cancel')).toHaveLength(1);
    expect(runtime.listenerCount('execution-output')).toBe(0);
  });

  it.each(['output', 'runtime', 'timeout'])('bounds execution and cleans up after %s failure', async reason => {
    const running = start(client());
    await flush();
    if (reason === 'output') {
      runtime.emit('execution-output', { executionId: 'other', channel: 'stdout', data: 'x'.repeat(513 * 1024) });
      expect(requests('execution:cancel')).toHaveLength(0);
      runtime.emit('execution-output', { executionId: 'run', channel: 'stdout', data: 'x'.repeat(513 * 1024) });
    }
    if (reason === 'runtime') runtime.emit('disconnected');
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(90_000);
    await expect(running).resolves.toBe(1);
    expect(requests('execution:cancel')).toHaveLength(1);
    expect(runtime.listenerCount('execution-output')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects duplicate sessions and malformed/oversized input without disturbing the active run', async () => {
    const socket = client();
    const running = start(socket);
    await flush();
    await expect(start(socket)).rejects.toThrow('already active');
    await socket.receive('execution:stdin', null);
    await socket.receive('execution:cancel', null);
    await socket.receive('execution:stdin', { sessionId: 'run', data: 'x'.repeat(8193) });
    expect(requests('execution:stdin')).toHaveLength(0);
    runtime.emit('execution-exit', { executionId: 'run', exitCode: 0 });
    await expect(running).resolves.toBe(0);
  });
});
