import type { Server, Socket } from 'socket.io';
import prisma from '../lib/prisma.js';
import { requireWorkspaceRole, WRITE_ROLES } from '../lib/socketAuthz.js';
import { ensureRuntime, workspaceFiles, type WorkspaceRuntime } from './workspaceRuntime.js';

type ActiveExecution = {
  sessionId: string; workspaceId: string; socketId: string; runtime?: WorkspaceRuntime;
  ready: boolean; cancel: (code?: number, message?: string) => void;
};
const active = new Map<string, ActiveExecution>();

export async function runRemoteExecution(io: Server, socket: Socket, options: {
  sessionId: string; workspaceId: string; fileId: string; language: string; code: string;
}): Promise<number> {
  const { sessionId, workspaceId, fileId, language, code } = options;
  if (active.has(sessionId)) throw new Error('This execution session is already active.');

  return new Promise<number>((resolve, reject) => {
    let done = false;
    let outputBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let membership: ReturnType<typeof setInterval> | undefined;
    let cleanup: (() => void) | undefined;
    const execution: ActiveExecution = { sessionId, workspaceId, socketId: socket.id, ready: false, cancel };

    function finish(exitCode: number, error?: unknown) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearInterval(membership);
      if (active.get(sessionId) === execution) active.delete(sessionId);
      cleanup?.();
      if (error !== undefined) reject(error);
      else resolve(exitCode);
    }
    function cancelRuntime() {
      if (execution.runtime) void execution.runtime.request('execution:cancel', { executionId: sessionId }).catch(() => undefined);
    }
    function cancel(exitCode = -1, message?: string) {
      if (done) return;
      if (message) io.to(`exec:${sessionId}`).emit('execution:stderr', { sessionId, data: message + '\n', timestamp: Date.now() });
      cancelRuntime();
      finish(exitCode);
    }
    function stillActive() {
      if (!done && !socket.connected) cancel();
      return !done && active.get(sessionId) === execution;
    }

    // Register pending work before the first await. Disconnect/cancel must also
    // stop a request while authorization, provisioning or file sync is pending.
    active.set(sessionId, execution);
    const start = async () => {
      if (!stillActive()) return;
      await requireWorkspaceRole(socket.data.user.id, workspaceId, WRITE_ROLES);
      if (!stillActive()) return;
      const runtime = await ensureRuntime(workspaceId);
      if (!stillActive()) return;
      execution.runtime = runtime;
      const items = await prisma.fileSystemItem.findMany({ where: { workspaceId } });
      if (!stillActive()) return;
      const files = workspaceFiles(items);
      const index = items.findIndex(item => item.id === fileId && item.type === 'FILE');
      const filePath = fileId ? files[index]?.path : undefined;
      if (fileId && !filePath) throw new Error('The execution file no longer exists in this workspace.');
      await runtime.request('sync', { files, preserveExisting: true });
      if (!stillActive()) return;
      await requireWorkspaceRole(socket.data.user.id, workspaceId, WRITE_ROLES);
      if (!stillActive()) return;

      const output = (data: { executionId?: string; channel?: string; data?: string }) => {
        if (done || data?.executionId !== sessionId || typeof data.data !== 'string' || !['stdout', 'stderr'].includes(data.channel || '')) return;
        outputBytes += Buffer.byteLength(data.data);
        if (outputBytes > 512 * 1024) { cancel(1, 'Execution output limit exceeded.'); return; }
        io.to(`exec:${sessionId}`).emit(`execution:${data.channel}`, { sessionId, data: data.data, timestamp: Date.now() });
      };
      const exit = (data: { executionId?: string; exitCode?: number }) => {
        if (data?.executionId === sessionId) finish(Number.isInteger(data.exitCode) ? data.exitCode! : 1);
      };
      const disconnected = () => cancel(1, 'Workspace runtime disconnected.');
      runtime.on('execution-output', output);
      runtime.on('execution-exit', exit);
      runtime.once('disconnected', disconnected);
      cleanup = () => {
        runtime.off('execution-output', output);
        runtime.off('execution-exit', exit);
        runtime.off('disconnected', disconnected);
      };
      timeout = setTimeout(() => cancel(1, 'Execution timeout exceeded.'), 90_000);
      membership = setInterval(() => {
        void requireWorkspaceRole(socket.data.user.id, workspaceId, WRITE_ROLES).catch(() => {
          if (!done) cancel(1, 'Execution stopped because workspace access was revoked.');
        });
      }, 30_000);
      membership.unref();
      await runtime.request('execution:start', { executionId: sessionId, language, code, path: filePath });
      if (!stillActive()) {
        // Cancel can arrive before the runtime finishes starting its process.
        // Repeat after acknowledgement so that process cannot survive the race.
        cancelRuntime();
        return;
      }
      execution.ready = true;
    };
    void start().catch(error => {
      cancelRuntime();
      finish(1, error);
    });
  });
}

export function registerRemoteExecutionInput(_io: Server, socket: Socket): void {
  let inputQueue = Promise.resolve();
  socket.on('execution:stdin', (payload: { sessionId?: string; data?: string } = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const execution = payload.sessionId ? active.get(payload.sessionId) : undefined;
    if (!execution?.ready || execution.socketId !== socket.id || typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 8192) return;
    inputQueue = inputQueue.then(async () => {
      await requireWorkspaceRole(socket.data.user.id, execution.workspaceId, WRITE_ROLES);
      if (!socket.connected || active.get(execution.sessionId) !== execution) return;
      await execution.runtime?.request('execution:stdin', { executionId: execution.sessionId, data: payload.data });
    }).catch(() => {
      if (active.get(execution.sessionId) === execution) execution.cancel(1, 'Execution input failed or workspace access was revoked.');
    });
  });
  socket.on('execution:cancel', async (payload: { sessionId?: string } = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const execution = payload.sessionId ? active.get(payload.sessionId) : undefined;
    if (!execution || execution.socketId !== socket.id) return;
    try {
      await requireWorkspaceRole(socket.data.user.id, execution.workspaceId, WRITE_ROLES);
      if (active.get(execution.sessionId) === execution) execution.cancel();
    } catch {
      if (active.get(execution.sessionId) === execution) execution.cancel(1);
      socket.emit('authz_error', { event: 'execution:cancel', message: 'Cannot cancel this execution.' });
    }
  });
  socket.on('disconnect', () => {
    for (const execution of active.values()) {
      if (execution.socketId === socket.id) execution.cancel();
    }
  });
}
