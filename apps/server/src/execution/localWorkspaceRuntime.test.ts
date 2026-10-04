import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateWorkspaceUid, getLocalRuntime, LOCAL_MIRROR_SCRIPT, LocalWorkspaceRuntime, workspaceJailKey } from './localWorkspaceRuntime.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  input = '';
  constructor(readonly pid: number, readonly args: string[]) {
    super();
    this.stdin.on('data', chunk => { this.input += chunk.toString(); });
  }
}
class Pty {
  readonly pid = 1000;
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
  data: (data: string) => void = () => {};
  exit: (event: { exitCode: number; signal?: number }) => void = () => {};
  onData(callback: (data: string) => void) { this.data = callback; }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void) { this.exit = callback; }
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const identity = { root: '/var/lib/syncscript/workspaces/trusted-hash', uid: 200000, gid: 200000 };

describe('same-Space local sandbox runtime', () => {
  let runtime: LocalWorkspaceRuntime;
  let children: Child[];
  let pty: Pty;
  let ptySpawn: ReturnType<typeof vi.fn>;
  let usage: ReturnType<typeof vi.fn>;
  let holdFiles: boolean;
  let mirrorBackups: string[];
  const command = (child: Child) => child.args[child.args.indexOf('--') + 1];
  const fileHelpers = () => children.filter(child => child.args.includes('/usr/local/lib/syncscript/safe-files.py'));
  const mirrors = () => children.filter(child => child.args.includes(LOCAL_MIRROR_SCRIPT));
  const cleanupCalls = () => mocks.spawn.mock.calls.filter(([, args]) => args.includes('--kill-workspace'));
  const stages = () => children.filter(child => child.args.includes('--') && !child.args.includes('/usr/local/lib/syncscript/safe-files.py') && !child.args.includes('-I'));
  const finishHelper = (child: Child) => { child.stdout.write('{"ok":true}'); child.emit('close', 0, null); };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    children = [];
    holdFiles = false;
    mirrorBackups = [];
    pty = new Pty();
    ptySpawn = vi.fn(() => pty);
    usage = vi.fn(async () => ({ rss: 0, disk: 0 }));
    mocks.spawn.mockImplementation((_executable: string, args: string[]) => {
      const child = new Child(2000 + children.length, args);
      children.push(child);
      void Promise.resolve().then(() => {
        child.emit('spawn');
        if (args.includes(LOCAL_MIRROR_SCRIPT)) {
          child.stdout.write(JSON.stringify({ ok: true, backups: mirrorBackups, backupCount: mirrorBackups.length }));
          child.emit('close', 0, null);
        } else if (args.includes('--kill-workspace') || args.includes('-c')) child.emit('close', 0, null);
        else if (args.includes('/usr/local/lib/syncscript/safe-files.py') && !holdFiles) finishHelper(child);
      });
      return child;
    });
    runtime = new LocalWorkspaceRuntime('workspace', identity, { loadPty: async () => ptySpawn, usage, idleMs: 1000, monitorMs: 100 });
  });
  afterEach(async () => { await runtime.close(); await flush(); vi.useRealTimers(); });

  it('launches interactive shells only through the fixed sandbox binary with a cleared host environment', async () => {
    vi.stubEnv('DATABASE_URL', 'must-not-reach-shell');
    vi.stubEnv('HF_TOKEN', 'must-not-reach-shell');
    await runtime.request('terminal:spawn', { terminalId: 'terminal', cols: 120, rows: 40 });
    expect(ptySpawn).toHaveBeenCalledWith('/usr/local/bin/syncscript-sandbox', [
      '--root', identity.root, '--uid', '200000', '--gid', '200000', '--cwd', '/workspace', '--', '/bin/bash', '--noprofile', '--norc', '-i',
    ], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } });
    await runtime.request('terminal:data', { terminalId: 'terminal', data: '\x03\x1b[A\t' });
    expect(pty.write).toHaveBeenCalledWith('\x03\x1b[A\t');
    await runtime.request('terminal:resize', { terminalId: 'terminal', cols: 999, rows: 0 });
    expect(pty.resize).toHaveBeenCalledWith(500, 1);
    vi.unstubAllEnvs();
  });

  it('runs all filesystem helpers unprivileged inside the jail and in isolated Python mode', async () => {
    await runtime.request('sync', { files: [{ path: 'src/main.py', type: 'FILE', content: 'print(42)' }], preserveExisting: true });
    const helper = mirrors()[0];
    expect(command(helper)).toBe('/usr/bin/python3');
    expect(helper.args.slice(-3)).toEqual(['-I', '-c', LOCAL_MIRROR_SCRIPT]);
    expect(JSON.parse(helper.input)).toEqual({ files: [{ path: 'src/main.py', type: 'FILE', content: 'print(42)' }], expected: { 'src/main.py': null } });
    expect(mocks.spawn.mock.calls.every(([file]) => file === '/usr/local/bin/syncscript-sandbox')).toBe(true);
    await expect(runtime.request('sync', { files: [{ path: '../outside', type: 'FILE', content: 'bad' }] })).rejects.toThrow('Invalid workspace file path');
    await expect(runtime.request('sync', { files: [{ path: '/etc/passwd', type: 'FILE', content: 'bad' }] })).rejects.toThrow('Invalid workspace file path');
    expect(mirrors()).toHaveLength(1);
  });

  it('reconciles fresh DB content and only skips active sync files whose editor version is unchanged', async () => {
    const file = { path: 'main.py', type: 'FILE', content: 'old editor content' };
    await runtime.request('sync', { files: [file], preserveExisting: true });
    expect(JSON.parse(mirrors()[0].input).expected).toEqual({ 'main.py': null });
    await runtime.request('sync', { files: [file], preserveExisting: true });
    expect(mirrors()).toHaveLength(1);
    await runtime.request('sync', { files: [{ ...file, content: 'new editor content' }], preserveExisting: true });
    const update = JSON.parse(mirrors()[1].input);
    expect(update.files[0].content).toBe('new editor content');
    expect(update.expected['main.py']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports preserved terminal edits immediately or when the first terminal opens', async () => {
    const notice = vi.fn();
    runtime.on('terminal-output', notice);
    mirrorBackups = ['main.py.syncscript-backup-first'];
    await runtime.request('sync', { files: [{ path: 'main.py', type: 'FILE', content: 'editor content' }] });
    expect(notice).not.toHaveBeenCalled();
    await runtime.request('terminal:spawn', { terminalId: 'terminal' });
    expect(notice).toHaveBeenCalledWith({ terminalId: 'terminal', data: expect.stringContaining('/workspace/main.py.syncscript-backup-first') });
    mirrorBackups = ['main.py.syncscript-backup-second'];
    await runtime.request('write-file', { path: 'main.py', content: 'new editor content' });
    expect(notice).toHaveBeenLastCalledWith({ terminalId: 'terminal', data: expect.stringContaining('/workspace/main.py.syncscript-backup-second') });
  });

  it('does not resurrect a terminal closed while the native PTY module is loading', async () => {
    await runtime.close();
    const loading = deferred<() => Pty>();
    runtime = new LocalWorkspaceRuntime('workspace', identity, { loadPty: () => loading.promise, usage, idleMs: 1000 });
    const opening = runtime.request('terminal:spawn', { terminalId: 'pending' });
    const rejected = expect(opening).rejects.toThrow('closed while starting');
    await runtime.request('terminal:close', { terminalId: 'pending' });
    loading.resolve(ptySpawn);
    await rejected;
    expect(ptySpawn).not.toHaveBeenCalled();
    await expect(runtime.request('terminal:spawn', { terminalId: 'pending' })).rejects.toThrow('has been closed');
  });

  it('tombstones close/cancel received before their corresponding start', async () => {
    await runtime.request('terminal:close', { terminalId: 'late' });
    await expect(runtime.request('terminal:spawn', { terminalId: 'late' })).rejects.toThrow('closed');
    await runtime.request('execution:cancel', { executionId: 'late' });
    await expect(runtime.request('execution:start', { executionId: 'late', language: 'python', code: 'pass' })).rejects.toThrow('cancelled');
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(fileHelpers()).toHaveLength(0);
  });

  it('executes a temporary editor snapshot without overwriting terminal edits in the source file', async () => {
    await runtime.request('execution:start', { executionId: 'run', language: 'python', code: 'print("editor")', path: 'src/main.py' });
    const writes = fileHelpers().flatMap(helper => JSON.parse(helper.input).files as Array<{ path: string; content?: string }>);
    expect(writes.some(file => file.path === 'src/main.py')).toBe(false);
    const snapshot = writes.find(file => file.content === 'print("editor")')!;
    expect(snapshot.path).toMatch(/^src\/\.syncscript-[a-f0-9-]+\.py$/);
    const process = stages()[0];
    expect(command(process)).toBe('/usr/bin/python3');
    expect(process.args.at(-1)).toBe('/workspace/' + snapshot.path);
    expect(mocks.spawn.mock.calls.every(([file]) => file === '/usr/local/bin/syncscript-sandbox')).toBe(true);
    await runtime.request('execution:stdin', { executionId: 'run', data: 'answer\n' });
    expect(process.input).toBe('answer\n');
    process.emit('close', 0, null);
    await flush();
    const cleanup = children.find(child => child.args.includes('-c'))!;
    expect(cleanup.args).toContain('-I');
    expect(cleanup.args).toContain('/workspace/' + snapshot.path);
  });

  it('cancels before file preparation completes without spawning user code', async () => {
    holdFiles = true;
    const starting = runtime.request('execution:start', { executionId: 'run', language: 'python', code: 'print(42)', path: 'main.py' });
    const rejected = expect(starting).rejects.toThrow('cancelled while preparing');
    await flush();
    await runtime.request('execution:cancel', { executionId: 'run' });
    finishHelper(fileHelpers()[0]);
    await rejected;
    expect(stages()).toHaveLength(0);
    expect(fileHelpers()).toHaveLength(1);
  });

  it('keeps compiler and program stages inside the same jail and does not start the next stage after cancellation', async () => {
    await runtime.request('execution:start', { executionId: 'cpp', language: 'cpp', code: 'int main(){}', path: 'src/main.cpp' });
    expect(command(stages()[0])).toBe('/usr/bin/g++');
    const compiler = stages()[0];
    compiler.emit('close', 0, null);
    await flush();
    expect(command(stages()[1])).toMatch(/^\/tmp\/run-[a-f0-9-]+\/program$/);
    await runtime.request('execution:cancel', { executionId: 'cpp' });
    expect(cleanupCalls().some(([, args]) => args.includes('--process-group') && args.includes(String(stages()[1].pid)))).toBe(true);

    await runtime.request('execution:start', { executionId: 'cancelled-c', language: 'c', code: 'int main(){}' });
    const nextCompiler = stages()[2];
    await runtime.request('execution:cancel', { executionId: 'cancelled-c' });
    nextCompiler.emit('close', 0, null);
    await flush();
    expect(stages()).toHaveLength(3);
  });

  it('bounds output and runtime and uses kernel UID checks for cleanup signals', async () => {
    const exits = vi.fn();
    runtime.on('execution-exit', exits);
    await runtime.request('execution:start', { executionId: 'noisy', language: 'javascript', code: 'while(true)console.log(1)' });
    stages()[0].stdout.write(Buffer.alloc(513 * 1024, 'x'));
    expect(exits).toHaveBeenCalledWith({ executionId: 'noisy', exitCode: 1 });
    await runtime.request('execution:start', { executionId: 'slow', language: 'python', code: 'while True: pass' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exits).toHaveBeenCalledWith({ executionId: 'slow', exitCode: 124 });
    expect(cleanupCalls().every(([, args]) => args.includes('--uid') && args.includes('200000'))).toBe(true);
  });

  it.each(['rss', 'disk', 'accounting'])('closes the entire UID sandbox on %s budget failure', async reason => {
    await runtime.request('terminal:spawn', { terminalId: 'terminal' });
    const disconnected = vi.fn();
    runtime.on('disconnected', disconnected);
    if (reason === 'accounting') usage.mockRejectedValue(new Error('Cannot account for resources'));
    else usage.mockResolvedValue({ rss: reason === 'rss' ? 513 * 1024 * 1024 : 0, disk: reason === 'disk' ? 257 * 1024 * 1024 : 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.connected).toBe(false);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(cleanupCalls().some(([, args]) => !args.includes('--process-group'))).toBe(true);
    await expect(runtime.request('terminal:spawn', { terminalId: 'new' })).rejects.toThrow('closed');
  });

  it('reserves startup slots before awaits and enforces concurrency and payload limits', async () => {
    const loading = deferred<() => Pty>();
    await runtime.close();
    runtime = new LocalWorkspaceRuntime('workspace', identity, { loadPty: () => loading.promise, usage, idleMs: 1000 });
    const opens = Array.from({ length: 8 }, (_, index) => runtime.request('terminal:spawn', { terminalId: `terminal-${index}` }));
    await expect(runtime.request('terminal:spawn', { terminalId: 'ninth' })).rejects.toThrow('eight terminals');
    loading.resolve(ptySpawn);
    await Promise.all(opens);
    await expect(runtime.request('terminal:data', { terminalId: 'terminal-0', data: 'x'.repeat(65537) })).rejects.toThrow('64 KiB');
    await expect(runtime.request('execution:start', { executionId: 'oversize', language: 'python', code: 'x'.repeat(262145) })).rejects.toThrow('256 KiB');
  });

  it('preserves distinct persistent workspace UIDs and rejects duplicate or malformed registry entries', () => {
    const first = workspaceJailKey('workspace-a');
    const second = workspaceJailKey('workspace-b');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('workspace-a');
    const registry = { version: 1 as const, workspaces: {} as Record<string, number> };
    expect(allocateWorkspaceUid(registry, first)).toBe(200000);
    expect(allocateWorkspaceUid(registry, second)).toBe(200001);
    expect(allocateWorkspaceUid(JSON.parse(JSON.stringify(registry)), first)).toBe(200000);
    expect(() => allocateWorkspaceUid({ version: 1, workspaces: { [first]: 200000, [second]: 200000 } }, first)).toThrow('duplicate');
    expect(() => workspaceJailKey('../host')).toThrow('Invalid');
    expect(() => allocateWorkspaceUid(registry, '../outside')).toThrow('Invalid');
  });

  it('fails closed when the platform cannot provide the native sandbox', async () => {
    const getuid = process.getuid ? vi.spyOn(process as unknown as { getuid(): number }, 'getuid').mockReturnValue(1000) : undefined;
    try {
      await expect(getLocalRuntime('unavailable-native-sandbox')).rejects.toThrow('requires Linux');
      expect(ptySpawn).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally { getuid?.mockRestore(); }
  });
});
