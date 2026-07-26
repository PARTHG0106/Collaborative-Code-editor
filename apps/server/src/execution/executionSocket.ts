import { Server as SocketIOServer, Socket } from 'socket.io';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import prisma from '../lib/prisma.js';
import { config } from '../config/index.js';
import {
  AuthzError,
  READ_ROLES,
  WRITE_ROLES,
  requireWorkspaceRole,
} from '../lib/socketAuthz.js';

/**
 * The parts of a node-pty pseudo-terminal this module actually uses.
 *
 * Declared locally rather than imported from node-pty so that this file still
 * type-checks in an environment where the optional native module was not built.
 */
type PtyProcess = {
  onData: (listener: (data: string) => void) => void;
  write: (data: string) => void;
  resize: (columns: number, rows: number) => void;
  kill: (signal?: string) => void;
};

type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyProcess;

let cachedPtySpawn: PtySpawn | null = null;

/**
 * Held in a constant so the specifier is never a literal argument to require().
 * Bundlers resolve `require('node-pty')` at build time even inside a function
 * that is never called, which fails the build wherever this optional native
 * module was skipped.
 */
const PTY_MODULE = 'node-pty';

/**
 * A CommonJS require looked up at runtime, deliberately opaque to bundlers.
 *
 * Returns null rather than throwing when there is no require in scope, which is
 * the case if this file is ever bundled as ESM.
 */
function getRuntimeRequire(): ((id: string) => unknown) | null {
  try {
    // eslint-disable-next-line no-eval
    if ((eval('typeof require') as string) !== 'function') return null;
    // eslint-disable-next-line no-eval
    return eval('require') as (id: string) => unknown;
  } catch {
    return null;
  }
}

/**
 * node-pty is a native addon with no prebuilt binary for every platform, so it
 * lives in optionalDependencies: an image without a compiler toolchain skips it
 * instead of failing the whole install. Loading it lazily keeps that skip
 * harmless - the module is only needed once someone actually opens a terminal,
 * which requires ENABLE_TERMINAL plus a write role on the workspace.
 */
function loadPtySpawn(): PtySpawn {
  if (cachedPtySpawn) return cachedPtySpawn;

  const requireAtRuntime = getRuntimeRequire();
  if (!requireAtRuntime) {
    throw new Error('No CommonJS require is available to load the terminal backend');
  }

  const loaded = requireAtRuntime(PTY_MODULE) as { spawn?: PtySpawn };
  if (typeof loaded?.spawn !== 'function') {
    throw new Error('node-pty is installed but did not export a spawn function');
  }

  cachedPtySpawn = loaded.spawn;
  return cachedPtySpawn;
}

const activeProcesses = new Map<string, any>();
const ptyProcesses = new Map<string, PtyProcess>();
const ptyTimeouts = new Map<string, NodeJS.Timeout>();

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

/** Upper bound on a single stdin write. */
const MAX_STDIN_BYTES = 8192;

/**
 * Filenames that are safe to hand to a compiler as an argv element. The old
 * validation rejected only / and \, which still allowed ; ( ) and backticks -
 * enough to inject a command once the name was interpolated into a shell
 * string.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** A GPU worker whose heartbeat is older than this is treated as reclaimable. */
const STALE_MS = 2 * 60 * 1000;

/** Hard cap on how long an interactive shell may stay alive. */
const PTY_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** Scheme and suffix for a Hugging Face Space direct API host. */
const SCHEME = 'https://';
const SPACE_HOST_SUFFIX = '.hf.space';

/**
 * The only environment variables an interactive shell inherits.
 *
 * Previously the PTY was spawned with `env: process.env`, which handed every
 * terminal user the JWT signing secrets, the database URL, the Hugging Face
 * token and the SMTP password.
 */
function buildSafeEnv(cwd: string): Record<string, string> {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd,
    PWD: cwd,
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'C.UTF-8',
    SHELL: '/bin/bash',
    // Short prompt: the default on Hugging Face is a ~80 character hostname,
    // which is what made the prompt wrap and overwrite itself.
    PS1: '\\w\\$ ',
  };
}

