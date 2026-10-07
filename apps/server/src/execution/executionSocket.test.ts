import type { Server, Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExecutionHandlers } from './executionSocket.js';
import { AuthzError, requireWorkspaceRole } from '../lib/socketAuthz.js';
import prisma from '../lib/prisma.js';
import { runRemoteExecution } from './remoteExecution.js';

vi.mock('../lib/prisma.js', () => ({ default: {
  fileSystemItem: { findUnique: vi.fn() },
  executionSession: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  executionWorker: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
} }));
vi.mock('../lib/socketAuthz.js', () => ({
  AuthzError: class AuthzError extends Error {},
  requireWorkspaceRole: vi.fn(), WRITE_ROLES: ['OWNER', 'EDITOR'], READ_ROLES: ['OWNER', 'EDITOR', 'VIEWER'],
}));
vi.mock('./terminalGateway.js', () => ({ registerTerminalGateway: vi.fn() }));
vi.mock('./remoteExecution.js', () => ({ runRemoteExecution: vi.fn(), registerRemoteExecutionInput: vi.fn() }));

class Client {
  id = 'socket-id';
  connected = true;
  data = { user: { id: 'user', name: 'User', email: 'user@example.test' } };
  emit = vi.fn(); join = vi.fn(); leave = vi.fn();
  handlers = new Map<string, Array<(payload?: unknown) => unknown>>();
  on(event: string, handler: (payload?: unknown) => unknown) { this.handlers.set(event, [...(this.handlers.get(event) || []), handler]); }
  async receive(event: string, payload?: unknown) { await Promise.all((this.handlers.get(event) || []).map(handler => handler(payload))); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('execution socket authorization and session lifecycle', () => {
  let socket: Client;
  let broadcast: ReturnType<typeof vi.fn>;
  const start = { workspaceId: 'workspace', fileId: 'file', language: 'python', code: 'print(42)', target: 'remote' };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('HF_TOKEN', 'private-control-plane-token');
    vi.stubEnv('HF_GPU_TOKEN', '');
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(requireWorkspaceRole).mockResolvedValue('OWNER');
    vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({ workspaceId: 'workspace', type: 'FILE' } as never);
    vi.mocked(prisma.executionSession.create).mockResolvedValue({ id: 'session-1' } as never);
    vi.mocked(prisma.executionSession.update).mockResolvedValue({} as never);
    vi.mocked(prisma.executionWorker.update).mockResolvedValue({} as never);
    vi.mocked(prisma.executionWorker.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue([]);
    vi.mocked(runRemoteExecution).mockResolvedValue(0);
    socket = new Client();
    broadcast = vi.fn();
    const io = { to: (room: string) => ({ emit: (event: string, payload: unknown) => broadcast(room, event, payload) }) };
    registerExecutionHandlers(io as unknown as Server, socket as unknown as Socket);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(['remote', 'gpu-worker'])('rejects a foreign file before creating or executing a %s session', async target => {
    vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({ workspaceId: 'another-workspace', type: 'FILE' } as never);
    await socket.receive('execution:start', { ...start, target });
    expect(socket.emit).toHaveBeenCalledWith('authz_error', expect.objectContaining({ event: 'execution:start' }));
    expect(prisma.executionSession.create).not.toHaveBeenCalled();
    expect(runRemoteExecution).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies viewers and folders before creating an execution session', async () => {
    vi.mocked(requireWorkspaceRole).mockRejectedValueOnce(new AuthzError('Read only'));
    await socket.receive('execution:start', start);
    vi.mocked(prisma.fileSystemItem.findUnique).mockResolvedValue({ workspaceId: 'workspace', type: 'FOLDER' } as never);
    await socket.receive('execution:start', start);
    expect(prisma.executionSession.create).not.toHaveBeenCalled();
  });

  it('announces the DB session after joining and carries that same ID through completion', async () => {
    socket.emit.mockImplementation((event: string) => {
      if (event === 'execution:started') expect(socket.join).toHaveBeenCalledWith('exec:session-1');
    });
    await socket.receive('execution:start', start);
    expect(socket.emit).toHaveBeenCalledWith('execution:started', { sessionId: 'session-1' });
    expect(runRemoteExecution).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ sessionId: 'session-1', fileId: 'file' }));
    expect(broadcast).toHaveBeenCalledWith('exec:session-1', 'execution:completed', expect.objectContaining({ sessionId: 'session-1', exitCode: 0 }));
  });

  it('does not create a duplicate session while the previous start is awaiting authorization', async () => {
    const wait = deferred();
    vi.mocked(requireWorkspaceRole).mockImplementationOnce(async () => { await wait.promise; return 'OWNER'; });
    const first = socket.receive('execution:start', start);
    await socket.receive('execution:start', start);
    expect(requireWorkspaceRole).toHaveBeenCalledOnce();
    wait.resolve();
    await first;
    expect(prisma.executionSession.create).toHaveBeenCalledOnce();
    expect(runRemoteExecution).toHaveBeenCalledOnce();
  });

  it.each(['remote', 'gpu-worker'])('honors cancellation after acknowledgement but before dispatching %s code', async target => {
    const wait = deferred();
    vi.mocked(prisma.executionSession.update).mockReturnValueOnce(wait.promise.then(() => ({})) as never);
    const pending = socket.receive('execution:start', { ...start, target });
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('execution:started', { sessionId: 'session-1' }));
    await socket.receive('execution:cancel', { sessionId: 'session-1' });
    wait.resolve();
    await pending;
    expect(runRemoteExecution).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.executionSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED', exitCode: -1 }) }));
  });

