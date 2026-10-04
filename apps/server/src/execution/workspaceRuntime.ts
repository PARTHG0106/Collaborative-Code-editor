import { timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';
import type { Server, Socket } from 'socket.io';
import { provisionRuntime, runtimeToken } from './runtimeProvisioner.js';

export type RuntimeFile = { path: string; type: 'FILE' | 'FOLDER'; content?: string };
type TreeItem = { id: string; name: string; parentId: string | null; type: string; content: string | null };
type RuntimeReply = { ok: boolean; result?: unknown; error?: string };

export function workspaceFiles(items: TreeItem[]): RuntimeFile[] {
  const map = new Map<string, TreeItem>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error('Duplicate workspace file identifier.');
    if (item.type !== 'FILE' && item.type !== 'FOLDER') throw new Error('Invalid workspace item type.');
    map.set(item.id, item);
  }
  const resolved = new Map<string, string>();
  function resolve(id: string, seen = new Set<string>()): string {
    const cached = resolved.get(id);
    if (cached) return cached;
    const item = map.get(id);
    if (!item || seen.has(id) || seen.size >= 64) throw new Error('Invalid workspace folder hierarchy.');
    if (!item.name || item.name === '.' || item.name === '..' || /[:\\/]/.test(item.name) ||
        [...item.name].some(character => character.charCodeAt(0) < 32)) throw new Error('Invalid workspace filename.');
    seen.add(id);
    const parent = item.parentId ? map.get(item.parentId) : undefined;
    if (item.parentId && parent?.type !== 'FOLDER') throw new Error('Invalid workspace parent folder.');
    const result = item.parentId ? `${resolve(item.parentId, seen)}/${item.name}` : item.name;
    if (result.length > 1024 || result.split('/').length > 64) throw new Error('Workspace path exceeds the runtime limit.');
    resolved.set(id, result);
    return result;
  }
  const paths = new Set<string>();
  return items.map(item => {
    const filePath = resolve(item.id);
    if (paths.has(filePath)) throw new Error('Duplicate workspace file path.');
    paths.add(filePath);
    return { path: filePath, type: item.type === 'FOLDER' ? 'FOLDER' : 'FILE', ...(item.type === 'FILE' ? { content: item.content || '' } : {}) };
  });
}

export interface WorkspaceRuntime extends EventEmitter {
  readonly workspaceId: string;
  readonly connected: boolean;
  request(action: string, payload: object): Promise<unknown>;
}

class RemoteWorkspaceRuntime extends EventEmitter implements WorkspaceRuntime {
  constructor(readonly workspaceId: string, private readonly socket: Socket) {
    super();
    for (const event of ['terminal-output', 'terminal-exit', 'execution-output', 'execution-exit']) {
      socket.on(`runtime:${event}`, (payload: unknown) => this.emit(event, payload));
    }
    socket.on('disconnect', () => this.emit('disconnected'));
  }
  get connected(): boolean { return this.socket.connected; }
  async request(action: string, payload: object): Promise<unknown> {
    if (!this.connected) throw new Error('Workspace runtime disconnected.');
    const reply = await this.socket.timeout(30_000).emitWithAck('runtime:request', { action, payload }) as RuntimeReply;
    if (!reply?.ok) throw new Error(typeof reply?.error === 'string' ? reply.error.slice(0,500) : 'Workspace runtime request failed.');
    return reply.result;
  }
}

const runtimes = new Map<string, WorkspaceRuntime>();
const connections = new EventEmitter();
connections.setMaxListeners(100);
const starting = new Map<string, Promise<WorkspaceRuntime>>();

export function initializeRuntimeGateway(io: Server): void {
  const namespace = io.of('/runtime');
  namespace.use((socket, next) => {
    if (process.env.RUNTIME_PROVIDER === 'local') return next(new Error('External runtime connections are disabled.'));
    const { workspaceId, token } = socket.handshake.auth || {};
    if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return next(new Error('Invalid runtime credentials.'));
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(runtimeToken(workspaceId)))) return next(new Error('Invalid runtime credentials.'));
    socket.data.workspaceId = workspaceId;
    next();
  });
  namespace.on('connection', socket => {
    const workspaceId = socket.data.workspaceId as string;
    if (runtimes.get(workspaceId)?.connected) { socket.disconnect(true); return; }
    const runtime = new RemoteWorkspaceRuntime(workspaceId, socket);
    runtimes.set(workspaceId, runtime);
    runtime.once('disconnected', () => { if (runtimes.get(workspaceId) === runtime) runtimes.delete(workspaceId); });
    connections.emit(workspaceId, runtime);
  });
  io.httpServer?.once('close', () => {
    runtimes.clear(); starting.clear();
    if (process.env.RUNTIME_PROVIDER === 'local') void import('./localWorkspaceRuntime.js').then(module => module.closeAllLocalRuntimes()).catch(() => undefined);
  });
}

export function connectedRuntime(workspaceId: string): WorkspaceRuntime | undefined {
  const runtime = runtimes.get(workspaceId);
  return runtime?.connected ? runtime : undefined;
}

export async function ensureRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
  const live = connectedRuntime(workspaceId);
  if (live) return live;
  const pending = starting.get(workspaceId);
  if (pending) return pending;
  if (starting.size >= 8) throw new Error('Several workspaces are starting. Please try again shortly.');
  const task = (async () => {
    if (process.env.RUNTIME_PROVIDER === 'local') {
      const { getLocalRuntime } = await import('./localWorkspaceRuntime.js');
      const runtime = await getLocalRuntime(workspaceId);
      runtimes.set(workspaceId, runtime);
      runtime.once('disconnected', () => { if (runtimes.get(workspaceId) === runtime) runtimes.delete(workspaceId); });
      return runtime;
    }
    await provisionRuntime(workspaceId);
    const ready = connectedRuntime(workspaceId);
    if (ready) return ready;
    return new Promise<WorkspaceRuntime>((resolve, reject) => {
      const timer = setTimeout(() => { connections.off(workspaceId, onConnect); reject(new Error('The workspace runtime is still building. Select Restart terminal in a few minutes.')); }, 180_000);
      const onConnect = (runtime: WorkspaceRuntime) => { clearTimeout(timer); resolve(runtime); };
      connections.once(workspaceId, onConnect);
    });
  })().finally(() => starting.delete(workspaceId));
  starting.set(workspaceId, task);
  return task;
}
