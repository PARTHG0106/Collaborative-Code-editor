import { randomUUID } from 'crypto';
import type { Socket } from 'socket.io';
import prisma from '../lib/prisma.js';
import { config } from '../config/index.js';
import { WRITE_ROLES, requireWorkspaceRole } from '../lib/socketAuthz.js';
import { ensureRuntime, workspaceFiles, type WorkspaceRuntime } from './workspaceRuntime.js';

type Terminal = {
  id: string; workspaceId: string; runtime?: WorkspaceRuntime; ready: boolean;
  queue: Promise<unknown>; cleanup?: () => void;
  queuedBytes: number;
};

export function terminalGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const clamp = (value: unknown, fallback: number, min: number, max: number) => {
    if (typeof value !== 'number' && typeof value !== 'string') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  };
  return { cols: clamp(cols, 80, 20, 500), rows: clamp(rows, 24, 5, 200) };
}

/** Every shell goes through an isolated runtime; no direct host-shell fallback. */
export function registerTerminalGateway(socket: Socket): void {
  let terminal: Terminal | undefined;
  const userId = socket.data.user.id as string;
  const fail = (workspaceId: string, error: unknown) => socket.emit('terminal:error', {
    workspaceId, message: error instanceof Error ? error.message.slice(0, 500) : 'Unable to open workspace terminal.',
  });
  function close(current = terminal): void {
    if (!current) return;
    if (terminal === current) terminal = undefined;
    current.cleanup?.();
    if (current.runtime) void current.runtime.request('terminal:close', { terminalId: current.id }).catch(() => undefined);
  }
  socket.on('terminal:spawn', async (payload: { workspaceId?: string; cols?: number; rows?: number } = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
    if (!config.enableTerminal) { fail(workspaceId, new Error('The terminal is disabled in the server configuration.')); return; }
    if (terminal?.workspaceId === workspaceId) {
      const current = terminal;
      if (current.ready) {
        try {
          await requireWorkspaceRole(userId, workspaceId, WRITE_ROLES);
          if (terminal === current && socket.connected) socket.emit('terminal:ready', { workspaceId, ...terminalGeometry(payload.cols, payload.rows) });
        } catch (error) { if (terminal === current) { close(); fail(workspaceId, error); } }
      }
      return;
    }
    close();
    const current: Terminal = { id: randomUUID(), workspaceId, ready: false, queue: Promise.resolve(), queuedBytes: 0 };
    terminal = current;
    try {
      await requireWorkspaceRole(userId, workspaceId, WRITE_ROLES);
      if (terminal !== current || !socket.connected) return;
      socket.emit('terminal:output', { workspaceId, data: '\r\n[Starting isolated workspace terminal…]\r\n' });
      const runtime = await ensureRuntime(workspaceId);
      if (terminal !== current || !socket.connected) return;
      current.runtime = runtime;
      const items = await prisma.fileSystemItem.findMany({ where: { workspaceId } });
      if (terminal !== current || !socket.connected) return;
      await runtime.request('sync', { files: workspaceFiles(items), preserveExisting: true });
      if (terminal !== current || !socket.connected) return;
      await requireWorkspaceRole(userId, workspaceId, WRITE_ROLES);
      if (terminal !== current || !socket.connected) return;
      const output = (data: { terminalId?: string; data?: string }) => {
        if (terminal === current && data?.terminalId === current.id && typeof data.data === 'string') {
          socket.emit('terminal:output', { workspaceId, data: data.data.slice(0,256 * 1024) });
        }
      };
      const exit = (data: { terminalId?: string; exitCode?: number; signal?: number }) => {
        if (terminal !== current || data?.terminalId !== current.id) return;
        terminal = undefined;
        current.cleanup?.();
        socket.emit('terminal:exit', { workspaceId, exitCode: data.exitCode ?? 1, signal: data.signal });
      };
      const disconnected = () => { if (terminal === current) { close(); fail(workspaceId, new Error('Workspace runtime disconnected. Restart the terminal to reconnect.')); } };
      runtime.on('terminal-output', output);
      runtime.on('terminal-exit', exit);
      runtime.once('disconnected', disconnected);
      // Recheck membership even when the user leaves a shell running without input.
      const membership = setInterval(() => {
        void requireWorkspaceRole(userId, workspaceId, WRITE_ROLES).catch(error => { if (terminal === current) { close(); fail(workspaceId, error); } });
      }, 30_000);
      membership.unref();
      current.cleanup = () => {
        clearInterval(membership);
        runtime.off('terminal-output', output);
        runtime.off('terminal-exit', exit);
        runtime.off('disconnected', disconnected);
      };
      await runtime.request('terminal:spawn', { terminalId: current.id, ...terminalGeometry(payload.cols, payload.rows) });
      if (terminal !== current || !socket.connected) { close(current); return; }
      current.ready = true;
      socket.emit('terminal:ready', { workspaceId, ...terminalGeometry(payload.cols, payload.rows) });
    } catch (error) {
      if (terminal === current) { close(); fail(workspaceId, error); }
      else close(current);
    }
  });
  function forward(action: 'terminal:data' | 'terminal:resize', payload: { workspaceId?: string; data?: string; cols?: number; rows?: number }): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const current = terminal;
    if (!current?.ready || !current.runtime || payload.workspaceId !== current.workspaceId) return;
    if (action === 'terminal:data' && (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 64 * 1024)) return;
    const bytes = action === 'terminal:data' ? Buffer.byteLength(payload.data!) + 64 : 64;
    if (current.queuedBytes + bytes > 256 * 1024) {
      close();
      fail(current.workspaceId, new Error('Terminal input queue exceeded its limit. Restart the terminal to continue.'));
      return;
    }
    current.queuedBytes += bytes;
    // Async authorization must not reorder terminal keystrokes.
    current.queue = current.queue.then(async () => {
      await requireWorkspaceRole(userId, current.workspaceId, WRITE_ROLES);
      if (terminal !== current || !current.runtime || !socket.connected) return;
      await current.runtime.request(action, { terminalId: current.id, ...(action === 'terminal:data' ? { data: payload.data } : terminalGeometry(payload.cols, payload.rows)) });
    }).catch(error => { if (terminal === current) { close(); fail(current.workspaceId, error); } })
      .finally(() => { current.queuedBytes -= bytes; });
  }
  socket.on('terminal:data', (payload = {}) => forward('terminal:data', payload));
  socket.on('terminal:resize', (payload = {}) => forward('terminal:resize', payload));
  socket.on('terminal:close', (payload: { workspaceId?: string } = {}) => { if (payload?.workspaceId === terminal?.workspaceId) close(); });
  socket.on('disconnect', () => close());
}