  it('includes the actual session ID in failure events after DB creation', async () => {
    vi.mocked(prisma.executionSession.update).mockRejectedValueOnce(new Error('Temporary failure'));
    await socket.receive('execution:start', start);
    expect(socket.emit).toHaveBeenCalledWith('execution:failed', { sessionId: 'session-1', error: 'Temporary failure' });
    expect(socket.emit).toHaveBeenCalledWith('execution:completed', expect.objectContaining({ sessionId: 'session-1', exitCode: 1 }));
    expect(runRemoteExecution).not.toHaveBeenCalled();
  });

  it.each(['', 'worker-scoped-token'])('never forwards the account HF_TOKEN to a GPU worker (scoped credential %j)', async gpuToken => {
    vi.stubEnv('HF_GPU_TOKEN', gpuToken);
    vi.mocked(prisma.executionWorker.findFirst).mockResolvedValue({ id: 'gpu', url: 'owner/worker' } as never);
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ event_id: 'event-1' }))
      .mockResolvedValueOnce(new Response('event: complete\ndata: [{"stdout":"42\\n","stderr":"","exitCode":0}]\n\n'));
    await socket.receive('execution:start', { ...start, target: 'gpu-worker' });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://owner-worker.hf.space');
      expect(JSON.stringify(options)).not.toContain('private-control-plane-token');
      expect((options?.headers as Record<string, string>).Authorization).toBe(gpuToken ? `Bearer ${gpuToken}` : undefined);
      expect(options?.redirect).toBe('error');
    }
    expect(broadcast).toHaveBeenCalledWith('exec:session-1', 'execution:stdout', expect.objectContaining({ data: '42\n' }));
  });

  it.each([
    [[], 'No enabled GPU worker is configured'],
    [[{ status: 'OFFLINE' }], 'No enabled GPU worker is configured'],
    [[{ status: 'BUSY' }, { status: 'OFFLINE' }], 'GPU workers are busy or cooling down'],
    [[{ status: 'IDLE' }], 'GPU worker availability changed'],
  ])('explains unavailable registry state without claiming an HF quota failure: %j', async (workers, message) => {
    vi.mocked(prisma.executionWorker.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.executionWorker.findMany).mockResolvedValue(workers as never);
    await socket.receive('execution:start', { ...start, target: 'gpu-worker' });
    expect(fetch).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('exec:session-1', 'execution:stderr', expect.objectContaining({ data: expect.stringContaining(message) }));
  });

  it.each(['post', 'stream', 'disconnect'])('aborts GPU %s requests, marks cancellation and keeps an uncertain worker reserved', async phase => {
    vi.mocked(prisma.executionWorker.findFirst).mockResolvedValue({ id: 'gpu', url: 'owner/worker' } as never);
    let requestSignal: AbortSignal | undefined;
    const pendingFetch = vi.fn((_input: unknown, options?: RequestInit) => {
      requestSignal = options?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
      });
    });
    if (phase === 'stream') vi.mocked(fetch).mockResolvedValueOnce(Response.json({ event_id: 'queued-event' }));
    vi.mocked(fetch).mockImplementation(pendingFetch);
    const running = socket.receive('execution:start', { ...start, target: 'gpu-worker' });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const cancelledAt = Date.now();
    if (phase === 'disconnect') { socket.connected = false; await socket.receive('disconnect'); }
    else await socket.receive('execution:cancel', { sessionId: 'session-1' });
    await running;
    expect(requestSignal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(phase === 'stream' ? 2 : 1);
    expect(broadcast).not.toHaveBeenCalledWith(expect.anything(), 'execution:stdout', expect.anything());
    expect(broadcast).toHaveBeenCalledWith('exec:session-1', 'execution:completed', expect.objectContaining({ exitCode: -1 }));
    expect(prisma.executionSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
    const release = vi.mocked(prisma.executionWorker.updateMany).mock.calls.at(-1)![0];
    expect(release.data).toMatchObject({ status: 'BUSY', activeJobs: 1 });
    expect((release.data.lastHeartbeat as Date).getTime()).toBeGreaterThanOrEqual(cancelledAt + 60_000);
    expect(release.where).toMatchObject({ id: 'gpu', status: 'BUSY', lastHeartbeat: expect.any(Date) });
  });

  it('suppresses a late GPU result after cancellation even if a transport ignores abort', async () => {
    vi.mocked(prisma.executionWorker.findFirst).mockResolvedValue({ id: 'gpu', url: 'owner/worker' } as never);
    const wait = deferred();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ event_id: 'queued-event' }));
    vi.mocked(fetch).mockImplementationOnce(async () => { await wait.promise; return new Response('event: complete\ndata: [{"stdout":"late output","exitCode":0}]\n\n'); });
    const running = socket.receive('execution:start', { ...start, target: 'gpu-worker' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await socket.receive('execution:cancel', { sessionId: 'session-1' });
    wait.resolve();
    await running;
    expect(broadcast).not.toHaveBeenCalledWith(expect.anything(), 'execution:stdout', expect.anything());
    expect(broadcast).toHaveBeenCalledWith('exec:session-1', 'execution:completed', expect.objectContaining({ exitCode: -1 }));
  });

  it('does not dispatch GPU code after losing an atomic worker claim', async () => {
    vi.mocked(prisma.executionWorker.findFirst).mockResolvedValue({ id: 'gpu', url: 'owner/worker' } as never);
    vi.mocked(prisma.executionWorker.updateMany).mockResolvedValueOnce({ count: 0 });
    await socket.receive('execution:start', { ...start, target: 'gpu-worker' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['post', 'stream'])('bounds GPU %s response memory and cancels oversized bodies without retrying the job', async phase => {
    vi.mocked(prisma.executionWorker.findFirst).mockResolvedValue({ id: 'gpu', url: 'owner/worker' } as never);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array((phase === 'post' ? 64 * 1024 : 1024 * 1024) + 1)); },
      cancel,
    });
    if (phase === 'stream') vi.mocked(fetch).mockResolvedValueOnce(Response.json({ event_id: 'queued-event' }));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body));
    await socket.receive('execution:start', { ...start, target: 'gpu-worker' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(phase === 'post' ? 1 : 2);
    expect(broadcast).toHaveBeenCalledWith('exec:session-1', 'execution:stderr', expect.objectContaining({ data: expect.stringContaining('output limit') }));
  });

  it.each([null, undefined, [], 42, { sessionId: 42 }])('ignores malformed unwatch payload %j', async payload => {
    await expect(socket.receive('execution:unwatch', payload)).resolves.toBeUndefined();
    expect(socket.leave).not.toHaveBeenCalled();
  });
});
