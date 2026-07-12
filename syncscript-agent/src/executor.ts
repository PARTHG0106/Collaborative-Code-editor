import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

export interface ExecCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (code: number) => void;
}

interface LangConfig {
  extension: string;
  run: (file: string) => string[];
  compile?: (file: string) => string[];
}

const LANG_CONFIG: Record<string, LangConfig> = {
  javascript:  { extension: '.js',   run: (f) => ['node', f] },
  typescript:  { extension: '.ts',   run: (f) => ['npx', 'tsx', f] },
  python:      { extension: '.py',   run: (f) => [os.platform() === 'win32' ? 'python' : 'python3', f] },
  c:           { extension: '.c',
    compile: (f) => ['gcc', f, '-o', f.replace('.c', os.platform() === 'win32' ? '.exe' : '')],
    run: (f) => [f.replace('.c', os.platform() === 'win32' ? '.exe' : '')] },
  cpp:         { extension: '.cpp',
    compile: (f) => ['g++', f, '-o', f.replace('.cpp', os.platform() === 'win32' ? '.exe' : '')],
    run: (f) => [f.replace('.cpp', os.platform() === 'win32' ? '.exe' : '')] },
  java:        { extension: '.java',
    compile: (f) => ['javac', f],
    run: (f) => ['java', '-cp', path.dirname(f), path.basename(f, '.java')] },
  go:          { extension: '.go',   run: (f) => ['go', 'run', f] },
  rust:        { extension: '.rs',
    compile: (f) => ['rustc', f, '-o', f.replace('.rs', os.platform() === 'win32' ? '.exe' : '')],
    run: (f) => [f.replace('.rs', os.platform() === 'win32' ? '.exe' : '')] },
  php:         { extension: '.php',  run: (f) => ['php', f] },
  ruby:        { extension: '.rb',   run: (f) => ['ruby', f] },
  csharp:      { extension: '.cs',   run: (f) => ['dotnet', 'script', f] },
  kotlin:      { extension: '.kt',
    compile: (f) => ['kotlinc', f, '-include-runtime', '-d', f.replace('.kt', '.jar')],
    run: (f) => ['java', '-jar', f.replace('.kt', '.jar')] },
};

export class ProcessExecutor {
  private activeProcess: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private tmpDir: string | null = null;

  async execute(language: string, code: string, callbacks: ExecCallbacks): Promise<void> {
    const config = LANG_CONFIG[language];
    if (!config) {
      callbacks.onStderr(`Unsupported language: ${language}\n`);
      callbacks.onExit(1);
      return;
    }

    // Write to temp directory
    const id = crypto.randomBytes(6).toString('hex');
    this.tmpDir = path.join(os.tmpdir(), `syncscript-${id}`);
    fs.mkdirSync(this.tmpDir, { recursive: true });

    // For Java, class name must match filename
    let filename = `main${config.extension}`;
    if (language === 'java') {
      const classMatch = code.match(/public\s+class\s+(\w+)/);
      if (classMatch) filename = `${classMatch[1]}.java`;
    }

    const tmpFile = path.join(this.tmpDir, filename);
    fs.writeFileSync(tmpFile, code, 'utf-8');

    try {
      // Compile if needed
      if (config.compile) {
        const [cmd, ...args] = config.compile(tmpFile);
        const exitCode = await this.spawnAndWait(cmd, args, this.tmpDir, callbacks, false);
        if (exitCode !== 0) {
          callbacks.onExit(exitCode);
          return;
        }
      }

      // Run
      const [cmd, ...args] = config.run(tmpFile);
      this.activeProcess = spawn(cmd, args, {
        cwd: this.tmpDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 15-second timeout
      this.timeout = setTimeout(() => {
        callbacks.onStderr('\n[Execution timed out after 15 seconds]\n');
        this.kill();
      }, 15_000);

      this.activeProcess.stdout?.on('data', (d: Buffer) => callbacks.onStdout(d.toString()));
      this.activeProcess.stderr?.on('data', (d: Buffer) => callbacks.onStderr(d.toString()));

      await new Promise<void>((resolve) => {
        this.activeProcess!.on('close', (code) => {
          if (this.timeout) clearTimeout(this.timeout);
          callbacks.onExit(code ?? 1);
          resolve();
        });
      });
    } finally {
      this.cleanup();
    }
  }

  sendInput(data: string) {
    if (this.activeProcess?.stdin?.writable) {
      this.activeProcess.stdin.write(data + '\n');
    }
  }

  kill() {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGKILL');
      this.activeProcess = null;
    }
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private cleanup() {
    this.activeProcess = null;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.tmpDir) {
      try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch {}
      this.tmpDir = null;
    }
  }

  private spawnAndWait(
    cmd: string, args: string[], cwd: string,
    callbacks: ExecCallbacks, captureStdout: boolean
  ): Promise<number> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      if (captureStdout) proc.stdout?.on('data', (d: Buffer) => callbacks.onStdout(d.toString()));
      proc.stderr?.on('data', (d: Buffer) => callbacks.onStderr(d.toString()));
      proc.on('close', (code) => resolve(code ?? 1));
    });
  }
}
