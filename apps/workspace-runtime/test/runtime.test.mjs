import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandEnvironment, workspacePath, WorkspaceRuntime } from '../runtime.mjs';

const linux = process.platform === 'linux';
const available = (command) => linux && spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

async function fixture(callback, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-runtime-test-'));
  const events = [];
  const runtime = new WorkspaceRuntime({ root, emit: (name, payload) => events.push({ name, ...payload }), ...options });
  try { await callback({ root, runtime, events }); }
  finally {
    runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function waitFor(events, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for runtime event: ${JSON.stringify(events)}`);
}

test('workspace paths reject absolute paths, traversal, Windows drives and malformed segments', () => {
  for (const unsafe of ['/etc/passwd', '../secret', 'a/../../secret', 'C:\\secret', '\\\\host\\share', 'a//b', 'a/./b', 'x\0y', '', 'a/']) {
    assert.throws(() => workspacePath(unsafe), /Invalid workspace path/);
  }
  assert.equal(workspacePath('src\\hello world.py'), 'src/hello world.py');
});

test('child environment never inherits runtime, account, database or backend credentials', () => {
  const env = commandEnvironment('/workspace');
  assert.equal(env.HOME, '/workspace');
  assert.equal(env.PWD, '/workspace');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'PS1', 'PWD', 'PYTHONUNBUFFERED', 'SHELL', 'TERM', 'TMPDIR'].sort());
});

test('invalid actions, source, input and file paths fail before a process starts', async () => {
  await fixture(async ({ runtime }) => {
    await assert.rejects(runtime.request('unknown', {}), /Unknown runtime action/);
    await assert.rejects(runtime.request('execution:start', { executionId: '../x', language: 'python', code: 'pass' }), /Invalid execution ID/);
    await assert.rejects(runtime.request('execution:start', { executionId: 'x', language: 'shell', code: 'true' }), /Unsupported/);
    await assert.rejects(runtime.request('execution:start', { executionId: 'x', language: 'python', code: 'x'.repeat(256 * 1024 + 1) }), /256 KiB/);
    await assert.rejects(runtime.request('write-file', { path: '../secret', content: 'x' }), /Invalid workspace path/);
    await assert.rejects(runtime.request('terminal:data', { terminalId: 'closed', data: 'ls\r' }), /Terminal is closed/);
    assert.equal(runtime.executions.size, 0);
    assert.equal(runtime.terminals.size, 0);
  });
});

test('terminal supports input, resize, safe home and process closure', async () => {
  let exit;
  const fake = { pid: 0, writes: [], sizes: [], onData() {}, onExit(fn) { exit = fn; }, write(value) { this.writes.push(value); }, resize(...size) { this.sizes.push(size); }, kill() { exit({ exitCode: 0 }); } };
  await fixture(async ({ root, runtime, events }) => {
    await runtime.request('terminal:spawn', { terminalId: 'term1', cols: 120, rows: 30 });
    await runtime.request('terminal:data', { terminalId: 'term1', data: 'pwd\r' });
    await runtime.request('terminal:resize', { terminalId: 'term1', cols: 10000, rows: 0 });
    assert.deepEqual(fake.writes, ['pwd\r']);
    assert.deepEqual(fake.sizes, [[500, 1]]);
    await runtime.request('terminal:close', { terminalId: 'term1' });
    assert.equal(events.at(-1).name, 'runtime:terminal-exit');
    assert.equal(runtime.terminals.size, 0);
    assert.ok(root);
  }, { ptySpawn(command, args, options) { assert.equal(command, '/bin/bash'); assert.equal(options.env.HOME, options.cwd); assert.equal(options.cols, 120); return fake; } });
});

test('sync preserves terminal-created files and optionally keeps newer local content', { skip: !linux }, async () => {
  await fixture(async ({ root, runtime }) => {
    await runtime.request('sync', { files: [{ path: 'src', type: 'FOLDER' }, { path: 'src/main.py', type: 'FILE', content: 'initial' }] });
    await fs.writeFile(path.join(root, 'src/main.py'), 'terminal edit');
    await fs.writeFile(path.join(root, 'terminal.txt'), 'terminal file');
    await runtime.request('sync', { files: [{ path: 'src/main.py', type: 'FILE', content: 'old snapshot' }], preserveExisting: true });
    assert.equal(await fs.readFile(path.join(root, 'src/main.py'), 'utf8'), 'terminal edit');
    await runtime.request('write-file', { path: 'src/main.py', content: 'editor edit' });
    assert.equal(await fs.readFile(path.join(root, 'src/main.py'), 'utf8'), 'editor edit');
    assert.equal(await fs.readFile(path.join(root, 'terminal.txt'), 'utf8'), 'terminal file');
  });
});

test('file writes reject symlink parents and symlink destinations without touching their targets', { skip: !linux }, async () => {
  await fixture(async ({ root, runtime }) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-workspace-test-'));
    try {
      await fs.writeFile(path.join(outside, 'secret'), 'unchanged');
      await fs.symlink(outside, path.join(root, 'escape'));
      await fs.symlink(path.join(outside, 'secret'), path.join(root, 'linked'));
      await fs.link(path.join(outside, 'secret'), path.join(root, 'hard-linked'));
      await assert.rejects(runtime.request('write-file', { path: 'escape/secret', content: 'overwritten' }));
      await assert.rejects(runtime.request('write-file', { path: 'linked', content: 'overwritten' }));
      await assert.rejects(runtime.request('write-file', { path: 'hard-linked', content: 'overwritten' }));
      assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'unchanged');
      await runtime.request('write-file', { path: 'safe.txt', content: 'still usable' });
      assert.equal(await fs.readFile(path.join(root, 'safe.txt'), 'utf8'), 'still usable');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});

test('user code cannot read broker credentials through proc or root-owned files', { skip: !available('python3') || process.getuid?.() !== 0 }, async () => {
  await fixture(async ({ root, runtime, events }) => {
    const secret = path.join(root, 'broker-secret');
    await fs.writeFile(secret, 'must-not-be-readable', { mode: 0o600 });
    const code = `import os\nassert os.getuid() == 1000\nfor name in [${JSON.stringify(secret)}, "/proc/${process.pid}/environ"]:\n try:\n  open(name).read()\n  raise RuntimeError("broker credential readable")\n except PermissionError:\n  pass\nprint("credential-boundary-ok")`;
    await runtime.request('execution:start', { executionId: 'credentials', language: 'python', code });
    assert.equal((await waitFor(events, (event) => event.name === 'runtime:execution-exit')).exitCode, 0, JSON.stringify(events));
    assert.match(events.map((event) => event.data || '').join(''), /credential-boundary-ok/);
  });
});

const programs = [
  ['python', 'python3', 'print("runtime-ok")'],
  ['javascript', 'node', 'console.log("runtime-ok")'],
  ['typescript', 'tsx', 'const message: string = "runtime-ok"; console.log(message);'],
  ['c', 'gcc', '#include <stdio.h>\nint main(void) { puts("runtime-ok"); return 0; }'],
  ['cpp', 'g++', '#include <iostream>\nint main() { std::cout << "runtime-ok" << std::endl; }'],
  ['java', 'javac', 'public class Main { public static void main(String[] args) { System.out.println("runtime-ok"); } }'],
];
for (const [language, tool, code] of programs) {
  test(`${language} runs in the workspace and streams stdout before exit`, { skip: !available(tool) }, async () => {
    await fixture(async ({ runtime, events }) => {
      await runtime.request('execution:start', { executionId: `test-${language}`, language, code });
      const exit = await waitFor(events, (event) => event.name === 'runtime:execution-exit', 15_000);
      assert.equal(exit.exitCode, 0, JSON.stringify(events));
      assert.match(events.filter((event) => event.name === 'runtime:execution-output').map((event) => event.data).join(''), /runtime-ok/);
      assert.equal(runtime.executions.size, 0);
    });
  });
}

test('execution can read synced sibling files and accept stdin', { skip: !available('python3') }, async () => {
  await fixture(async ({ runtime, events }) => {
    await runtime.request('sync', { files: [{ path: 'data.txt', type: 'FILE', content: 'from-file' }] });
    await runtime.request('execution:start', { executionId: 'stdin', language: 'python', code: 'print(open("data.txt").read()); print(input())' });
    await waitFor(events, (event) => event.data?.includes('from-file'));
    await runtime.request('execution:stdin', { executionId: 'stdin', data: 'from-stdin\n' });
    assert.equal((await waitFor(events, (event) => event.name === 'runtime:execution-exit')).exitCode, 0);
    assert.match(events.map((event) => event.data || '').join(''), /from-stdin/);
  });
});

test('run command timeout emits one terminal result and kills its process', { skip: !available('python3') }, async () => {
  await fixture(async ({ runtime, events }) => {
    await runtime.request('execution:start', { executionId: 'timeout', language: 'python', code: 'import time; time.sleep(30)' });
    const exit = await waitFor(events, (event) => event.name === 'runtime:execution-exit');
    assert.equal(exit.exitCode, 124);
    assert.equal(events.filter((event) => event.name === 'runtime:execution-exit').length, 1);
    assert.equal(runtime.executions.size, 0);
  }, { executionTimeoutMs: 150 });
});

test('run command output is bounded and cancellation finishes once', { skip: !available('python3') }, async () => {
  await fixture(async ({ runtime, events }) => {
    await runtime.request('execution:start', { executionId: 'output', language: 'python', code: 'print("x" * 1000000)' });
    assert.equal((await waitFor(events, (event) => event.name === 'runtime:execution-exit')).exitCode, 1);
    const emitted = events.filter((event) => event.name === 'runtime:execution-output').reduce((size, event) => size + Buffer.byteLength(event.data), 0);
    assert.ok(emitted < 1100, `unexpected output size ${emitted}`);
    await runtime.request('execution:start', { executionId: 'cancel', language: 'python', code: 'import time; time.sleep(30)' });
    await runtime.request('execution:cancel', { executionId: 'cancel' });
    assert.equal((await waitFor(events, (event) => event.name === 'runtime:execution-exit' && event.executionId === 'cancel')).exitCode, 130);
    assert.equal(events.filter((event) => event.name === 'runtime:execution-exit' && event.executionId === 'cancel').length, 1);
  }, { outputLimit: 1024 });
});

test('actual PTY supports cd home, pipes, redirection and resize', { skip: !linux }, async () => {
  await fixture(async ({ root, runtime, events }) => {
    await runtime.request('terminal:spawn', { terminalId: 'real', cols: 80, rows: 24 });
    await runtime.request('terminal:data', { terminalId: 'real', data: 'cd /tmp; cd; printf "pipe-ok" | cat > terminal-output.txt; printf "PTY-DONE\\n"\r' });
    await waitFor(events, (event) => event.name === 'runtime:terminal-output' && event.data.includes('PTY-DONE'));
    // A shell echoes input before running it; wait for the redirected file too.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if (await fs.readFile(path.join(root, 'terminal-output.txt'), 'utf8') === 'pipe-ok') break; } catch { /* Shell has not reached redirection yet. */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await fs.readFile(path.join(root, 'terminal-output.txt'), 'utf8'), 'pipe-ok');
    await runtime.request('terminal:resize', { terminalId: 'real', cols: 123, rows: 37 });
    await runtime.request('terminal:close', { terminalId: 'real' });
    await waitFor(events, (event) => event.name === 'runtime:terminal-exit');
  });
});
