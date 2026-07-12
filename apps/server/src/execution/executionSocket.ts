import { Server as SocketIOServer, Socket } from 'socket.io';
import prisma from '../lib/prisma.js';

/**
 * Execution socket event handlers.
 * These handle remote execution requests from the frontend when
 * neither browser nor local agent execution is available.
 */
export function registerExecutionHandlers(io: SocketIOServer, socket: Socket) {
  const user = socket.data.user as { id: string; name: string; email: string };

  // User starts a remote execution
  socket.on('execution:start', async (payload: {
    workspaceId: string;
    fileId: string;
    language: string;
    code: string;
  }) => {
    const { workspaceId, fileId, language, code } = payload;

    try {
      // Create execution session record
      const session = await prisma.executionSession.create({
        data: {
          workspaceId,
          fileId,
          userId: user.id,
          language,
          code,
          target: 'REMOTE',
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
        target: 'remote',
      });

      // Update status to running
      await prisma.executionSession.update({
        where: { id: session.id },
        data: { status: 'RUNNING', startedAt: new Date() },
      });

      // Map standard languages to Piston API parameters
      const pistonLangMap: Record<string, string> = {
        c: 'c', cpp: 'cpp', java: 'java', python: 'python',
        javascript: 'javascript', typescript: 'typescript',
        go: 'go', rust: 'rust', php: 'php', ruby: 'ruby'
      };

      const pistonLang = pistonLangMap[language];

      if (!pistonLang) {
        throw new Error(`Remote execution not supported for language: ${language}`);
      }

      // Execute on Piston Public API
      const response = await fetch('https://emkc.org/api/v2/piston/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: pistonLang,
          version: '*', // Use latest available version
          files: [{ content: code }]
        })
      });

      const result = await response.json();

      let exitCode = 1;
      let durationMs = 0;

      if (result.compile && result.compile.stderr) {
        io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: result.compile.stderr + '\n', timestamp: Date.now() });
      }

      if (result.run) {
        if (result.run.stdout) {
          io.to(`exec:${session.id}`).emit('execution:stdout', { sessionId: session.id, data: result.run.stdout + (result.run.stdout.endsWith('\n') ? '' : '\n'), timestamp: Date.now() });
        }
        if (result.run.stderr) {
          io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: result.run.stderr + (result.run.stderr.endsWith('\n') ? '' : '\n'), timestamp: Date.now() });
        }
        exitCode = result.run.code || 0;
      } else if (result.message) {
        io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: result.message + '\n', timestamp: Date.now() });
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
        durationMs,
        target: 'remote',
      });
    } catch (err) {
      console.error('Execution start error:', err);
      socket.emit('execution:failed', {
        error: 'Failed to create execution session',
      });
    }
  });

  // User sends stdin to a running execution
  socket.on('execution:stdin', ({ sessionId, data }: { sessionId: string; data: string }) => {
    io.to(`exec:${sessionId}`).emit('execution:stdin', { sessionId, data });
  });

  // User cancels execution
  socket.on('execution:cancel', async ({ sessionId }: { sessionId: string }) => {
    try {
      await prisma.executionSession.update({
        where: { id: sessionId },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
      io.to(`exec:${sessionId}`).emit('execution:completed', {
        sessionId,
        exitCode: -1,
        durationMs: 0,
        target: 'remote',
      });
    } catch (err) {
      console.error('Execution cancel error:', err);
    }
  });

  // Collaborator watches an execution
  socket.on('execution:watch', ({ sessionId }: { sessionId: string }) => {
    socket.join(`exec:${sessionId}`);
  });

  socket.on('execution:unwatch', ({ sessionId }: { sessionId: string }) => {
    socket.leave(`exec:${sessionId}`);
  });
}
