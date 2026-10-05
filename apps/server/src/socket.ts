import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { config } from './config/index.js';
import { originAllowlist } from './lib/corsOrigins.js';
import prisma from './lib/prisma.js';
import { registerExecutionHandlers } from './execution/executionSocket.js';
import { initializeRuntimeGateway, connectedRuntime, workspaceFiles } from './execution/workspaceRuntime.js';
import {
  applyOperation,
  operationBaseLength,
  operationFromSplices,
  transformOperations,
  type TextOperation,
} from '../../../packages/text-ot/index.js';
import {
  AuthzError,
  READ_ROLES,
  WRITE_ROLES,
  WorkspaceRole,
  requireFileRole,
  requireWorkspaceRole,
} from './lib/socketAuthz.js';

interface UserPayload {
  id: string;
  name: string;
  email: string;
}

interface TextEdit {
  offset: number;
  text: string;
  length: number;
}

export type { TextEdit };

interface FileState {
  workspaceId: string;
  isNotebook: boolean;
  content: string;
  version: number;
  persistedVersion: number;
  /** Version of the oldest edit still present in `history`. */
  historyBase: number;
  history: Array<{
    version: number;
    userId: string;
    socketId: string;
    editId?: string;
    operation: TextOperation;
    baseLength: number;
  }>;
  editsSinceSnapshot: number;
  lastSnapshotAt: number;
  participants: Set<string>;
  evictTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  persistPromise?: Promise<any>;
  snapshotPromise?: Promise<void>;
}

// In-memory file version & operation state
const activeFiles = new Map<string, FileState>();
const loadingFiles = new Map<string, Promise<FileState>>();
let activeIO: SocketIOServer | undefined;

// Workspace online presence lists: workspaceId -> Map<socketId, UserPayload>
const workspacePresences = new Map<string, Map<string, UserPayload>>();

/** Hard cap on retained history so a long editing session cannot grow forever. */
const MAX_HISTORY = 500;

/** Grace period before dropping in-memory state for a file nobody has open. */
const EVICT_GRACE_MS = 60_000;

/** Snapshot cadence for the Snapshots panel. */
const SNAPSHOT_EVERY_EDITS = 50;
const SNAPSHOT_EVERY_MS = 2 * 60 * 1000;

/** Debounce window for DB + disk persistence of editor changes. */
const PERSIST_DEBOUNCE_MS = 1_000;

/**
 * Transform `edit` so it applies to a document that has already had `other`
 * applied to it.
 *
 * `editHasPriority` decides the outcome when both edits target the same offset.
 * Without a tie-break, two concurrent inserts at the same position could be
 * ordered differently on different clients and the documents would diverge.
 */
export function transformEdit(edit: TextEdit, other: TextEdit, editHasPriority: boolean): TextEdit {
  let newOffset = edit.offset;
  const lengthDelta = other.text.length - other.length;

  if (other.offset < edit.offset || (other.offset === edit.offset && !editHasPriority)) {
    if (other.offset + other.length <= edit.offset) {
      // `other` ended before this edit begins: shift by its net length change.
      newOffset += lengthDelta;
    } else {
      // Overlapping deletes: land at the end of the replacement text.
      newOffset = other.offset + other.text.length;
    }
  }

  return {
    offset: Math.max(0, newOffset),
    text: edit.text,
    length: edit.length,
  };
}

/** Clamps an edit so a stale or hostile offset cannot read/splice out of range. */
export function clampEdit(edit: TextEdit, contentLength: number): TextEdit {
  const offset = Math.min(Math.max(0, Number.isFinite(edit.offset) ? Math.floor(edit.offset) : 0), contentLength);
  const length = Math.min(Math.max(0, Number.isFinite(edit.length) ? Math.floor(edit.length) : 0), contentLength - offset);
  return { offset, length, text: typeof edit.text === 'string' ? edit.text : '' };
}

export function getActiveFileContent(fileId: string): string | undefined {
  return activeFiles.get(fileId)?.content;
}

export function updateActiveFileName(fileId: string, name: string): void {
  const update = (state: FileState) => { state.isNotebook = name.toLowerCase().endsWith('.ipynb'); };
  const state = activeFiles.get(fileId);
  if (state) update(state);
  else void loadingFiles.get(fileId)?.then(update).catch(() => undefined);
}

