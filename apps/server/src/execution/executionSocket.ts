import { Server as SocketIOServer, Socket } from 'socket.io';
import prisma from '../lib/prisma.js';
import { registerTerminalGateway } from './terminalGateway.js';
import { registerRemoteExecutionInput, runRemoteExecution } from './remoteExecution.js';
import { normalizeSpaceUrl } from './gpuWorkerUrl.js';
export { normalizeSpaceUrl } from './gpuWorkerUrl.js';
import {
  AuthzError,
  READ_ROLES,
  WRITE_ROLES,
  requireWorkspaceRole,
} from '../lib/socketAuthz.js';

/** Languages we are willing to execute at all. Enforced server-side. */
const ALLOWED_LANGUAGES = new Set([
  'python',
  'cpp',
  'c',
  'javascript',
  'typescript',
  'java',
]);

/** Upper bound on submitted source size. */
const MAX_CODE_BYTES = 256 * 1024;

/** A GPU worker whose heartbeat is older than this is treated as reclaimable. */
const STALE_MS = 2 * 60 * 1000;
// A canceled/uncertain Gradio request may still execute remotely. Keep its
// worker reserved beyond the worker's 60s execution budget and queue grace.
const GPU_COOLDOWN_MS = 3 * 60 * 1000;
const GPU_LEASE_MS = 5 * 60 * 1000;

async function limitedResponseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('GPU worker response exceeded the output limit.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

/**
 * Calls the Gradio Space over its documented REST API.
 *
 * The @gradio/client SDK is deliberately not used: v1+ is ESM-only (require()
 * throws ERR_REQUIRE_ESM), its auth option is hf_token rather than token, and
 * it resolves /config on connect, which 404s on Gradio 5 because the API moved
 * under /gradio_api/*. That 404 is the source of "Could not resolve app
 * config." Two POST paths are attempted so this works on Gradio 4 and 5.
 */
async function callGpuWorker(
  spaceUrl: string,
  code: string,
  language: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const base = normalizeSpaceUrl(spaceUrl);
  // Never send the account's provisioning token into a container running user
  // programs. Optional GPU authentication must be scoped to this worker only.
  const token = process.env.HF_GPU_TOKEN;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const candidates = [`${base}/gradio_api/call/execute`, `${base}/call/execute`];
  const failures: string[] = [];

  for (const endpoint of candidates) {
    signal.throwIfAborted();
    try {
      const postRes = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify({ data: [code, language] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });

      if (!postRes.ok) {
        failures.push(`POST ${endpoint} -> ${postRes.status} ${postRes.statusText}`);
        // Only an explicitly absent API route is safe to retry. A timeout or
        // lost response may already have enqueued the program on this worker.
        if (postRes.status === 404 || postRes.status === 405) continue;
        throw new Error('GPU worker rejected the execution request.');
      }

      const queued = JSON.parse(await limitedResponseText(postRes, 64 * 1024)) as { event_id?: string };
      signal.throwIfAborted();
      const eventId = queued?.event_id;
      if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
        throw new Error('GPU worker did not return an execution event ID.');
      }

      const streamRes = await fetch(`${endpoint}/${eventId}`, {
        redirect: 'error',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      });

      if (!streamRes.ok) {
        throw new Error(`GPU output request failed (HTTP ${streamRes.status}).`);
      }

      // GPU programs are untrusted too; never buffer unbounded worker output
      // in the API process, even when the worker is on another host.
      const body = await limitedResponseText(streamRes, 1024 * 1024);
      signal.throwIfAborted();

      for (const block of body.split('\n\n')) {
        const eventLine = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const dataLine = block.match(/^data:\s*([\s\S]*)$/m)?.[1]?.trim();
        if (!eventLine || !dataLine) continue;

        if (eventLine === 'error') {
          throw new Error(`GPU worker reported an error: ${dataLine}`);
        }

        if (eventLine === 'complete') {
          const parsed = JSON.parse(dataLine);
          const result = Array.isArray(parsed) ? parsed[0] : parsed;
          return {
            stdout: String(result?.stdout ?? ''),
            stderr: String(result?.stderr ?? ''),
            exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 0,
          };
        }
      }

      throw new Error('GPU output stream ended without a completion event.');
    } catch (err: any) {
      if (signal.aborted) throw signal.reason;
      throw new Error(`GPU request failed: ${err?.message || 'Unknown worker error'}`);
    }
  }

  throw new Error(
    `Could not reach the GPU worker API at ${base}. Verify the Space is running and any HF_GPU_TOKEN is scoped to this worker, ` +
      `and that ExecutionWorker.url points at the Space. Attempts: ${failures.join('; ')}`,
  );
}

/**
 * Execution socket event handlers.
 * These handle remote execution requests from the frontend when
 * neither browser nor local agent execution is available.
 */
