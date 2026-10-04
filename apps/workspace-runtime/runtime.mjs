import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const EXECUTION_LIMIT_MS = 20_000;
const TERMINAL_LIFETIME_MS = 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const LANGUAGES = new Set(['python', 'javascript', 'typescript', 'c', 'cpp', 'java']);
const FILE_HELPER = fileURLToPath(new URL('./safe-files.py', import.meta.url));

export function workspacePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new Error('Invalid workspace path');
  }
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.length > 64 || segments.some((part) => !part || part === '.' || part === '..' || /[:\0]/.test(part))) {
    throw new Error('Invalid workspace path');
  }
  return normalized;
}

function validId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function dimension(value, fallback, maximum) {
  return Number.isInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
}

export function commandEnvironment(root) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    PWD: root,
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/bash',
    PS1: '\\w\\$ ',
    PYTHONUNBUFFERED: '1',
  };
}

export class WorkspaceRuntime {
  constructor({ root, emit, ptySpawn, executionTimeoutMs = EXECUTION_LIMIT_MS, outputLimit = OUTPUT_LIMIT }) {
    this.root = path.resolve(root);
    this.emit = emit;
    this.ptySpawn = ptySpawn;
    this.executionTimeoutMs = executionTimeoutMs;
    this.outputLimit = outputLimit;
    this.identity = process.platform === 'linux' && process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {};
    this.executions = new Map();
    this.terminals = new Map();
    this.fileQueue = Promise.resolve();
  }

  async prepareRoot() {
    await fs.mkdir(this.root, { recursive: true });
    if (this.identity.uid !== undefined) {
      await fs.chown(this.root, this.identity.uid, this.identity.gid);
      await fs.chmod(this.root, 0o755);
    }
  }