function isNotebookContent(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return !!parsed && typeof parsed === 'object' && 'cells' in parsed && Array.isArray(parsed.cells);
  } catch {
    return false;
  }
}

export function broadcastWorkspaceFilesChanged(workspaceId: string): void {
  activeIO?.to(`workspace:${workspaceId}`).emit('workspace_files_changed', { workspaceId });
}

export function forgetActiveFiles(fileIds: string[]): void {
  for (const fileId of fileIds) {
    const state = activeFiles.get(fileId);
    if (state?.persistTimer) clearTimeout(state.persistTimer);
    if (state?.evictTimer) clearTimeout(state.evictTimer);
    activeFiles.delete(fileId);
    loadingFiles.delete(fileId);
    activeIO?.to(`file:${fileId}`).emit('file_deleted', { fileId });
  }
}

/** Joins and HTTP replacements must share initialization before either writes. */
function loadFileState(fileId: string, workspaceId: string): Promise<FileState> {
  let loading = loadingFiles.get(fileId);
  if (!loading) {
    loading = (async () => {
      const dbItem = await prisma.fileSystemItem.findUnique({ where: { id: fileId } });
      if (!dbItem || dbItem.type !== 'FILE' || dbItem.workspaceId !== workspaceId) throw new AuthzError('File not found');
      // A delete can finish while this DB read is pending. Its result
      // must not recreate the in-memory state we just discarded.
      if (loadingFiles.get(fileId) !== loading) throw new AuthzError('File not found');
      const state: FileState = {
        workspaceId,
        isNotebook: dbItem.name?.toLowerCase().endsWith('.ipynb') ?? false,
        content: dbItem.content || '',
        version: 0,
        persistedVersion: 0,
        historyBase: 0,
        history: [],
        editsSinceSnapshot: 0,
        lastSnapshotAt: Date.now(),
        participants: new Set<string>(),
      };
      activeFiles.set(fileId, state);
      return state;
    })().finally(() => {
      if (loadingFiles.get(fileId) === loading) loadingFiles.delete(fileId);
    });
    loadingFiles.set(fileId, loading);
  }
  return loading;
}

function recordOperation(fileState: FileState, operation: TextOperation, userId: string, socketId: string, editId?: string): void {
  const baseLength = fileState.content.length;
  fileState.content = applyOperation(fileState.content, operation);
  fileState.version += 1;
  fileState.editsSinceSnapshot += 1;
  fileState.history.push({ version: fileState.version, userId, socketId, editId, operation, baseLength });
  if (fileState.history.length > MAX_HISTORY) {
    const excess = fileState.history.length - MAX_HISTORY;
    fileState.history.splice(0, excess);
    fileState.historyBase += excess;
  }
}

/** Serialize writes so an older slow autosave cannot overwrite a newer edit. */
function persistFile(fileId: string, state: FileState): Promise<any> {
  if (state.persistTimer) clearTimeout(state.persistTimer);
  state.persistTimer = undefined;
  const content = state.content;
  const version = state.version;
  const write = (state.persistPromise ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const updated = await prisma.fileSystemItem.update({ where: { id: fileId }, data: { content } });
    await syncFileToDisk(fileId, state.workspaceId, content);
    state.persistedVersion = version;
    activeIO?.to(`file:${fileId}`).emit('file_saved', { fileId, version });
    return updated;
  });
  state.persistPromise = write;
  return write;
}

function schedulePersistence(fileId: string, state: FileState, retryAttempt = 0): void {
  if (state.persistTimer) clearTimeout(state.persistTimer);
  state.persistTimer = setTimeout(() => {
    void persistFile(fileId, state).catch((error) => {
      console.error(`Failed to persist socket edit for file ${fileId}:`, error);
      activeIO?.to(`file:${fileId}`).emit('file_save_error', { fileId, message: 'Changes could not be saved. Please retry.' });
      if (retryAttempt < 3 && activeFiles.get(fileId) === state) {
        schedulePersistence(fileId, state, retryAttempt + 1);
      }
    });
  }, PERSIST_DEBOUNCE_MS * 2 ** retryAttempt);
  state.persistTimer.unref?.();
}

