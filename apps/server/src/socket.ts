import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import jwt from 'jsonwebtoken';
import { config } from './config/index.js';
import prisma from './lib/prisma.js';
import { registerExecutionHandlers } from './execution/executionSocket.js';
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

interface FileState {
  content: string;
  version: number;
  /** Version of the oldest edit still present in `history`. */
  historyBase: number;
  history: Array<{
    version: number;
    userId: string;
    edit: TextEdit;
  }>;
  editsSinceSnapshot: number;
  lastSnapshotAt: number;
  participants: Set<string>;
  evictTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
}

// In-memory file version & operation state
const activeFiles = new Map<string, FileState>();

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
function transformEdit(edit: TextEdit, other: TextEdit, editHasPriority: boolean): TextEdit {
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
function clampEdit(edit: TextEdit, contentLength: number): TextEdit {
  const offset = Math.min(Math.max(0, Math.floor(edit.offset ?? 0)), contentLength);
  const length = Math.min(Math.max(0, Math.floor(edit.length ?? 0)), contentLength - offset);
  return { offset, length, text: typeof edit.text === 'string' ? edit.text : '' };
}

/** Writes a FileVersion row so normal socket editing populates the Snapshots panel. */
async function snapshotFile(fileId: string, userId: string): Promise<void> {
  const fileState = activeFiles.get(fileId);
  if (!fileState || fileState.editsSinceSnapshot === 0) return;

  try {
    const count = await prisma.fileVersion.count({ where: { fileId } });
    await prisma.fileVersion.create({
      data: {
        fileId,
        content: fileState.content,
        version: count + 1,
        userId,
      },
    });
    fileState.editsSinceSnapshot = 0;
    fileState.lastSnapshotAt = Date.now();
  } catch (err) {
    console.error(`Failed to snapshot file ${fileId}:`, err);
  }
}

/** Mirrors a file to the workspace temp dir used by the terminal and runners. */
async function syncFileToDisk(fileId: string, workspaceId: string, content: string): Promise<void> {
  const wsDir = path.join(os.tmpdir(), `syncscript_ws_${workspaceId}`);
  if (!fs.existsSync(wsDir)) return;

  const allFiles = await prisma.fileSystemItem.findMany({ where: { workspaceId } });
  const fileMap = new Map<string, any>();
  allFiles.forEach((f: any) => fileMap.set(f.id, f));

  const relativePath = (function resolvePath(id: string): string {
    const f = fileMap.get(id);
    if (!f) return '';
    if (!f.parentId) return f.name;
    return path.join(resolvePath(f.parentId), f.name);
  })(fileId);

  if (!relativePath) return;

  const fullPath = path.join(wsDir, relativePath);
  // Never let a crafted name escape the workspace directory.
  if (!path.resolve(fullPath).startsWith(path.resolve(wsDir) + path.sep)) return;

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content);
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
    if (current.persistTimer) clearTimeout(current.persistTimer);
    activeFiles.delete(fileId);
  }, EVICT_GRACE_MS);

  // Do not hold the event loop open for an idle eviction timer.
  fileState.evictTimer.unref?.();
}

