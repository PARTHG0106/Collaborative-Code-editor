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

      // Execute natively on the backend server
      const { execSync, spawn } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncscript-exec-'));
      let compileCmd = null;
      let runCmd = '';
      let runArgs: string[] = [];
      let sourceFile = '';
      
      if (language === 'cpp' || language === 'c') {
        const ext = language === 'cpp' ? 'cpp' : 'c';
        const compiler = language === 'cpp' ? 'g++' : 'gcc';
        sourceFile = path.join(tmpDir, `main.${ext}`);
        const outFile = path.join(tmpDir, 'main.out');
        fs.writeFileSync(sourceFile, code);
        compileCmd = `${compiler} ${sourceFile} -o ${outFile}`;
        runCmd = outFile;
      } else if (language === 'python') {
        sourceFile = path.join(tmpDir, 'main.py');
        fs.writeFileSync(sourceFile, code);
        runCmd = 'python3';
        runArgs = [sourceFile];
      } else if (language === 'javascript') {
        sourceFile = path.join(tmpDir, 'main.js');
        fs.writeFileSync(sourceFile, code);
        runCmd = 'node';
        runArgs = [sourceFile];
      } else if (language === 'java') {
        sourceFile = path.join(tmpDir, 'Main.java');
        fs.writeFileSync(sourceFile, code);
        compileCmd = `javac ${sourceFile}`;
        runCmd = 'java';
        runArgs = ['-cp', tmpDir, 'Main'];
      } else {
        throw new Error(`Native remote execution not implemented for language: ${language}`);
      }

      let exitCode = 0;

      try {
        if (compileCmd) {
          try {
            execSync(compileCmd, { stdio: 'pipe' });
          } catch (e: any) {
            io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: (e.stderr ? e.stderr.toString() : e.message) + '\n', timestamp: Date.now() });
            throw e;
          }
        }

        await new Promise<void>((resolve, reject) => {
          const proc = spawn(runCmd, runArgs, { cwd: tmpDir });
          
          proc.stdout.on('data', (data: Buffer) => {
            io.to(`exec:${session.id}`).emit('execution:stdout', { sessionId: session.id, data: data.toString(), timestamp: Date.now() });
          });
          
          proc.stderr.on('data', (data: Buffer) => {
            io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: data.toString(), timestamp: Date.now() });
          });

          proc.on('close', (code: number) => {
            exitCode = code;
            resolve();
          });

          proc.on('error', (err: Error) => {
            io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: err.message + '\n', timestamp: Date.now() });
            exitCode = 1;
            resolve();
          });
        });

      } catch (err) {
        exitCode = 1;
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