/** HTTP replacements use the same history as edits, including snapshot restores. */
export async function replaceFileContent(fileId: string, workspaceId: string, content: string, userId: string): Promise<any> {
  const state = activeFiles.get(fileId) ?? await loadFileState(fileId, workspaceId);
  const operation = operationFromSplices(state.content.length, [{ offset: 0, length: state.content.length, text: content }]);
  recordOperation(state, operation, userId, `http:${userId}`);
  activeIO?.to(`file:${fileId}`).emit('file_edit', { fileId, operation, version: state.version, userId, socketId: `http:${userId}` });
  broadcastWorkspaceFilesChanged(workspaceId);
  try {
    return await persistFile(fileId, state);
  } catch (error) {
    schedulePersistence(fileId, state, 1);
    throw error;
  } finally {
    // Replacements can initialize files that no socket ever opens.
    scheduleEviction(fileId, userId);
  }
}

/** Writes a FileVersion row so normal socket editing populates the Snapshots panel. */
async function snapshotFile(fileId: string, userId: string): Promise<void> {
  const fileState = activeFiles.get(fileId);
  if (!fileState || fileState.editsSinceSnapshot === 0) return;
  if (fileState.snapshotPromise) return fileState.snapshotPromise;
  const content = fileState.content;
  const edits = fileState.editsSinceSnapshot;
  fileState.snapshotPromise = (async () => { try {
    const count = await prisma.fileVersion.count({ where: { fileId } });
    await prisma.fileVersion.create({
      data: {
        fileId,
        content,
        version: count + 1,
        userId,
      },
    });
    fileState.editsSinceSnapshot -= edits;
    fileState.lastSnapshotAt = Date.now();
  } catch (err) {
    console.error(`Failed to snapshot file ${fileId}:`, err);
  } finally { fileState.snapshotPromise = undefined; } })();
  return fileState.snapshotPromise;
}