  async request(action, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid payload');
    switch (action) {
      case 'sync': return this.writeFiles(payload.files, payload.preserveExisting === true);
      case 'write-file': return this.writeFiles([{ path: payload.path, content: payload.content, type: 'FILE' }]);
      case 'terminal:spawn': return this.spawnTerminal(payload);
      case 'terminal:data': {
        const terminal = this.requireTerminal(payload.terminalId);
        if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 64 * 1024) throw new Error('Terminal input too large');
        terminal.pty.write(payload.data);
        return {};
      }
      case 'terminal:resize': {
        this.requireTerminal(payload.terminalId).pty.resize(dimension(payload.cols, 80, 500), dimension(payload.rows, 24, 200));
        return {};
      }
      case 'terminal:close': {
        this.closeTerminal(payload.terminalId);
        return {};
      }
      case 'execution:start': return this.startExecution(payload);
      case 'execution:stdin': {
        const job = this.executions.get(validId(payload.executionId, 'execution ID'));
        if (!job || !job.process?.stdin?.writable) throw new Error('Execution is not accepting input');
        if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 8192) throw new Error('Execution input too large');
        job.process.stdin.write(payload.data);
        return {};
      }
      case 'execution:cancel': {
        const job = this.executions.get(validId(payload.executionId, 'execution ID'));
        if (job) this.stopExecution(job, 130);
        return {};
      }
      default: throw new Error('Unknown runtime action');
    }
  }

  async writeFiles(files, preserveExisting = false) {
    if (!Array.isArray(files) || files.length > 5000) throw new Error('Invalid workspace file list');
    let bytes = 0;
    const validated = files.map((file) => {
      if (!file || !['FILE', 'FOLDER'].includes(file.type)) throw new Error('Invalid workspace file');
      const name = workspacePath(file.path);
      if (file.type === 'FILE' && typeof file.content !== 'string') throw new Error('Invalid file content');
      const content = file.type === 'FILE' ? file.content : '';
      bytes += Buffer.byteLength(content);
      if (bytes > 20 * 1024 * 1024) throw new Error('Workspace sync exceeds 20 MiB');
      return { path: name, type: file.type, content };
    });
    const operation = this.fileQueue.catch(() => {}).then(async () => {
      await this.prepareRoot();
      await new Promise((resolve, reject) => {
        const identity = this.identity.uid === undefined ? [] : [String(this.identity.uid), String(this.identity.gid)];
        const child = spawn('python3', [FILE_HELPER, this.root, ...identity], { stdio: ['pipe', 'pipe', 'pipe'], env: commandEnvironment(this.root) });
        let output = '';
        let errorOutput = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Workspace file sync timed out')); }, 30_000);
        child.stdout.on('data', (chunk) => { if (output.length < 8192) output += chunk.toString(); });
        child.stderr.on('data', (chunk) => { if (errorOutput.length < 8192) errorOutput += chunk.toString(); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.stdin.on('error', () => {});
        child.on('close', (code) => {
          clearTimeout(timer);
          let parsed;
          try { parsed = JSON.parse(output); } catch { /* Report a bounded helper failure below. */ }
          if (code === 0 && parsed?.ok) resolve();
          else reject(new Error(parsed?.error || errorOutput || 'Workspace file sync failed'));
        });
        child.stdin.end(JSON.stringify({ files: validated, preserveExisting }));
      });
      return { count: validated.length };
    });
    this.fileQueue = operation;
    return operation;
  }

  requireTerminal(id) {
    const terminal = this.terminals.get(validId(id, 'terminal ID'));
    if (!terminal) throw new Error('Terminal is closed');
    return terminal;
  }

  async spawnTerminal(payload) {
    const terminalId = validId(payload.terminalId, 'terminal ID');
    if (this.terminals.has(terminalId)) return { terminalId };
    if (this.terminals.size >= 8) throw new Error('This workspace already has eight terminals');
    await this.prepareRoot();
    const spawnPty = this.ptySpawn || (await import('node-pty')).spawn;
    const pty = spawnPty('/bin/bash', ['--noprofile', '--norc', '-i'], {
      name: 'xterm-256color',
      cols: dimension(payload.cols, 80, 500),
      rows: dimension(payload.rows, 24, 200),
      cwd: this.root,
      env: commandEnvironment(this.root),
      ...this.identity,
    });
    const entry = { pty, bytes: 0, interval: null, lifetime: null };
    entry.interval = setInterval(() => { entry.bytes = 0; }, 1000);
    entry.lifetime = setTimeout(() => {
      this.emit('runtime:terminal-output', { terminalId, data: '\r\nTerminal lifetime reached. Open another terminal to continue.\r\n' });
      this.closeTerminal(terminalId);
    }, TERMINAL_LIFETIME_MS);
    entry.interval.unref?.();
    entry.lifetime.unref?.();
    this.terminals.set(terminalId, entry);
    pty.onData((data) => {
      entry.bytes += Buffer.byteLength(data);
      if (entry.bytes > 1024 * 1024) {
        this.emit('runtime:terminal-output', { terminalId, data: '\r\nTerminal output exceeded 1 MiB/second; terminal closed.\r\n' });
        this.closeTerminal(terminalId);
      } else this.emit('runtime:terminal-output', { terminalId, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      clearInterval(entry.interval);
      clearTimeout(entry.lifetime);
      this.terminals.delete(terminalId);
      this.emit('runtime:terminal-exit', { terminalId, exitCode, signal });
    });
    return { terminalId };
  }

  closeTerminal(id) {
    const terminalId = validId(id, 'terminal ID');
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    clearInterval(entry.interval);
    clearTimeout(entry.lifetime);
    this.terminals.delete(terminalId);
    // node-pty creates a session on Unix; kill the process group as well so
    // foreground/background commands cannot outlive an explicitly closed PTY.
    if (process.platform !== 'win32' && entry.pty.pid) {
      try { process.kill(-entry.pty.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    try { entry.pty.kill('SIGKILL'); } catch { /* Already exited. */ }
  }

  async startExecution(payload) {
    const executionId = validId(payload.executionId, 'execution ID');
    if (this.executions.has(executionId)) throw new Error('Execution ID is already active');
    if (this.executions.size >= 4) throw new Error('This workspace already has four executions');
    if (!LANGUAGES.has(payload.language)) throw new Error('Unsupported execution language');
    if (typeof payload.code !== 'string' || Buffer.byteLength(payload.code) > SOURCE_LIMIT) throw new Error('Source exceeds 256 KiB');
    await this.prepareRoot();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'syncscript-run-'));
    const extension = { python: 'py', javascript: 'js', typescript: 'ts', c: 'c', cpp: 'cpp', java: 'java' }[payload.language];
    let source = path.join(temporary, payload.language === 'java' ? 'Main.java' : `main.${extension}`);
    try {
      if (payload.path) {
        const relative = workspacePath(payload.path);
        await this.writeFiles([{ path: relative, type: 'FILE', content: payload.code }]);
        source = path.join(this.root, ...relative.split('/'));
      } else await fs.writeFile(source, payload.code);
      // Keep the fresh directory root-owned until the source write finishes.
      // Otherwise a running shell could replace main.py with a symlink before
      // this privileged broker writes it.
      if (this.identity.uid !== undefined) await fs.chown(temporary, this.identity.uid, this.identity.gid);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
    const executable = path.join(temporary, 'program');
    const stages = {
      python: [['python3', [source]]],
      javascript: [['node', [source]]],
      typescript: [['tsx', [source]]],
      c: [['gcc', [source, '-o', executable]], [executable, []]],
      cpp: [['g++', [source, '-o', executable]], [executable, []]],
      java: [['javac', ['-d', temporary, source]], ['java', ['-cp', temporary, path.basename(source, '.java')]]],
    }[payload.language];
    const job = { id: executionId, temporary, bytes: 0, process: null, finished: false, timer: null };
    this.executions.set(executionId, job);
    job.timer = setTimeout(() => {
      this.emit('runtime:execution-output', { executionId, channel: 'stderr', data: '\nExecution time limit exceeded.\n' });
      this.stopExecution(job, 124);
    }, this.executionTimeoutMs);
    try {
      await this.launchStage(job, stages, 0);
    } catch (error) {
      this.stopExecution(job, 1);
      throw error;
    }
    return { executionId };
  }

  launchStage(job, stages, index) {
    return new Promise((resolve, reject) => {
      const [command, args] = stages[index];
      const child = spawn(command, args, {
        cwd: this.root, env: commandEnvironment(this.root),
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        ...this.identity,
      });
      job.process = child;
      child.once('spawn', resolve);
      child.once('error', (error) => {
        if (!job.finished) this.emit('runtime:execution-output', { executionId: job.id, channel: 'stderr', data: `${error.message}\n` });
        this.finishExecution(job, 1);
        reject(error);
      });
      child.stdin.on('error', () => {});
      for (const channel of ['stdout', 'stderr']) {
        child[channel].on('data', (chunk) => {
          if (job.finished) return;
          const remaining = this.outputLimit - job.bytes;
          if (remaining > 0) {
            const part = chunk.subarray(0, remaining);
            this.emit('runtime:execution-output', { executionId: job.id, channel, data: part.toString('utf8') });
            job.bytes += part.length;
          }
          if (chunk.length > remaining) {
            this.emit('runtime:execution-output', { executionId: job.id, channel: 'stderr', data: '\nExecution output limit exceeded.\n' });
            this.stopExecution(job, 1);
          }
        });
      }
      child.once('close', (code, signal) => {
        if (job.finished) return;
        // Kill any children left behind by this stage, even after its leader
        // exits successfully. Detached processes belong to this workspace only.
        this.killProcess(child);
        if (code === 0 && index + 1 < stages.length) {
          this.launchStage(job, stages, index + 1).catch(() => {});
        } else this.finishExecution(job, signal ? 1 : (code ?? 1));
      });
    });
  }

  killProcess(child) {
    if (!child?.pid) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
  }

  stopExecution(job, code) {
    if (job.finished) return;
    this.killProcess(job.process);
    this.finishExecution(job, code);
  }

  finishExecution(job, code) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    this.executions.delete(job.id);
    this.emit('runtime:execution-exit', { executionId: job.id, exitCode: code });
    fs.rm(job.temporary, { recursive: true, force: true }).catch(() => {});
  }

  close() {
    for (const terminalId of [...this.terminals.keys()]) this.closeTerminal(terminalId);
    for (const job of [...this.executions.values()]) this.stopExecution(job, 130);
  }
}