export function registerExecutionHandlers(io: SocketIOServer, socket: Socket) {
  const user = socket.data.user as { id: string; name: string; email: string };
  let executionPending = false;
  let pendingSessionId: string | undefined;
  let cancelledPending = false;
  let gpuAbort: AbortController | undefined;
  socket.on('execution:cancel', (payload: { sessionId?: string } = {}) => {
    if (payload?.sessionId && payload.sessionId === pendingSessionId) {
      cancelledPending = true;
      gpuAbort?.abort();
    }
  });
  socket.on('disconnect', () => { cancelledPending = true; gpuAbort?.abort(); });

  function denied(event: string, err: unknown): void {
    const message = err instanceof AuthzError ? err.message : 'Request failed';
    if (!(err instanceof AuthzError)) {
      console.error(`Execution handler ${event} failed:`, err);
    } else {
      console.warn(`Denied ${event} for ${user.email}: ${message}`);
    }
    socket.emit('authz_error', { event, message });
  }

  // NOTE: a second, identical 'execution:stdin' handler used to be registered
  // at the top of this function. Socket.IO calls every registered listener, so
  // each keystroke was written to the child process twice. Only the handler
  // below remains.

  // User starts a remote execution
  socket.on(
    'execution:start',
    async (
      payload: {
        workspaceId: string;
        fileId: string;
        language: string;
        code: string;
        target?: string;
      } = {} as any,
    ) => {
      if (!payload || typeof payload !== 'object' || executionPending) return;
      const { workspaceId, fileId, language, code, target = 'REMOTE' } = payload;
      executionPending = true;
      cancelledPending = false;

      let session: { id: string } | null = null;

      try {
        // Running code is a write action: VIEWER must not be able to execute.
        await requireWorkspaceRole(user.id, workspaceId, WRITE_ROLES);

        if (!ALLOWED_LANGUAGES.has(language)) {
          throw new Error(`Unsupported language: ${language}`);
        }

        if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
          throw new Error('Source exceeds the 256KB execution limit.');
        }

        if (fileId) {
          const file = await prisma.fileSystemItem.findUnique({ where: { id: fileId }, select: { workspaceId: true, type: true } });
          if (!file || file.workspaceId !== workspaceId || file.type !== 'FILE') throw new AuthzError('File does not belong to this workspace');
        }
        if (!socket.connected) return;

        // Create execution session record
        session = await prisma.executionSession.create({
          data: {
            workspaceId,
            fileId,
            userId: user.id,
            language,
            code,
            target: target === 'gpu-worker' ? 'GPU_WORKER' : 'REMOTE',
            status: 'QUEUED',
          },
        });

        // Join execution room so other collaborators can watch
        socket.join(`exec:${session.id}`);
        pendingSessionId = session.id;
        socket.emit('execution:started', { sessionId: session.id });

        // Broadcast to workspace that execution started
        io.to(`workspace:${workspaceId}`).emit('execution:status', {
          sessionId: session.id,
          status: 'running',
          userId: user.id,
          userName: user.name,
          language,
          target,
        });

        // Update status to running
        await prisma.executionSession.update({
          where: { id: session.id },
          data: { status: 'RUNNING', startedAt: new Date() },
        });

        let exitCode = 0;

        if (cancelledPending || !socket.connected) {
          exitCode = -1;
        } else if (target === 'gpu-worker') {
          const controller = new AbortController();
          gpuAbort = controller;
          try {
            // Prefer a genuinely idle worker, but also reclaim one that is
            // parked at BUSY with a stale heartbeat - otherwise a single
            // crashed job blocks GPU execution permanently.
            const worker = await prisma.executionWorker.findFirst({
              where: {
                type: 'GPU',
                OR: [
                  { status: 'IDLE' },
                  { status: 'BUSY', lastHeartbeat: { lt: new Date(Date.now() - STALE_MS) } },
                ],
              },
              orderBy: { lastHeartbeat: 'desc' },
            });

            if (!worker) {
              const registered = await prisma.executionWorker.findMany({ where: { type: 'GPU' }, select: { status: true } });
              if (registered.some(item => item.status === 'IDLE')) throw new Error('GPU worker availability changed. Please try again.');
              if (registered.some(item => item.status === 'BUSY')) throw new Error('GPU workers are busy or cooling down. Please try again shortly.');
              throw new Error('No enabled GPU worker is configured. Ask the administrator to configure HF_GPU_WORKER_URL or enable an existing worker.');
            }
            if (cancelledPending || !socket.connected) controller.abort();
            controller.signal.throwIfAborted();
            const claimedAt = new Date(Date.now() + GPU_LEASE_MS - STALE_MS);
            const claim = await prisma.executionWorker.updateMany({
              where: { id: worker.id, OR: [
                { status: 'IDLE' },
                { status: 'BUSY', lastHeartbeat: { lt: new Date(Date.now() - STALE_MS) } },
              ] },
              data: { status: 'BUSY', activeJobs: 1, lastHeartbeat: claimedAt },
            });
            if (claim.count !== 1) throw new Error('This GPU worker was just reserved. Please try again later.');

            let submitted = false;
            let completed = false;
            try {
              if (cancelledPending || !socket.connected) controller.abort();
              controller.signal.throwIfAborted();
              submitted = true;
              const result = await callGpuWorker(worker.url, code, language, controller.signal);
              controller.signal.throwIfAborted();
              completed = true;

              if (result.stdout) {
                io.to(`exec:${session.id}`).emit('execution:stdout', {
                  sessionId: session.id,
                  data: result.stdout,
                  timestamp: Date.now(),
                });
              }
              if (result.stderr) {
                io.to(`exec:${session.id}`).emit('execution:stderr', {
                  sessionId: session.id,
                  data: result.stderr,
                  timestamp: Date.now(),
                });
              }

              exitCode = result.exitCode;
            } finally {
              const uncertain = submitted && !completed;
              // CAS prevents a late response from releasing a newer worker
              // claim. A future heartbeat preserves cooldown across restarts;
              // the ordinary stale-worker selector can reclaim it afterward.
              await prisma.executionWorker.updateMany({
                where: { id: worker.id, status: 'BUSY', lastHeartbeat: claimedAt },
                data: uncertain
                  ? { status: 'BUSY', activeJobs: 1, lastHeartbeat: new Date(Date.now() + GPU_COOLDOWN_MS - STALE_MS) }
                  : { status: 'IDLE', activeJobs: 0, lastHeartbeat: new Date() },
              });
            }
          } catch (e: any) {
            if (controller.signal.aborted || cancelledPending || !socket.connected) exitCode = -1;
            else {
              io.to(`exec:${session.id}`).emit('execution:stderr', {
                sessionId: session.id, data: e.message + '\n', timestamp: Date.now(),
              });
              exitCode = 1;
            }
          } finally {
            if (gpuAbort === controller) gpuAbort = undefined;
          }
        } else {
          exitCode = await runRemoteExecution(io, socket, { sessionId: session.id, workspaceId, fileId, language, code });
        }

        await prisma.executionSession.update({
          where: { id: session.id },
          data: {
            status: exitCode === -1 ? 'CANCELLED' : exitCode === 0 ? 'COMPLETED' : 'FAILED',
            exitCode,
            completedAt: new Date(),
          },
        });

        io.to(`exec:${session.id}`).emit('execution:completed', {
          sessionId: session.id,
          exitCode,
          durationMs: 0,
          target: 'remote',
        });
      } catch (err: any) {
        if (session) {
          await prisma.executionSession.update({ where: { id: session.id }, data: { status: 'FAILED', exitCode: 1, completedAt: new Date() } }).catch(() => undefined);
        }
        if (err instanceof AuthzError) {
          denied('execution:start', err);
          return;
        }

        console.error('Execution start error:', err);
        const sessionId = session?.id || 'unknown';
        socket.emit('execution:failed', {
          sessionId: session?.id,
          error: err.message || 'Failed to create execution session',
        });
        socket.emit('execution:stderr', {
          sessionId,
          data: `Backend execution error: ${err.message}\r\n`,
          timestamp: Date.now(),
        });
        socket.emit('execution:completed', {
          sessionId,
          exitCode: 1,
          durationMs: 0,
          target: 'remote',
        });
      } finally {
        executionPending = false;
        pendingSessionId = undefined;
        gpuAbort = undefined;
      }
    },
  );

  registerTerminalGateway(socket);
  registerRemoteExecutionInput(io, socket);

  // Collaborator watches an execution. Authorize against the session's own
  // workspace: joining a room by guessed id previously leaked another
  // workspace's program output.
  socket.on('execution:watch', async (payload: { sessionId?: string } = {}) => {
    try {
      const sessionId = payload?.sessionId;
      if (typeof sessionId !== 'string') throw new AuthzError('Invalid execution session');
      const session = await prisma.executionSession.findUnique({
        where: { id: sessionId },
        select: { workspaceId: true, status: true, exitCode: true, durationMs: true },
      });
      if (!session) throw new AuthzError('Execution session not found');

      await requireWorkspaceRole(user.id, session.workspaceId, READ_ROLES);
      socket.join(`exec:${sessionId}`);
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(session.status)) {
        socket.emit('execution:completed', { sessionId, exitCode: session.exitCode ?? (session.status === 'COMPLETED' ? 0 : 1), durationMs: session.durationMs ?? 0, target: 'remote' });
      }
    } catch (err) {
      denied('execution:watch', err);
    }
  });

  socket.on('execution:unwatch', (payload: { sessionId?: string } = {}) => {
    if (typeof payload?.sessionId === 'string') socket.leave(`exec:${payload.sessionId}`);
  });
}