/** Send persisted editor text to its dedicated container, never to the API filesystem. */
async function syncFileToDisk(fileId: string, workspaceId: string, content: string): Promise<void> {
  const runtime = connectedRuntime(workspaceId);
  if (!runtime) return;
  try {
    const items = await prisma.fileSystemItem.findMany({ where: { workspaceId } });
    const index = items.findIndex(item => item.id === fileId);
    if (index < 0) return;
    const relative = workspaceFiles(items)[index].path;
    await runtime.request('write-file', { path: relative, content });
  } catch (error) {
    // Database persistence has succeeded. A runtime outage cannot turn a saved
    // edit into an unsaved one; a later runtime start materializes the database.
    console.warn('Workspace runtime mirror failed:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Schedules removal of in-memory state once nobody has the file open. Without
 * this, activeFiles retained every file ever opened for the process lifetime.
 */
function scheduleEviction(fileId: string, userId: string): void {
  const fileState = activeFiles.get(fileId);
  if (!fileState || fileState.participants.size > 0) return;

  if (fileState.evictTimer) clearTimeout(fileState.evictTimer);

  fileState.evictTimer = setTimeout(async () => {
    const current = activeFiles.get(fileId);
    if (!current || current.participants.size > 0) return;

    // Snapshot before discarding, otherwise the last edits never reach history.
    await snapshotFile(fileId, userId);
    try {
      await persistFile(fileId, current);
      // A participant may have rejoined while the writes were running.
      if (current.participants.size === 0 && activeFiles.get(fileId) === current) {
        // An HTTP replacement can also arrive without adding a participant.
        // Keep its current content available until its own save completes.
        if (current.persistedVersion === current.version) activeFiles.delete(fileId);
        else scheduleEviction(fileId, userId);
      }
    } catch (error) {
      console.error(`Failed to persist file ${fileId} before eviction:`, error);
      scheduleEviction(fileId, userId);
    }
  }, EVICT_GRACE_MS);

  // Do not hold the event loop open for an idle eviction timer.
  fileState.evictTimer.unref?.();
}

export function initSocketServer(httpServer: HTTPServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      // Reuse the same normalized allowlist as the HTTP layer (app.ts) so the
      // WebSocket upgrade cannot drift from it. Passing the raw config array
      // here would do exact-string matching against values that may carry
      // trailing slashes, casing, or invisible characters the HTTP path
      // already strips. A request with no Origin (non-browser client) is
      // allowed through, matching the HTTP behaviour.
      origin: (origin, callback) => {
        if (!origin || originAllowlist.isAllowed(origin)) return callback(null, true);
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    },
  });
  activeIO = io;
  initializeRuntimeGateway(io);

  // Socket Authentication Middleware
  io.use((socket: Socket, next) => {
    // Only the auth payload. Tokens in the query string end up in proxy access
    // logs and browser history.
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication error: Missing token'));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.accessSecret) as any;
      socket.data.user = {
        id: decoded.userId,
        name: decoded.name,
        email: decoded.email,
      };
      next();
    } catch {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const currentUser = socket.data.user as UserPayload;
    console.info(`⚡ User connected to socket: ${currentUser.name} (${currentUser.email})`);

    /** Files this socket has joined, so we can release them on disconnect. */
    const joinedFiles = new Set<string>();
    let eventQueue = Promise.resolve();

    // Socket.IO preserves arrival order, but independent async authorization
    // calls did not: a leave or edit could overtake a file initialization.
    function enqueue(event: string, action: () => Promise<void>, fileId?: string): void {
      eventQueue = eventQueue.then(async () => {
        if (socket.connected) await action();
      }).catch((error) => denied(event, error, fileId));
    }

    function denied(event: string, err: unknown, fileId?: string): void {
      const message = err instanceof AuthzError ? err.message : 'Request failed';
      if (!(err instanceof AuthzError)) {
        console.error(`Socket handler ${event} failed:`, err);
      } else {
        console.warn(`🚫 Denied ${event} for ${currentUser.email}: ${message}`);
      }
      socket.emit('authz_error', { event, message, fileId });
    }

    /**
     * Registers a workspace-scoped handler that runs only after the caller's
     * role has been verified. Deny by default: any handler registered through
     * this helper cannot execute for a non-member.
     */
    function onWorkspace(
      event: string,
      roles: WorkspaceRole[],
      handler: (payload: any, role: WorkspaceRole) => void | Promise<void>,
    ): void {
      socket.on(event, (payload: any = {}, acknowledge?: unknown) => {
        enqueue(event, async () => {
          const reply = typeof acknowledge === 'function' ? acknowledge : undefined;
          try {
            const role = await requireWorkspaceRole(currentUser.id, payload?.workspaceId, roles);
            if (!socket.connected) return;
            await handler(payload, role);
            reply?.({ success: true });
          } catch (error) {
            reply?.({ success: false, error: error instanceof AuthzError ? error.message : 'Request failed. Please try again.' });
            throw error;
          }
        });
      });
    }

    /** Same, for file-scoped handlers: fileId is resolved to its workspace first. */
    function onFile(
      event: string,
      roles: WorkspaceRole[],
      handler: (payload: any, ctx: { workspaceId: string; role: WorkspaceRole }) => void | Promise<void>,
    ): void {
      socket.on(event, (payload: any = {}) => {
        const handle = async () => {
          const ctx = await requireFileRole(currentUser.id, payload?.fileId, roles);
          if (socket.connected) await handler(payload, ctx);
        };
        // Read-only cursor presence must not hold up edits while its auth
        // lookup is waiting on the database. Content and room changes remain
        // ordered through the queue above.
        if (event === 'cursor_move') void handle().catch(error => denied(event, error, payload?.fileId));
        else enqueue(event, handle, payload?.fileId);
      });
    }

    // Register execution handlers
    registerExecutionHandlers(io, socket);

    // ----------------------------------------------------
    // WORKSPACE PRESENCE HANDLERS
    // ----------------------------------------------------
    onWorkspace('join_workspace', READ_ROLES, ({ workspaceId }) => {
      socket.join(`workspace:${workspaceId}`);

      if (!workspacePresences.has(workspaceId)) {
        workspacePresences.set(workspaceId, new Map());
      }
      workspacePresences.get(workspaceId)!.set(socket.id, currentUser);

      const activeUsers = Array.from(workspacePresences.get(workspaceId)!.values());
      io.to(`workspace:${workspaceId}`).emit('workspace_users', activeUsers);

      console.info(`👥 User ${currentUser.name} joined workspace room: ${workspaceId}`);
    });

    onWorkspace('leave_workspace', READ_ROLES, ({ workspaceId }) => {
      socket.leave(`workspace:${workspaceId}`);

      if (workspacePresences.has(workspaceId)) {
        workspacePresences.get(workspaceId)!.delete(socket.id);
        const activeUsers = Array.from(workspacePresences.get(workspaceId)!.values());
        io.to(`workspace:${workspaceId}`).emit('workspace_users', activeUsers);
      }

      console.info(`👥 User ${currentUser.name} left workspace room: ${workspaceId}`);
    });

    // ----------------------------------------------------
    // WORKSPACE CHAT HANDLERS
    // ----------------------------------------------------
    onWorkspace('chat_message', READ_ROLES, async ({ workspaceId, message }) => {
      if (!message || typeof message !== 'string' || message.trim() === '') {
        throw new AuthzError('Message content is required');
      }
      if (message.trim().length > 4000) {
        throw new AuthzError('Messages must be 4,000 characters or fewer.');
      }

      const newMessage = await prisma.chatMessage.create({
        data: {
          workspaceId,
          userId: currentUser.id,
          message: message.trim(),
        },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      io.to(`workspace:${workspaceId}`).emit('chat_message', newMessage);
    });

    onWorkspace('typing_status', READ_ROLES, ({ workspaceId, isTyping }) => {
      socket.to(`workspace:${workspaceId}`).emit('typing_status', {
        userId: currentUser.id,
        name: currentUser.name,
        isTyping: Boolean(isTyping),
      });
    });

    // ----------------------------------------------------
    // REAL-TIME COLLABORATIVE EDITOR SYNC
    // ----------------------------------------------------
    onFile('join_file', READ_ROLES, async ({ fileId, sinceVersion }, { workspaceId }) => {
      const fileState = activeFiles.get(fileId) ?? await loadFileState(fileId, workspaceId);
      if (!socket.connected) {
        scheduleEviction(fileId, currentUser.id);
        return;
      }
      socket.join(`file:${fileId}`);
      joinedFiles.add(fileId);

      // Someone is back: cancel any pending eviction.
      if (fileState.evictTimer) {
        clearTimeout(fileState.evictTimer);
        fileState.evictTimer = undefined;
      }
      fileState.participants.add(socket.id);

      socket.emit('file_init', {
        fileId,
        content: fileState.content,
        version: fileState.version,
        persistedVersion: fileState.persistedVersion,
        operations: Number.isInteger(sinceVersion) && sinceVersion >= fileState.historyBase && sinceVersion <= fileState.version
          ? fileState.history.filter(entry => entry.version > sinceVersion).map(({ baseLength: _baseLength, ...entry }) => entry)
          : undefined,
      });
    });

    onFile('leave_file', READ_ROLES, ({ fileId }) => {
      socket.leave(`file:${fileId}`);
      joinedFiles.delete(fileId);

      const fileState = activeFiles.get(fileId);
      if (fileState) {
        fileState.participants.delete(socket.id);
        scheduleEviction(fileId, currentUser.id);
      }

      console.info(`📝 User ${currentUser.name} left file room: ${fileId}`);
    });

    onFile('save_file', WRITE_ROLES, async ({ fileId }) => {
      const fileState = activeFiles.get(fileId);
      if (!fileState || !joinedFiles.has(fileId)) throw new AuthzError('Join the file before saving');
      try {
        await persistFile(fileId, fileState);
      } catch {
        socket.emit('file_save_error', { fileId, message: 'Changes could not be saved. Please retry.' });
        schedulePersistence(fileId, fileState, 1);
      }
    });

    onFile('edit_file', WRITE_ROLES, async ({ fileId, baseVersion, edit, operation, editId }) => {
      const fileState = activeFiles.get(fileId);
      if (!fileState || !joinedFiles.has(fileId)) throw new AuthzError('Join the file before editing');
      const resync = (conflict = false) => {
        socket.emit('file_resync', {
          fileId,
          content: fileState.content,
          version: fileState.version,
          persistedVersion: fileState.persistedVersion,
          ...(conflict ? {
            conflict: true,
            message: 'Concurrent notebook changes could not be merged. Your version was preserved.',
          } : {}),
        });
      };
      // A retried packet after reconnect must not insert its text twice.
      const duplicate = typeof editId === 'string'
        ? fileState.history.find(entry => entry.editId === editId && entry.userId === currentUser.id)
        : undefined;
      if (duplicate) {
        socket.emit('file_edit_ack', { fileId, ...duplicate, content: fileState.content });
        if (fileState.persistedVersion < fileState.version) schedulePersistence(fileId, fileState);
        return;
      }
      if (!Number.isInteger(baseVersion) || baseVersion < fileState.historyBase || baseVersion > fileState.version) {
        resync();
        return;
      }
      const baseLength = baseVersion === fileState.version
        ? fileState.content.length
        : fileState.history[baseVersion - fileState.historyBase].baseLength;
      let transformed: TextOperation;
      try {
        transformed = operation ?? operationFromSplices(baseLength, [edit]);
        if (operationBaseLength(transformed) !== baseLength) throw new Error('Invalid base length');
        // History has priority at equal insert positions. The client uses the
        // identical transform against its outstanding operation and buffer.
        for (const previous of fileState.history.slice(baseVersion - fileState.historyBase)) {
          transformed = transformOperations(previous.operation, transformed)[1];
        }
        // Text OT can concatenate independently added cells without JSON
        // separators. Keep the last valid notebook and let the sender recover
        // its draft instead of saving corruption or retrying the same merge.
        if (fileState.isNotebook && isNotebookContent(fileState.content) &&
            !isNotebookContent(applyOperation(fileState.content, transformed))) {
          resync(true);
          return;
        }
        recordOperation(fileState, transformed, currentUser.id, socket.id, typeof editId === 'string' ? editId : undefined);
      } catch {
        resync();
        return;
      }
      const accepted = {
        fileId,
        operation: transformed,
        version: fileState.version,
        userId: currentUser.id,
        socketId: socket.id,
        editId,
      };
      socket.to(`file:${fileId}`).emit('file_edit', accepted);
      socket.emit('file_edit_ack', { ...accepted, content: fileState.content });
      schedulePersistence(fileId, fileState);

      const dueByCount = fileState.editsSinceSnapshot >= SNAPSHOT_EVERY_EDITS;
      const dueByTime = Date.now() - fileState.lastSnapshotAt >= SNAPSHOT_EVERY_MS;
      if (dueByCount || dueByTime) {
        void snapshotFile(fileId, currentUser.id);
      }
    });

    // ----------------------------------------------------
    // CURSOR PRESENCE HANDLERS
    // ----------------------------------------------------
    onFile('cursor_move', READ_ROLES, ({ fileId, cursor }) => {
      if (!joinedFiles.has(fileId)) return;
      socket.to(`file:${fileId}`).emit('cursor_update', {
        fileId,
        socketId: socket.id,
        userId: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        cursor,
      });
    });

    // ----------------------------------------------------
    // DISCONNECTION HANDLERS
    // ----------------------------------------------------
    socket.on('disconnect', () => {
      console.info(`⚡ User disconnected from socket: ${currentUser.name}`);

      for (const [workspaceId, map] of workspacePresences.entries()) {
        if (map.has(socket.id)) {
          map.delete(socket.id);
          const activeUsers = Array.from(map.values());
          io.to(`workspace:${workspaceId}`).emit('workspace_users', activeUsers);
          console.info(`👥 User ${currentUser.name} auto-removed from workspace: ${workspaceId}`);
        }

        // Stop tracking empty workspaces so the presence map does not grow.
        if (map.size === 0) workspacePresences.delete(workspaceId);
      }

      // Release file state held by this socket.
      for (const fileId of joinedFiles) {
        const fileState = activeFiles.get(fileId);
        if (!fileState) continue;
        fileState.participants.delete(socket.id);
        scheduleEviction(fileId, currentUser.id);
      }
      joinedFiles.clear();
    });
  });

  return io;
}