export function initSocketServer(httpServer: HTTPServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    },
  });

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

    function denied(event: string, err: unknown): void {
      const message = err instanceof AuthzError ? err.message : 'Request failed';
      if (!(err instanceof AuthzError)) {
        console.error(`Socket handler ${event} failed:`, err);
      } else {
        console.warn(`🚫 Denied ${event} for ${currentUser.email}: ${message}`);
      }
      socket.emit('authz_error', { event, message });
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
      socket.on(event, async (payload: any = {}) => {
        try {
          const role = await requireWorkspaceRole(currentUser.id, payload?.workspaceId, roles);
          await handler(payload, role);
        } catch (err) {
          denied(event, err);
        }
      });
    }

    /** Same, for file-scoped handlers: fileId is resolved to its workspace first. */
    function onFile(
      event: string,
      roles: WorkspaceRole[],
      handler: (payload: any, ctx: { workspaceId: string; role: WorkspaceRole }) => void | Promise<void>,
    ): void {
      socket.on(event, async (payload: any = {}) => {
        try {
          const ctx = await requireFileRole(currentUser.id, payload?.fileId, roles);
          await handler(payload, ctx);
        } catch (err) {
          denied(event, err);
        }
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
    onWorkspace('chat_message', WRITE_ROLES, async ({ workspaceId, message }) => {
      if (!message || typeof message !== 'string' || message.trim() === '') {
        return;
      }

      const newMessage = await prisma.chatMessage.create({
        data: {
          workspaceId,
          userId: currentUser.id,
          message: message.slice(0, 4000),
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
    onFile('join_file', READ_ROLES, async ({ fileId }) => {
      socket.join(`file:${fileId}`);
      joinedFiles.add(fileId);
      console.info(`📝 User ${currentUser.name} joined file room: ${fileId}`);

      let fileState = activeFiles.get(fileId);
      if (!fileState) {
        const dbItem = await prisma.fileSystemItem.findUnique({ where: { id: fileId } });
        fileState = {
          content: dbItem?.content || '',
          version: 0,
          historyBase: 0,
          history: [],
          editsSinceSnapshot: 0,
          lastSnapshotAt: Date.now(),
          participants: new Set<string>(),
        };
        activeFiles.set(fileId, fileState);
      }

      // Someone is back: cancel any pending eviction.
      if (fileState.evictTimer) {
        clearTimeout(fileState.evictTimer);
        fileState.evictTimer = undefined;
      }
      fileState.participants.add(socket.id);

      socket.emit('file_init', {
        content: fileState.content,
        version: fileState.version,
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

    onFile('edit_file', WRITE_ROLES, async ({ fileId, baseVersion, edit }, { workspaceId }) => {
      const fileState = activeFiles.get(fileId);
      if (!fileState) {
        socket.emit('error', 'File state not initialized');
        return;
      }

      if (!edit || typeof edit !== 'object') return;

      const base = Number.isInteger(baseVersion) ? baseVersion : fileState.version;

      // History is capped, so a client that is further behind than the retained
      // window cannot be transformed correctly. Resync instead of corrupting.
      if (base < fileState.historyBase) {
        socket.emit('file_resync', {
          fileId,
          content: fileState.content,
          version: fileState.version,
        });
        return;
      }

      let transformed = clampEdit(edit as TextEdit, fileState.content.length);

      if (base < fileState.version) {
        console.info(
          `⚔️ Conflict detected for file ${fileId}. Client v${base} vs Server v${fileState.version}`,
        );

        for (let v = base; v < fileState.version; v++) {
          const hist = fileState.history[v - fileState.historyBase];
          if (!hist) continue;

          // A client applies its own edits locally before sending them, so its
          // offsets already account for them; transforming again would
          // double-count. Only other users' concurrent edits are unseen.
          if (hist.userId === currentUser.id) continue;

          // Deterministic tie-break at equal offsets, consistent on every peer.
          const editHasPriority = currentUser.id < hist.userId;
          transformed = transformEdit(transformed, hist.edit, editHasPriority);
        }

        transformed = clampEdit(transformed, fileState.content.length);
      }

      const beforeContent = fileState.content;
      const afterContent =
        beforeContent.slice(0, transformed.offset) +
        transformed.text +
        beforeContent.slice(transformed.offset + transformed.length);

      fileState.content = afterContent;

      fileState.history.push({
        version: fileState.version,
        userId: currentUser.id,
        edit: transformed,
      });

      // Drop the oldest entries once the cap is exceeded, tracking the base
      // version so indexes stay correct.
      if (fileState.history.length > MAX_HISTORY) {
        const excess = fileState.history.length - MAX_HISTORY;
        fileState.history.splice(0, excess);
        fileState.historyBase += excess;
      }

      fileState.version += 1;
      fileState.editsSinceSnapshot += 1;

      socket.to(`file:${fileId}`).emit('file_edit', {
        fileId,
        edit: transformed,
        version: fileState.version,
        userId: currentUser.id,
      });

      socket.emit('file_edit_ack', {
        fileId,
        version: fileState.version,
      });

      // Debounce persistence: this used to run a DB update plus a full
      // workspace tree read and disk write on every single keystroke.
      if (fileState.persistTimer) clearTimeout(fileState.persistTimer);
      fileState.persistTimer = setTimeout(async () => {
        const current = activeFiles.get(fileId);
        if (!current) return;

        try {
          await prisma.fileSystemItem.update({
            where: { id: fileId },
            data: { content: current.content },
          });
          await syncFileToDisk(fileId, workspaceId, current.content);
        } catch (err) {
          console.error(`Failed to persist socket edit for file ${fileId}:`, err);
        }
      }, PERSIST_DEBOUNCE_MS);
      fileState.persistTimer.unref?.();

      const dueByCount = fileState.editsSinceSnapshot >= SNAPSHOT_EVERY_EDITS;
      const dueByTime = Date.now() - fileState.lastSnapshotAt >= SNAPSHOT_EVERY_MS;
      if (dueByCount || dueByTime) {
        await snapshotFile(fileId, currentUser.id);
      }
    });

    // ----------------------------------------------------
    // CURSOR PRESENCE HANDLERS
    // ----------------------------------------------------
    onFile('cursor_move', READ_ROLES, ({ fileId, cursor }) => {
      socket.to(`file:${fileId}`).emit('cursor_update', {
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
