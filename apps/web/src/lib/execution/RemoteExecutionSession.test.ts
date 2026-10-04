import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteExecutionSession } from './RemoteExecutionSession';

class FakeSocket {
  connected = true;
  id = 'transport-id-is-not-the-execution-id';
  handlers = new Map<string, Set<(...args: any[]) => void>>();
  emit = vi.fn();
  on(event: string, listener: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(listener);
  }
  off(event: string, listener: (...args: any[]) => void) { this.handlers.get(event)?.delete(listener); }
  receive(event: string, payload?: unknown) { for (const handler of [...(this.handlers.get(event) || [])]) handler(payload); }
}

describe('remote execution session', () => {
  let socket: FakeSocket;
  let execution: RemoteExecutionSession;
  const callbacks = { onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() };
  const request = { workspaceId: 'workspace', fileId: 'file', language: 'python', code: 'print(input())', target: 'remote' as const };
  beforeEach(() => {
    vi.clearAllMocks();
    socket = new FakeSocket();
    execution = new RemoteExecutionSession(socket as unknown as Socket, request, callbacks);
  });
  afterEach(() => { execution.dispose(); vi.useRealTimers(); });

  it('uses the acknowledged execution ID for stdin and ignores other sessions', () => {
    execution.start();
    execution.sendInput('too early\n');
    expect(socket.emit.mock.calls).toEqual([['execution:start', request]]);
    socket.receive('execution:stdout', { sessionId: 'other', data: 'private output' });
    socket.receive('execution:started', { sessionId: 'run-1' });
    socket.receive('execution:started', { sessionId: 'other' });
    execution.sendInput('line\n');
    expect(socket.emit).toHaveBeenLastCalledWith('execution:stdin', { sessionId: 'run-1', data: 'line\n' });
    socket.receive('execution:stdout', { sessionId: 'run-1', data: 'own output' });
    socket.receive('execution:stderr', { sessionId: 'other', data: 'other error' });
    socket.receive('execution:completed', { sessionId: 'other', exitCode: 0 });
    expect(callbacks.onStdout.mock.calls).toEqual([['own output']]);
    expect(callbacks.onStderr).not.toHaveBeenCalled();
    expect(callbacks.onExit).not.toHaveBeenCalled();
  });

  it('cancels the actual session once and waits for its completion', () => {
    execution.start();
    socket.receive('execution:started', { sessionId: 'run-1' });
    execution.cancel();
    execution.cancel();
    execution.sendInput('must not run\n');
    expect(socket.emit.mock.calls.filter(([event]) => event === 'execution:cancel')).toEqual([['execution:cancel', { sessionId: 'run-1' }]]);
    expect(socket.emit).not.toHaveBeenCalledWith('execution:stdin', expect.anything());
    expect(callbacks.onExit).not.toHaveBeenCalled();
    socket.receive('execution:completed', { sessionId: 'run-1', exitCode: -1 });
    expect(callbacks.onExit).toHaveBeenCalledWith(-1);
    expect(socket.emit).toHaveBeenLastCalledWith('execution:unwatch', { sessionId: 'run-1' });
    expect([...socket.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it('retains Stop before acknowledgement and cancels as soon as the ID is known', () => {
    execution.start();
    execution.cancel();
    expect(socket.emit).not.toHaveBeenCalledWith('execution:cancel', expect.anything());
    socket.receive('execution:started', { sessionId: 'late-run' });
    expect(socket.emit).toHaveBeenLastCalledWith('execution:cancel', { sessionId: 'late-run' });
    socket.receive('execution:completed', { sessionId: 'late-run', exitCode: 130 });
    expect(callbacks.onExit).toHaveBeenCalledOnce();
  });

  it('handles a failed start without swallowing unrelated execution failures', () => {
    execution.start();
    socket.receive('execution:failed', { sessionId: 'old-run', error: 'old failure' });
    expect(callbacks.onExit).not.toHaveBeenCalled();
    socket.receive('execution:failed', { sessionId: 'unknown', error: 'Cannot create session' });
    expect(callbacks.onStderr).toHaveBeenCalledWith('Cannot create session\r\n');
    expect(callbacks.onExit).toHaveBeenCalledWith(1);
  });

  it('does not replay input or restart a run after reconnecting', () => {
    execution.start();
    socket.receive('execution:started', { sessionId: 'run-1' });
    socket.connected = false;
    socket.receive('disconnect');
    execution.sendInput('offline\n');
    socket.connected = true;
    socket.receive('connect');
    execution.sendInput('stale\n');
    expect(callbacks.onExit).toHaveBeenCalledWith(1);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'execution:start')).toHaveLength(1);
    expect(socket.emit).not.toHaveBeenCalledWith('execution:stdin', expect.anything());
  });

  it('registers listeners before emitting start and handles immediate completion exactly once', () => {
    socket.emit.mockImplementation(event => {
      if (event === 'execution:start') {
        socket.receive('execution:started', { sessionId: 'immediate' });
        socket.receive('execution:completed', { sessionId: 'immediate', exitCode: 0 });
      }
    });
    execution.start();
    socket.receive('execution:completed', { sessionId: 'immediate', exitCode: 0 });
    expect(callbacks.onExit).toHaveBeenCalledOnce();
  });

  it('releases listeners and reports an unanswered start instead of hanging the UI', () => {
    vi.useFakeTimers();
    execution.start();
    vi.advanceTimersByTime(30_000);
    expect(callbacks.onExit).toHaveBeenCalledWith(1);
    expect([...socket.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
  });
});
