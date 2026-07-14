import { Server as SocketIOServer, Socket } from 'socket.io';
import prisma from '../lib/prisma.js';

const activeProcesses = new Map<string, any>();

/**
 * Execution socket event handlers.
 * These handle remote execution requests from the frontend when
 * neither browser nor local agent execution is available.
 */
export function registerExecutionHandlers(io: SocketIOServer, socket: Socket) {
  const user = socket.data.user as { id: string; name: string; email: string };

  socket.on('execution:stdin', (payload: { data: string }) => {
    const proc = activeProcesses.get(socket.id);
    if (proc && proc.stdin) {
      proc.stdin.write(payload.data);
    }
  });

  // User starts a remote execution
  socket.on('execution:start', async (payload: {
    workspaceId: string;
    fileId: string;
    language: string;
    code: string;
    target?: string;
  }) => {
    const { workspaceId, fileId, language, code, target = 'REMOTE' } = payload;

    try {
      // Create execution session record
      const session = await prisma.executionSession.create({
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
          if (!['python', 'cpp', 'c', 'javascript', 'typescript', 'java'].includes(language)) {
            throw new Error(`GPU worker currently does not support ${language} execution.`);
          }

          // Fetch an available GPU worker
          const worker = await prisma.executionWorker.findFirst({
            where: { type: 'GPU', status: 'IDLE' },
            orderBy: { lastHeartbeat: 'desc' }
          });

          if (!worker) {
            throw new Error('No GPU workers currently available. Please try again later.');
          }

          // Mark worker as busy
          await prisma.executionWorker.update({
            where: { id: worker.id },
            data: { status: 'BUSY', activeJobs: { increment: 1 } }
          });

          try {
            // Check if HF_TOKEN is present
            if (!process.env.HF_TOKEN) {
              throw new Error('HF_TOKEN is missing in the backend server environment variables. Please add it as a secret in your Hugging Face Space settings to authenticate and unlock your ZeroGPU quota.');
            }

            // Call the Gradio API endpoint
            const { Client } = require('@gradio/client');
            const client = await Client.connect(worker.url, { 
              token: process.env.HF_TOKEN 
            });
            
            const result = await client.predict('/execute', [
              code, 
              language 
            ]);

            const { stdout, stderr, exitCode: workerExitCode } = result.data[0];

            if (stdout) io.to(`exec:${session.id}`).emit('execution:stdout', { sessionId: session.id, data: stdout, timestamp: Date.now() });
            if (stderr) io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: stderr, timestamp: Date.now() });
            
            exitCode = workerExitCode;
          } finally {
            // Free the worker
            await prisma.executionWorker.update({
              where: { id: worker.id },
              data: { status: 'IDLE', activeJobs: { decrement: 1 }, lastHeartbeat: new Date() }
            });
          }
        } catch (e: any) {
          io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: e.message + '\n', timestamp: Date.now() });
          exitCode = 1;
        }
      } else {
        // Execute natively on the backend server (CPU/Remote)
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
          activeProcesses.set(socket.id, proc);
          
          let outputSize = 0;
          const MAX_SIZE = 1024 * 512; // 512 KB
          let isKilled = false;

          const timeout = setTimeout(() => {
            isKilled = true;
            proc.kill('SIGKILL');
            io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: '\n[Execution Timeout: 20 seconds exceeded]\n', timestamp: Date.now() });
          }, 20000);

          proc.stdout.on('data', (data: Buffer) => {
            if (isKilled) return;
            outputSize += data.length;
            if (outputSize > MAX_SIZE) {
              isKilled = true;
              proc.kill('SIGKILL');
              io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: '\n[Execution Error: Output size limit exceeded]\n', timestamp: Date.now() });
              return;
            }
            io.to(`exec:${session.id}`).emit('execution:stdout', { sessionId: session.id, data: data.toString(), timestamp: Date.now() });
          });
          
          proc.stderr.on('data', (data: Buffer) => {
            if (isKilled) return;
            outputSize += data.length;
            if (outputSize > MAX_SIZE) {
              isKilled = true;
              proc.kill('SIGKILL');
              io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: '\n[Execution Error: Output size limit exceeded]\n', timestamp: Date.now() });
              return;
            }
            io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: data.toString(), timestamp: Date.now() });
          });

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
              io.to(`exec:${session.id}`).emit('execution:stderr', { sessionId: session.id, data: err.message + '\n', timestamp: Date.now() });
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
      } // <-- end of else block

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
      console.error('Execution start error:', err);
      socket.emit('execution:failed', {
        error: err.message || 'Failed to create execution session',
      });
      // Try to let the UI know if it was hanging
      socket.emit('execution:stderr', {
        sessionId: 'unknown',
        data: `Backend execution error: ${err.message}\r\n`,
        timestamp: Date.now()
      });
      socket.emit('execution:completed', {
        sessionId: 'unknown',
        exitCode: 1,
        durationMs: 0,
        target: 'remote'
      });
    }
  });

  // User sends stdin to a running execution
  socket.on('execution:stdin', ({ sessionId, data }: { sessionId: string; data: string }) => {
    io.to(`exec:${sessionId}`).emit('execution:stdin', { sessionId, data });
    
    // Attempt to write to the local process if it exists
    const proc = activeProcesses.get(socket.id);
    if (proc && proc.stdin) {
      try { proc.stdin.write(data); } catch {}
    }
  });

  // Shell command when no execution is running
  socket.on('terminal:command', ({ command }: { command: string }) => {
    const { exec } = require('child_process');
    // Using an arbitrary tmpDir or workspace dir. For safety, just use process.cwd() or similar.
    exec(command, { cwd: process.cwd() }, (err: any, stdout: string, stderr: string) => {
      if (stdout) socket.emit('terminal:output', { data: stdout });
      if (stderr) socket.emit('terminal:output', { data: `\x1b[31m${stderr}\x1b[0m` });
      if (err && err.code) socket.emit('terminal:output', { data: `\r\n\x1b[31m[Process exited with code ${err.code}]\x1b[0m\r\n` });
    });
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
