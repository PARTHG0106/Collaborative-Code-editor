import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { config } from './config/index.js';
import prisma from './lib/prisma.js';

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
  history: Array<{
    version: number;
    userId: string;
    edit: TextEdit;
  }>;
}

// In-memory file version & operation state
const activeFiles = new Map<string, FileState>();

// Workspace online presence lists: workspaceId -> Map<socketId, UserPayload>
const workspacePresences = new Map<string, Map<string, UserPayload>>();

// Transform edit A against edit B (OT Transformation)
function transformEdit(edit: TextEdit, other: TextEdit): TextEdit {
  let newOffset = edit.offset;
  if (other.offset <= edit.offset) {
    const lengthDelta = other.text.length - other.length;
    if (other.offset + other.length <= edit.offset) {
      newOffset += lengthDelta;
    } else {
      // Overlap case: push offset to end of other edit
      newOffset = other.offset + other.text.length;
    }
  }
  return {
    offset: newOffset,
    text: edit.text,
    length: edit.length
  };
}

export function initSocketServer(httpServer: HTTPServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    }
  });

  // Socket Authentication Middleware
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication error: Missing token'));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.accessSecret) as UserPayload;
      socket.data.user = decoded;
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const currentUser = socket.data.user as UserPayload;
    console.info(`⚡ User connected to socket: ${currentUser.name} (${currentUser.email})`);

    // ----------------------------------------------------
    // WORKSPACE PRESENCE HANDLERS
    // ----------------------------------------------------
    socket.on('join_workspace', ({ workspaceId }) => {
      socket.join(`workspace:${workspaceId}`);
      
      // Update workspace presence map
      if (!workspacePresences.has(workspaceId)) {
        workspacePresences.set(workspaceId, new Map());
      }
      workspacePresences.get(workspaceId)!.set(socket.id, currentUser);

      // Broadcast active user list
      const activeUsers = Array.from(workspacePresences.get(workspaceId)!.values());
      io.to(`workspace:${workspaceId}`).emit('workspace_users', activeUsers);
      
      console.info(`👥 User ${currentUser.name} joined workspace room: ${workspaceId}`);
    });

    socket.on('leave_workspace', ({ workspaceId }) => {
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
    socket.on('chat_message', async ({ workspaceId, message }) => {
      if (!message || typeof message !== 'string' || message.trim() === '') {
        return;
      }

      try {
        const newMessage = await prisma.chatMessage.create({
          data: {
            workspaceId,
            userId: currentUser.id,
            message
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        });

        // Broadcast chat message to workspace room
        io.to(`workspace:${workspaceId}`).emit('chat_message', newMessage);
      } catch (err) {
        console.error('Failed to save chat message in socket:', err);
      }
    });

    socket.on('typing_status', ({ workspaceId, isTyping }) => {
      socket.to(`workspace:${workspaceId}`).emit('typing_status', {
        userId: currentUser.id,
        name: currentUser.name,
        isTyping
      });
    });

    // ----------------------------------------------------
    // REAL-TIME COLLABORATIVE EDITOR SYNC
    // ----------------------------------------------------
    socket.on('join_file', async ({ fileId }) => {
      socket.join(`file:${fileId}`);
      console.info(`📝 User ${currentUser.name} joined file room: ${fileId}`);

      // Load file from DB/memory
      let fileState = activeFiles.get(fileId);
      if (!fileState) {
        try {
          const dbItem = await prisma.fileSystemItem.findUnique({
            where: { id: fileId }
          });
          const initialContent = dbItem?.content || '';
          fileState = {
            content: initialContent,
            version: 0,
            history: []
          };
          activeFiles.set(fileId, fileState);
        } catch (err) {
          console.error(`Failed to load file ${fileId} on socket join:`, err);
          socket.emit('error', 'Failed to load file contents');
          return;
        }
      }

      // Send initial content & version
      socket.emit('file_init', {
        content: fileState.content,
        version: fileState.version
      });
    });

    socket.on('leave_file', ({ fileId }) => {
      socket.leave(`file:${fileId}`);
      console.info(`📝 User ${currentUser.name} left file room: ${fileId}`);
    });

    socket.on('edit_file', async ({ fileId, baseVersion, edit }) => {
      const fileState = activeFiles.get(fileId);
      if (!fileState) {
        socket.emit('error', 'File state not initialized');
        return;
      }

      const incomingEdit = edit as TextEdit;
      let transformed = { ...incomingEdit };

      // Conflict Resolution via Operational Transformation (OT)
      if (baseVersion < fileState.version) {
        console.info(`⚔️ Conflict detected for file ${fileId}. Client v${baseVersion} vs Server v${fileState.version}`);
        
        // Transform against history from baseVersion up to current
        for (let i = baseVersion; i < fileState.version; i++) {
          const hist = fileState.history[i];
          if (hist.userId !== currentUser.id) {
            transformed = transformEdit(transformed, hist.edit);
          }
        }
      }

      // Apply edit to server memory content
      const beforeContent = fileState.content;
      const afterContent = 
        beforeContent.slice(0, transformed.offset) + 
        transformed.text + 
        beforeContent.slice(transformed.offset + transformed.length);
      
      fileState.content = afterContent;
      
      // Save to history log
      const appliedVersion = fileState.version;
      fileState.history.push({
        version: appliedVersion,
        userId: currentUser.id,
        edit: transformed
      });

      fileState.version += 1;

      // Broadcast change & incremented version
      socket.to(`file:${fileId}`).emit('file_edit', {
        fileId,
        edit: transformed,
        version: fileState.version,
        userId: currentUser.id
      });

      // Confirm to sender
      socket.emit('file_edit_ack', {
        fileId,
        version: fileState.version
      });

      // Persist to DB asynchronously
      try {
        await prisma.fileSystemItem.update({
          where: { id: fileId },
          data: { content: afterContent }
        });
      } catch (err) {
        console.error(`Failed to persist socket edit for file ${fileId}:`, err);
      }
    });

    // ----------------------------------------------------
    // CURSOR PRESENCE HANDLERS
    // ----------------------------------------------------
    socket.on('cursor_move', ({ fileId, cursor }) => {
      socket.to(`file:${fileId}`).emit('cursor_update', {
        userId: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        cursor
      });
    });

    // ----------------------------------------------------
    // DISCONNECTION HANDLERS
    // ----------------------------------------------------
    socket.on('disconnect', () => {
      console.info(`⚡ User disconnected from socket: ${currentUser.name}`);
      
      // Clean up workspace presences
      for (const [workspaceId, map] of workspacePresences.entries()) {
        if (map.has(socket.id)) {
          map.delete(socket.id);
          const activeUsers = Array.from(map.values());
          io.to(`workspace:${workspaceId}`).emit('workspace_users', activeUsers);
          console.info(`👥 User ${currentUser.name} auto-removed from workspace: ${workspaceId}`);
        }
      }
    });
  });

  return io;
}
