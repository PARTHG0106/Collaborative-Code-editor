import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { TerminalSession } from './TerminalSession';

class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<(payload?: unknown) => void>>();
  emit = vi.fn();
  on(event: string, listener: (payload?: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(listener);
  }
  off(event: string, listener: (payload?: unknown) => void) { this.handlers.get(event)?.delete(listener); }
  receive(event: string, payload?: unknown) {
    for (const listener of [...(this.handlers.get(event) || [])]) listener(payload);
  }
}

describe('TerminalSession', () => {
  let socket: FakeSocket;
  let input: (data: string) => void;
  let resize: (size: { cols: number; rows: number }) => void;
  let manager: {
    fit: ReturnType<typeof vi.fn>; getDimensions: ReturnType<typeof vi.fn>;
    onRawData: ReturnType<typeof vi.fn>; onResize: ReturnType<typeof vi.fn>;
    writeStdout: ReturnType<typeof vi.fn>; writeInfo: ReturnType<typeof vi.fn>; writeStderr: ReturnType<typeof vi.fn>;
  };
  let removeInput: ReturnType<typeof vi.fn>;
  let removeResize: ReturnType<typeof vi.fn>;
  const status = vi.fn();
  const start = (workspace = 'workspace') => new TerminalSession(socket as unknown as Socket, manager, workspace, status);

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new FakeSocket();
    removeInput = vi.fn();
    removeResize = vi.fn();
    manager = {
      fit: vi.fn(), getDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
      onRawData: vi.fn(callback => { input = callback; return removeInput; }),
      onResize: vi.fn(callback => { resize = callback; return removeResize; }),
      writeStdout: vi.fn(), writeInfo: vi.fn(), writeStderr: vi.fn(),
    };
  });

  it('listens before spawning, preserves the initial prompt and sends current geometry', () => {
    socket.emit.mockImplementation(event => {
      if (event === 'terminal:spawn') socket.receive('terminal:output', { workspaceId: 'workspace', data: '$ ' });
    });
    const session = start();
    expect(manager.writeStdout.mock.calls).toEqual([['$ ']]);
    expect(socket.emit).toHaveBeenCalledWith('terminal:spawn', { workspaceId: 'workspace', cols: 100, rows: 30 });
    expect(status).toHaveBeenLastCalledWith('connecting');
    session.restart();
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:spawn')).toHaveLength(1);
    session.dispose();
  });

  it('waits for ready and sends resized geometry and original control bytes only while connected', () => {
    const session = start();
    input('too early\r');
    resize({ cols: 120, rows: 40 });
    expect(socket.emit).not.toHaveBeenCalledWith('terminal:data', expect.anything());
    expect(socket.emit).not.toHaveBeenCalledWith('terminal:resize', expect.anything());
    manager.getDimensions.mockReturnValue({ cols: 120, rows: 40 });
    socket.receive('terminal:ready', { workspaceId: 'workspace' });
    expect(socket.emit).toHaveBeenLastCalledWith('terminal:resize', { workspaceId: 'workspace', cols: 120, rows: 40 });
    input('\x03');
    expect(socket.emit).toHaveBeenLastCalledWith('terminal:data', { workspaceId: 'workspace', data: '\x03' });
    resize({ cols: 140, rows: 45 });
    expect(socket.emit).toHaveBeenLastCalledWith('terminal:resize', { workspaceId: 'workspace', cols: 140, rows: 45 });
    socket.connected = false;
    socket.receive('disconnect');
    socket.emit.mockClear();
    input('must not run later\r');
    resize({ cols: 80, rows: 24 });
    session.restart();
    expect(socket.emit).not.toHaveBeenCalled();
    socket.connected = true;
    socket.receive('connect');
    expect(socket.emit.mock.calls).toEqual([['terminal:spawn', { workspaceId: 'workspace', cols: 120, rows: 40 }]]);
    expect(status).toHaveBeenLastCalledWith('connecting');
    session.dispose();
  });

  it('reports shell exit and errors and permits an explicit restart', () => {
    const session = start();
    socket.receive('terminal:ready');
    socket.receive('terminal:exit', { workspaceId: 'workspace', exitCode: 7 });
    expect(status).toHaveBeenLastCalledWith('exited');
    expect(manager.writeInfo).toHaveBeenCalledWith(expect.stringContaining('code 7'));
    session.restart();
    socket.receive('terminal:error', { workspaceId: 'workspace', message: 'Sandbox could not start' });
    expect(status).toHaveBeenLastCalledWith('error');
    expect(manager.writeStderr).toHaveBeenCalledWith(expect.stringContaining('Sandbox could not start'));
    session.restart();
    socket.receive('authz_error', { event: 'terminal:spawn', message: 'No longer a member' });
    expect(manager.writeStderr).toHaveBeenCalledWith(expect.stringContaining('No longer a member'));
    session.dispose();
  });

  it('ignores other workspaces and removes every old binding before switching workspaces', () => {
    const first = start();
    socket.receive('terminal:output', { workspaceId: 'elsewhere', data: 'private' });
    socket.receive('terminal:ready', { workspaceId: 'elsewhere' });
    expect(manager.writeStdout).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('connecting');
    first.dispose();
    first.dispose();
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:close')).toEqual([['terminal:close', { workspaceId: 'workspace' }]]);
    expect(removeInput).toHaveBeenCalledTimes(1);
    expect(removeResize).toHaveBeenCalledTimes(1);
    for (const listeners of socket.handlers.values()) expect(listeners.size).toBe(0);
    const second = start('next');
    socket.receive('terminal:output', { workspaceId: 'workspace', data: 'old shell' });
    socket.receive('terminal:output', { workspaceId: 'next', data: 'new shell' });
    expect(manager.writeStdout.mock.calls).toEqual([['new shell']]);
    second.dispose();
  });
});