/**
 * Accepts the URL shapes people actually store for a Space and returns an
 * origin we can call.
 *
 *   "owner/space"                      -> the direct owner-space API host
 *   a huggingface.co/spaces/o/s page    -> the direct o-s API host
 *   an already-direct host              -> unchanged, trailing slash removed
 *
 * A Space *page* URL or a trailing slash produces the same "Could not resolve
 * app config." failure, so normalize rather than trust whatever is in the DB.
 */
export function normalizeSpaceUrl(raw: string): string {
  const value = (raw || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('GPU worker has no URL configured.');

  const asSlug = (owner: string, space: string): string => {
    const host = (owner + '-' + space).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return SCHEME + host + SPACE_HOST_SUFFIX;
  };

  const hfPage = value.match(/^https?:\/\/huggingface\.co\/spaces\/([^/]+)\/([^/]+)/i);
  if (hfPage) return asSlug(hfPage[1], hfPage[2]);

  if (/^https?:\/\//i.test(value)) return value;

  const slug = value.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slug) return asSlug(slug[1], slug[2]);

  throw new Error(`Unrecognized GPU worker URL: ${value}`);
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const base = normalizeSpaceUrl(spaceUrl);
  const token = process.env.HF_TOKEN;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const candidates = [`${base}/gradio_api/call/execute`, `${base}/call/execute`];
  const failures: string[] = [];

  for (const endpoint of candidates) {
    try {
      const postRes = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: [code, language] }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!postRes.ok) {
        failures.push(`POST ${endpoint} -> ${postRes.status} ${postRes.statusText}`);
        continue;
      }

      const queued = (await postRes.json()) as { event_id?: string };
      const eventId = queued?.event_id;
      if (!eventId) {
        failures.push(`POST ${endpoint} -> no event_id in response`);
        continue;
      }

      const streamRes = await fetch(`${endpoint}/${eventId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(180_000),
      });

      if (!streamRes.ok) {
        failures.push(`GET ${endpoint}/${eventId} -> ${streamRes.status}`);
        continue;
      }

      // Payloads are small (captured stdout/stderr), so buffering the SSE body
      // is fine and avoids a hand-rolled stream parser.
      const body = await streamRes.text();

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

      failures.push(`GET ${endpoint}/${eventId} -> stream ended without a complete event`);
    } catch (err: any) {
      if (err?.message?.startsWith('GPU worker reported an error')) throw err;
      failures.push(`${endpoint} -> ${err?.message || err}`);
    }
  }

  throw new Error(
    `Could not reach the GPU worker API at ${base}. Verify the Space is running, that HF_TOKEN can read it, ` +
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
      const { workspaceId, fileId, language, code, target = 'REMOTE' } = payload;

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

        if (target === 'gpu-worker') {
          try {
            if (!process.env.HF_TOKEN) {
              throw new Error(
                'HF_TOKEN is missing in the backend server environment variables. Please add it as a secret in your Hugging Face Space settings to authenticate and unlock your ZeroGPU quota.',
              );
            }

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
              throw new Error('No GPU workers currently available. Please try again later.');
            }

            await prisma.executionWorker.update({
              where: { id: worker.id },
              data: { status: 'BUSY', activeJobs: { increment: 1 } },
            });

            try {
              const result = await callGpuWorker(worker.url, code, language);

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
              // Free the worker
              await prisma.executionWorker.update({
                where: { id: worker.id },
                data: {
                  status: 'IDLE',
                  activeJobs: { decrement: 1 },
                  lastHeartbeat: new Date(),
                },
              });
            }
          } catch (e: any) {
            io.to(`exec:${session.id}`).emit('execution:stderr', {
              sessionId: session.id,
              data: e.message + '\n',
              timestamp: Date.now(),
            });
            exitCode = 1;
          }
        } else {
          // Execute natively on the backend server (CPU/Remote)

          // Execute inside the materialized workspace folder
          const tmpDir = path.join(os.tmpdir(), `syncscript_ws_${workspaceId}`);
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }

          let compile: { cmd: string; args: string[] } | null = null;
          let runCmd = '';
          let runArgs: string[] = [];
          let sourceFile = '';

          // Use the real file name where possible, but only if it is safe to
          // pass to a compiler as an argument.
          const dbFile = fileId
            ? await prisma.fileSystemItem.findUnique({ where: { id: fileId } })
            : null;

          // A file id from another workspace must not be executed here.
          if (dbFile && dbFile.workspaceId !== workspaceId) {
            throw new Error('File does not belong to this workspace');
          }

          const safeName = dbFile && SAFE_NAME.test(dbFile.name) ? dbFile.name : null;

          if (language === 'cpp' || language === 'c') {
            const ext = language === 'cpp' ? 'cpp' : 'c';
            const compiler = language === 'cpp' ? 'g++' : 'gcc';
            sourceFile = path.join(tmpDir, safeName || `main.${ext}`);
            const outFile = path.join(tmpDir, 'main.out');
            fs.writeFileSync(sourceFile, code);
            // Array args, no shell: a filename can no longer inject a command.
            compile = { cmd: compiler, args: [sourceFile, '-o', outFile] };
            runCmd = outFile;
          } else if (language === 'python') {
            sourceFile = path.join(tmpDir, safeName || 'main.py');
            fs.writeFileSync(sourceFile, code);
            runCmd = 'python3';
            runArgs = [sourceFile];
          } else if (language === 'javascript' || language === 'typescript') {
            sourceFile = path.join(tmpDir, safeName || 'main.js');
            fs.writeFileSync(sourceFile, code);
            runCmd = 'node';
            runArgs = [sourceFile];
          } else if (language === 'java') {
            // javac derives the class name from the file, so the name must be a
            // valid identifier as well as shell-safe.
            const javaName =
              safeName && /^[A-Za-z][A-Za-z0-9_]*\.java$/.test(safeName) ? safeName : 'Main.java';
            sourceFile = path.join(tmpDir, javaName);
            fs.writeFileSync(sourceFile, code);
            compile = { cmd: 'javac', args: ['-d', tmpDir, sourceFile] };
            runCmd = 'java';
            runArgs = ['-cp', tmpDir, path.basename(javaName, '.java')];
          } else {
            throw new Error(`Native remote execution not implemented for language: ${language}`);
          }

          try {
            if (compile) {
              const compiled = spawnSync(compile.cmd, compile.args, {
                cwd: tmpDir,
                shell: false,
                encoding: 'utf8',
                timeout: 30_000,
              });

              if (compiled.error || compiled.status !== 0) {
                const detail =
                  compiled.stderr || compiled.error?.message || 'Compilation failed';
                io.to(`exec:${session.id}`).emit('execution:stderr', {
                  sessionId: session.id,
                  data: detail + '\n',
                  timestamp: Date.now(),
                });
                throw new Error('Compilation failed');
              }
            }

            await new Promise<void>((resolve) => {
              const proc = spawn(runCmd, runArgs, { cwd: tmpDir, shell: false });
              activeProcesses.set(socket.id, proc);

              let outputSize = 0;
              const MAX_SIZE = 1024 * 512; // 512 KB
              let isKilled = false;

              const timeout = setTimeout(() => {
                isKilled = true;
                proc.kill('SIGKILL');
                io.to(`exec:${session!.id}`).emit('execution:stderr', {
                  sessionId: session!.id,
                  data: '\n[Execution Timeout: 20 seconds exceeded]\n',
                  timestamp: Date.now(),
                });
              }, 20000);

              const forward = (channel: 'execution:stdout' | 'execution:stderr') => (data: Buffer) => {
                if (isKilled) return;
                outputSize += data.length;
                if (outputSize > MAX_SIZE) {
                  isKilled = true;
                  proc.kill('SIGKILL');
                  io.to(`exec:${session!.id}`).emit('execution:stderr', {
                    sessionId: session!.id,
                    data: '\n[Execution Error: Output size limit exceeded]\n',
                    timestamp: Date.now(),
                  });
                  return;
                }
                io.to(`exec:${session!.id}`).emit(channel, {
                  sessionId: session!.id,
                  data: data.toString(),
                  timestamp: Date.now(),
                });
              };

              proc.stdout.on('data', forward('execution:stdout'));
              proc.stderr.on('data', forward('execution:stderr'));

              proc.on('close', (code: number) => {
                clearTimeout(timeout);
                activeProcesses.delete(socket.id);
                exitCode = isKilled ? 1 : code;
                resolve();
              });

              proc.on('error', (err: Error) => {
                clearTimeout(timeout);
                activeProcesses.delete(socket.id);
                if (!isKilled) {
                  io.to(`exec:${session!.id}`).emit('execution:stderr', {
                    sessionId: session!.id,
                    data: err.message + '\n',
                    timestamp: Date.now(),
                  });
                }
                exitCode = 1;
                resolve();
              });
            });
          } catch (err) {
            exitCode = 1;
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        }

        await prisma.executionSession.update({
          where: { id: session.id },
          data: {
            status: exitCode === 0 ? 'COMPLETED' : 'FAILED',
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
        if (err instanceof AuthzError) {
          denied('execution:start', err);
          return;
        }

        console.error('Execution start error:', err);
        const sessionId = session?.id || 'unknown';
        socket.emit('execution:failed', {
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
      }
    },
  );

  // User sends stdin to a running execution
  socket.on('execution:stdin', ({ sessionId, data }: { sessionId: string; data: string }) => {
    if (typeof data !== 'string') return;
    const chunk = data.slice(0, MAX_STDIN_BYTES);

    io.to(`exec:${sessionId}`).emit('execution:stdin', { sessionId, data: chunk });

    // Attempt to write to the local process if it exists
    const proc = activeProcesses.get(socket.id);
    if (proc && proc.stdin) {
      try {
        proc.stdin.write(chunk);
      } catch {
        /* the process may have already exited */
      }
    }
  });

  socket.on(
    'terminal:spawn',
    async (payload: { workspaceId?: string; cols?: number; rows?: number } = {}) => {
      const { workspaceId } = payload;

      try {
        // An interactive shell on the API host is not something to expose by
        // default, and it must never be reachable by a non-member.
        if (!config.enableTerminal) {
          socket.emit('terminal:output', {
            data: 'The interactive terminal is disabled on this server.\r\n',
          });
          return;
        }

        if (!workspaceId) {
          throw new AuthzError('A workspaceId is required to open a terminal');
        }

        await requireWorkspaceRole(user.id, workspaceId, WRITE_ROLES);

        if (ptyProcesses.has(socket.id)) return;

        // node-pty is optional, so confirm it is actually present before doing
        // any filesystem work for this session.
        let spawnPty: PtySpawn;
        try {
          spawnPty = loadPtySpawn();
        } catch (err) {
          console.error('node-pty is unavailable, terminal disabled:', err);
          socket.emit('terminal:output', {
            data:
              'The interactive terminal is unavailable: this server was built without the node-pty native module.\r\n',
          });
          return;
        }

        // xterm on the client decides the real geometry; a fixed 80x30 made
        // bash wrap at the wrong column and garble the prompt.
        const cols = Math.max(20, Math.min(500, Math.floor(Number(payload.cols) || 80)));
        const rows = Math.max(5, Math.min(200, Math.floor(Number(payload.rows) || 30)));

        const wsDir = path.join(os.tmpdir(), `syncscript_ws_${workspaceId}`);
        if (!fs.existsSync(wsDir)) {
          fs.mkdirSync(wsDir, { recursive: true });
        }

        // Materialize the workspace tree on disk
        const files = await prisma.fileSystemItem.findMany({ where: { workspaceId } });
        const fileMap = new Map<string, any>();
        files.forEach((f: any) => fileMap.set(f.id, f));

        const resolvePath = (id: string): string => {
          const f = fileMap.get(id);
          if (!f) return '';
          if (!f.parentId) return f.name;
          return path.join(resolvePath(f.parentId), f.name);
        };

        for (const f of files as any[]) {
          const relative = resolvePath(f.id);
          if (!relative) continue;

          const fullPath = path.join(wsDir, relative);
          // Refuse anything that resolves outside the workspace directory.
          if (!path.resolve(fullPath).startsWith(path.resolve(wsDir) + path.sep)) continue;

          if (f.type === 'FOLDER') {
            if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
          } else {
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, f.content || '');
          }
        }

        const cwd = wsDir;

        // --noprofile --norc so no startup file can re-export a wider
        // environment or override the prompt.
        const ptyProcess = spawnPty('bash', ['--noprofile', '--norc'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: buildSafeEnv(cwd),
        });

        ptyProcess.onData((data: string) => {
          socket.emit('terminal:output', { data });
        });

        ptyProcesses.set(socket.id, ptyProcess);

        // Bound the lifetime so an abandoned tab cannot hold a shell forever.
        const lifetime = setTimeout(() => {
          const proc = ptyProcesses.get(socket.id);
          if (proc) {
            socket.emit('terminal:output', {
              data: '\r\n[Terminal session expired after 15 minutes]\r\n',
            });
            proc.kill();
            ptyProcesses.delete(socket.id);
          }
          ptyTimeouts.delete(socket.id);
        }, PTY_MAX_LIFETIME_MS);
        lifetime.unref?.();
        ptyTimeouts.set(socket.id, lifetime);
      } catch (err) {
        denied('terminal:spawn', err);
      }
    },
  );

  socket.on('terminal:data', ({ data }: { data: string }) => {
    const ptyProcess = ptyProcesses.get(socket.id);
    if (ptyProcess && typeof data === 'string') {
      ptyProcess.write(data);
    }
  });

  // Keep the PTY's idea of the window in sync with the browser's, otherwise
  // bash keeps wrapping at the geometry it was spawned with.
  socket.on('terminal:resize', ({ cols, rows }: { cols?: number; rows?: number } = {}) => {
    const ptyProcess = ptyProcesses.get(socket.id);
    if (!ptyProcess) return;

    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows)) return;

    try {
      ptyProcess.resize(
        Math.max(20, Math.min(500, nextCols)),
        Math.max(5, Math.min(200, nextRows)),
      );
    } catch {
      /* the shell may have exited between events */
    }
  });

  // Registered once per connection. This used to live inside terminal:spawn,
  // which added another listener every time a terminal was opened.
  socket.on('disconnect', () => {
    const proc = ptyProcesses.get(socket.id);
    if (proc) {
      proc.kill();
      ptyProcesses.delete(socket.id);
    }

    const lifetime = ptyTimeouts.get(socket.id);
    if (lifetime) {
      clearTimeout(lifetime);
      ptyTimeouts.delete(socket.id);
    }

    const child = activeProcesses.get(socket.id);
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      activeProcesses.delete(socket.id);
    }
  });

  // User cancels execution
  socket.on('execution:cancel', async ({ sessionId }: { sessionId: string }) => {
    try {
      const session = await prisma.executionSession.findUnique({
        where: { id: sessionId },
        select: { workspaceId: true },
      });
      if (!session) return;

      await requireWorkspaceRole(user.id, session.workspaceId, WRITE_ROLES);

      await prisma.executionSession.update({
        where: { id: sessionId },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });

      const child = activeProcesses.get(socket.id);
      if (child) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }

      io.to(`exec:${sessionId}`).emit('execution:completed', {
        sessionId,
        exitCode: -1,
        durationMs: 0,
        target: 'remote',
      });
    } catch (err) {
      denied('execution:cancel', err);
    }
  });

  // Collaborator watches an execution. Authorize against the session's own
  // workspace: joining a room by guessed id previously leaked another
  // workspace's program output.
  socket.on('execution:watch', async ({ sessionId }: { sessionId: string }) => {
    try {
      const session = await prisma.executionSession.findUnique({
        where: { id: sessionId },
        select: { workspaceId: true },
      });
      if (!session) throw new AuthzError('Execution session not found');

      await requireWorkspaceRole(user.id, session.workspaceId, READ_ROLES);
      socket.join(`exec:${sessionId}`);
    } catch (err) {
      denied('execution:watch', err);
    }
  });

  socket.on('execution:unwatch', ({ sessionId }: { sessionId: string }) => {
    socket.leave(`exec:${sessionId}`);
  });
}
