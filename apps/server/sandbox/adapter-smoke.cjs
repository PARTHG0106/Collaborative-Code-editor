const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { getLocalRuntime, closeAllLocalRuntimes } = require(process.argv[2] || '/app/apps/server/dist/execution/localWorkspaceRuntime.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(message); await pause(25); }
}
async function run(runtime, id, language, code, file) {
  let output = '';
  let exit;
  const stdout = data => { if (data.executionId === id) output += data.data; };
  const completed = data => { if (data.executionId === id) exit = data.exitCode; };
  runtime.on('execution-output', stdout);
  runtime.on('execution-exit', completed);
  try {
    await runtime.request('execution:start', { executionId: id, language, code, path: file });
    await until(() => exit !== undefined, `Run ${id} did not exit`);
    assert.equal(exit, 0, `${id} exited ${exit}: ${output}`);
    return output;
  } finally { runtime.off('execution-output', stdout); runtime.off('execution-exit', completed); }
}
async function shell(runtime, terminalId, command, expected) {
  let output = '';
  const receive = data => { if (data.terminalId === terminalId) output += data.data; };
  runtime.on('terminal-output', receive);
  try {
    await runtime.request('terminal:data', { terminalId, data: command + '\r' });
    await until(() => output.includes(expected), `Shell output missing ${expected}: ${output}`);
    return output;
  } finally { runtime.off('terminal-output', receive); }
}
(async () => {
  process.env.SYNCSCRIPT_TEST_HOST_SECRET = 'host-only-canary';
  await fs.writeFile('/adapter-host-marker', 'HOST_ONLY');
  const first = await getLocalRuntime('adapter-smoke-a');
  first.on('resource-limit', value => console.error('Resource limit during smoke:', value));
  first.on('accounting-error', value => console.error('Accounting error during smoke:', value));
  await first.request('sync', { files: [
    { path: 'main.py', type: 'FILE', content: 'print("initial")' },
    { path: 'pkg/helper.py', type: 'FILE', content: 'value = 42' },
    { path: 'pkg/main.py', type: 'FILE', content: 'print("original-source")' },
  ], preserveExisting: true });
  await first.request('terminal:spawn', { terminalId: 'term-a', cols: 120, rows: 30 });
  await shell(first, 'term-a', "printf '\\nPTY_%s\\n' OK", '\r\nPTY_OK\r\n');
  await shell(first, 'term-a', "if cat /adapter-host-marker >/dev/null 2>&1; then false; else printf '\\nBOUNDARY_%s\\n' OK; fi", '\r\nBOUNDARY_OK\r\n');
  const boundary = await run(first, 'boundary-run', 'python', 'import os,socket\nassert "SYNCSCRIPT_TEST_HOST_SECRET" not in os.environ\nassert os.getcwd() == os.environ["HOME"]\nfor action in [lambda: open("/adapter-host-marker").read(), lambda: os.listdir("/app")]:\n try:\n  action()\n  raise RuntimeError("backend file unexpectedly accessible")\n except PermissionError:\n  pass\ntry:\n socket.socket()\n raise RuntimeError("network unexpectedly allowed")\nexcept PermissionError:\n print("NETWORK_BLOCKED")\nprint(os.getuid())\n', 'boundary.py');
  assert.match(boundary, /NETWORK_BLOCKED/);
  const uidA = Number(boundary.trim().split('\n').at(-1));
  assert(uidA >= 10000 && uidA < 60000);
  console.log('PASS actual PTY, Landlock file isolation, environment clearing and network block');

  assert.match(await run(first, 'imports', 'python', 'from helper import value\nprint(value)', 'pkg/main.py'), /42/);
  await shell(first, 'term-a', "cat pkg/main.py; printf '\\nSOURCE_%s\\n' DONE", 'original-source');
  console.log('PASS source snapshot relative imports and original-file preservation');

  await shell(first, 'term-a', "printf 'terminal-only\\n' > main.py; printf '\\nEDIT_%s\\n' DONE", '\r\nEDIT_DONE\r\n');
  const backups = new Set();
  first.on('terminal-output', data => { const found = /main\.py\.syncscript-backup-[a-f0-9]+/.exec(data.data); if (found) backups.add(found[0]); });
  await first.request('write-file', { path: 'main.py', content: 'print("new editor")' });
  assert.equal(backups.size, 1);
  await shell(first, 'term-a', `cat ${[...backups][0]}; printf '\\nBACKUP_%s\\n' DONE`, 'terminal-only\r\n');
  await shell(first, 'term-a', "cat main.py; printf '\\nNEW_%s\\n' DONE", 'new editor');
  await first.request('write-file', { path: 'main.py', content: 'print("normal editor update")' });
  assert.equal(backups.size, 1, 'An unchanged editor inode should not create another backup when no process has it open');
  const writer = 'writer-' + Date.now();
  const childCode = `import os,time\nf=open('main.py','a')\nopen('${writer}-ready','w').close()\nwhile not os.path.exists('${writer}-go'): time.sleep(.01)\nf.write('\\nLATE_APPEND\\n'); f.flush(); f.close()\nopen('${writer}-done','w').close()`;
  const parentCode = `import subprocess,os,time\nsubprocess.Popen(['/usr/bin/python3','-c',${JSON.stringify(childCode)}],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwhile not os.path.exists('${writer}-ready'): time.sleep(.01)\nprint('WRITER_READY')`;
  await run(first, 'held-writer', 'python', parentCode, 'holder.py');
  await first.request('write-file', { path: 'main.py', content: 'print("update while writer holds old inode")' });
  assert.equal(backups.size, 2, 'An open terminal writer must keep its displaced inode even when its initial hash matched');
  await shell(first, 'term-a', `touch ${writer}-go; while [ ! -e ${writer}-done ]; do sleep .01; done; cat ${[...backups].at(-1)}`, 'LATE_APPEND');
  const longName = 'é'.repeat(120) + '.py';
  await first.request('write-file', { path: longName, content: 'old editor content' });
  await shell(first, 'term-a', `printf 'long terminal content' > '${longName}'; printf '\\nLONG_EDIT_%s\\n' DONE`, '\r\nLONG_EDIT_DONE\r\n');
  let longBackup;
  const captureLongBackup = data => {
    const match = /Preserved terminal changes at \/var\/lib\/syncscript\/workspaces\/[a-f0-9]+\/workspace\/(.+) before updating/.exec(data.data);
    if (match) longBackup = match[1];
  };
  first.on('terminal-output', captureLongBackup);
  await first.request('write-file', { path: longName, content: 'new editor content' });
  first.off('terminal-output', captureLongBackup);
  assert(longBackup && Buffer.byteLength(longBackup) <= 255, 'Recovery basenames must fit NAME_MAX for long UTF-8 filenames');
  await shell(first, 'term-a', `cat '${longBackup}'; printf '\\nLONG_BACKUP_%s\\n' DONE`, 'long terminal content');
  console.log('PASS atomic conflict backup and visible recovery path');

  assert.match(await run(first, 'js', 'javascript', 'console.log("JAVASCRIPT_OK")', 'main.js'), /JAVASCRIPT_OK/);
  assert.match(await run(first, 'ts', 'typescript', 'const value: number = 42; console.log("TYPESCRIPT_OK", value)', 'main.ts'), /TYPESCRIPT_OK 42/);
  assert.match(await run(first, 'c', 'c', '#include <stdio.h>\nint main(){puts("C_OK");return 0;}', 'main.c'), /C_OK/);
  assert.match(await run(first, 'cpp', 'cpp', '#include <iostream>\nint main(){std::cout << "CPP_OK" << std::endl;}', 'main.cpp'), /CPP_OK/);
  assert.match(await run(first, 'java', 'java', 'public class Main { public static void main(String[] args) { System.out.println("JAVA_OK"); } }', 'Main.java'), /JAVA_OK/);
  console.log('PASS Python, JavaScript, TypeScript, C, C++ and Java through actual launcher');

  const second = await getLocalRuntime('adapter-smoke-b');
  await second.request('terminal:spawn', { terminalId: 'term-b' });
  const uidB = Number((await run(second, 'other-uid', 'python', 'import os; print(os.getuid())', 'uid.py')).trim());
  assert.notEqual(uidA, uidB);
  await first.close();
  await shell(second, 'term-b', "printf '\\nOTHER_%s\\n' ALIVE", '\r\nOTHER_ALIVE\r\n');
  const reopened = await getLocalRuntime('adapter-smoke-a');
  await reopened.request('sync', { files: [{ path: 'main.py', type: 'FILE', content: 'print("DB-after-idle")' }], preserveExisting: true });
  await reopened.request('terminal:spawn', { terminalId: 'term-reopened' });
  await shell(reopened, 'term-reopened', "cat main.py; printf '\\nREOPEN_%s\\n' DONE", 'DB-after-idle');
  const uidAgain = Number((await run(reopened, 'reopened-uid', 'python', 'import os; print(os.getuid())', 'uid.py')).trim());
  assert.equal(uidAgain, uidA);
  console.log('PASS UID separation, complete cleanup, persistent identities and fresh DB sync after idle');
  await closeAllLocalRuntimes();
  console.log('ALL LOCAL ADAPTER SMOKE CHECKS PASSED');
})().catch(async error => { console.error(error); await closeAllLocalRuntimes().catch(() => {}); process.exitCode = 1; });
