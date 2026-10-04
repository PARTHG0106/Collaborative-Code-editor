'use strict';

// Run only against disposable API/PostgreSQL containers. Credentials below
// describe synthetic test data and are never printed by this harness.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const load = createRequire('/app/package.json');
const { Client } = load('pg');
const bcrypt = load('bcryptjs');
const { io } = load('socket.io-client');
const origin = process.env.SMOKE_API_ORIGIN || 'http://api:7860';
const databaseUrl = process.env.SMOKE_DATABASE_URL;
if (!databaseUrl || !process.env.SMOKE_DISPOSABLE) throw new Error('Set SMOKE_DISPOSABLE and SMOKE_DATABASE_URL for a disposable test database.');
const password = 'Synthetic-smoke-password-2026';
const sockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await delay(50); }
}
async function api(method, route, token, body, expected = 200) {
  const response = await fetch(origin + '/api' + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${route} returned HTTP ${response.status}`);
  return response.json();
}
function event(socket, name, predicate = () => true, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const listener = value => { if (predicate(value)) { clearTimeout(timer); socket.off(name, listener); resolve(value); } };
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out waiting for ${name}`)); }, timeout);
    socket.on(name, listener);
  });
}
async function connect(token) {
  const socket = io(origin, { autoConnect: false, transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(socket);
  const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', () => reject(new Error('Socket authentication or connection failed'))); });
  socket.connect();
  await connected;
  return socket;
}
async function openTerminal(socket, workspaceId) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('terminal:ready', ready); socket.off('terminal:error', error); };
    const ready = value => { if (value.workspaceId === workspaceId) { cleanup(); resolve(); } };
    const error = value => { if (value.workspaceId === workspaceId) { cleanup(); reject(new Error(`Terminal failed: ${value.message}`)); } };
    // Allow cold CI hosts time for workspace provisioning and initial DB sync.
    const timer = setTimeout(() => { cleanup(); reject(new Error('Terminal did not become ready')); }, 300000);
    socket.on('terminal:ready', ready);
    socket.on('terminal:error', error);
    socket.emit('terminal:spawn', { workspaceId, cols: 120, rows: 32 });
  });
}
async function shell(socket, workspaceId, command, expected) {
  let output = '';
  const receive = value => { if (value.workspaceId === workspaceId) output += value.data; };
  socket.on('terminal:output', receive);
  try {
    socket.emit('terminal:data', { workspaceId, data: command + '\r' });
    await until(() => output.includes(expected), `terminal command marker ${expected}`);
    return output;
  } finally { socket.off('terminal:output', receive); }
}
async function execute(socket, workspaceId, fileId, code, input) {
  let sessionId;
  let output = '';
  let completed;
  let failure;
  let sentInput = false;
  const started = value => { sessionId = value.sessionId; };
  const text = value => {
    if (value.sessionId !== sessionId) return;
    output += value.data;
    if (input && !sentInput && output.includes('INPUT_READY')) {
      sentInput = true;
      socket.emit('execution:stdin', { sessionId, data: input + '\n' });
    }
  };
  const done = value => { if (value.sessionId === sessionId) completed = value; };
  const failed = () => { failure = new Error('Execution failed before completing'); };
  socket.on('execution:started', started);
  socket.on('execution:stdout', text);
  socket.on('execution:stderr', text);
  socket.on('execution:completed', done);
  socket.on('execution:failed', failed);
  try {
    socket.emit('execution:start', { workspaceId, fileId, language: 'python', code, target: 'remote' });
    await until(() => completed || failure, 'remote execution completion', 90000);
    if (failure) throw failure;
    assert.equal(completed.exitCode, 0, `Execution exited ${completed.exitCode}: ${output}`);
    assert(sessionId && sessionId !== socket.id, 'Execution must use a database session ID');
    return { sessionId, output };
  } finally {
    socket.off('execution:started', started); socket.off('execution:stdout', text); socket.off('execution:stderr', text);
    socket.off('execution:completed', done); socket.off('execution:failed', failed);
  }
}

const db = new Client({ connectionString: databaseUrl });
(async () => {
  await until(async () => {
    try { return (await fetch(origin + '/api/health')).ok; } catch { return false; }
  }, 'fresh API migrations and health', 180000);
  const health = await api('GET', '/health');
  assert.equal(health.data.services.database.status, 'connected');
  assert.equal(health.data.features.isolatedWorkspaceTerminal, true);
  await db.connect();
  const history = (await db.query('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name')).rows;
  assert.equal(history.length, 10, 'Fresh startup must apply the complete committed history');
  assert(history.every(row => row.finished_at));
  assert(history.some(row => row.migration_name.endsWith('_add_execution_models')));
  assert(history.some(row => row.migration_name.endsWith('_optional_d1_content')));
  console.log('PASS fresh PostgreSQL migrations, execution schema and HTTP health');

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const hash = await bcrypt.hash(password, 12);
  const accounts = ['a', 'b'].map(label => ({ id: `smoke-${suffix}-${label}`, email: `${label}-${suffix}@smoke.invalid`, name: `Smoke User ${label}` }));
  for (const account of accounts) await db.query('INSERT INTO users (id,email,password_hash,name,is_verified,created_at,updated_at) VALUES ($1,$2,$3,$4,true,now(),now())', [account.id, account.email, hash, account.name]);
  const tokens = [];
  for (const account of accounts) {
    const login = await api('POST', '/auth/login', undefined, { email: account.email, password });
    assert.equal(login.data.user.id, account.id);
    tokens.push(login.data.accessToken);
  }
  assert.equal((await db.query('SELECT count(*)::int AS count FROM refresh_tokens WHERE token_hash IS NOT NULL AND user_id = ANY($1::text[])', [accounts.map(account => account.id)])).rows[0].count, 2);
  const workspaces = [];
  const files = [];
  for (let i = 0; i < 2; i++) {
    workspaces.push((await api('POST', '/workspaces', tokens[i], { name: `Disposable smoke ${suffix}-${i}` }, 201)).data);
    files.push((await api('POST', `/workspaces/${workspaces[i].id}/files`, tokens[i], { name: 'main.py', type: 'FILE', content: `print("DB_${i}")` }, 201)).data);
  }
  const [workspaceA, workspaceB] = workspaces.map(workspace => workspace.id);
  await api('GET', `/workspaces/${workspaceA}`, tokens[1], undefined, 403);
  const a = await connect(tokens[0]);
  const b = await connect(tokens[1]);
  const invalid = io(origin, { autoConnect: false, transports: ['websocket'], auth: { token: 'invalid-test-token' }, reconnection: false });
  sockets.push(invalid);
  const invalidRejected = event(invalid, 'connect_error');
  invalid.connect();
  await invalidRejected;
  assert.equal(invalid.connected, false);
  invalid.disconnect();
  a.emit('join_workspace', { workspaceId: workspaceA });
  b.emit('join_workspace', { workspaceId: workspaceB });
  const foreignTerminal = event(b, 'terminal:error', value => value.workspaceId === workspaceA);
  b.emit('terminal:spawn', { workspaceId: workspaceA });
  await foreignTerminal;
  const foreignExecution = event(b, 'authz_error', value => value.event === 'execution:start');
  b.emit('execution:start', { workspaceId: workspaceA, fileId: files[0].id, language: 'python', code: 'print("forbidden")' });
  await foreignExecution;
  console.log('PASS verified-account login, hashed refresh storage, workspace CRUD and cross-workspace authorization');

  await openTerminal(a, workspaceA);
  await openTerminal(b, workspaceB);
  const listing = await shell(a, workspaceA, "cd; pwd; ls; if ls /app >/dev/null 2>&1; then false; else printf '\\nNO_API_%s\\n' FILES; fi", '\r\nNO_API_FILES\r\n');
  assert(listing.includes('/workspace') && listing.includes('main.py'));
  const injected = [];
  const inspectA = value => { if (value.workspaceId === workspaceA && value.data.includes('INJECTION_MARKER')) injected.push(value.data); };
  a.on('terminal:output', inspectA);
  b.emit('terminal:data', { workspaceId: workspaceA, data: "printf 'INJECTION_MARKER'\r" });
  await delay(250);
  assert.equal(injected.length, 0);
  a.off('terminal:output', inspectA);
  const aCode = 'import os,socket\nassert "DATABASE_URL" not in os.environ\nassert "JWT_ACCESS_SECRET" not in os.environ\nassert os.getcwd() == os.environ["HOME"]\nfor action in [lambda: open("/app/package.json").read(), lambda: os.listdir("/app")]:\n try:\n  action()\n  raise RuntimeError("backend file unexpectedly accessible")\n except PermissionError:\n  pass\nwith open("/dev/null","wb") as target: target.write(b"discarded")\nwith open("/dev/zero","rb") as source: assert source.read(16) == bytes(16)\ntry:\n socket.socket()\n raise RuntimeError("network unexpectedly permitted")\nexcept PermissionError:\n print("NETWORK_BLOCKED",flush=True)\nprint("INPUT_READY",flush=True)\nprint("ANSWER_A:"+input())';
  const [runA, runB] = await Promise.all([
    execute(a, workspaceA, files[0].id, aCode, 'synthetic-answer'),
    execute(b, workspaceB, files[1].id, 'print("ONLY_WORKSPACE_B")'),
  ]);
  assert(runA.output.includes('NETWORK_BLOCKED') && runA.output.includes('ANSWER_A:synthetic-answer'));
  assert(!runA.output.includes('ONLY_WORKSPACE_B') && !runB.output.includes('ANSWER_A'));
  const foreignWatch = event(b, 'authz_error', value => value.event === 'execution:watch');
  b.emit('execution:watch', { sessionId: runA.sessionId });
  await foreignWatch;
  const runs = (await db.query('SELECT id,status,exit_code,user_id FROM execution_sessions WHERE id = ANY($1::text[])', [[runA.sessionId, runB.sessionId]])).rows;
  assert.equal(runs.length, 2);
  assert(runs.every(row => row.status === 'COMPLETED' && row.exit_code === 0));
  console.log('PASS real cd/ls, denied backend content/listing, isolated terminal input/output, safe devices and concurrent Python/stdin execution');

  await shell(a, workspaceA, "printf 'TERMINAL_ONLY_EDIT\\n' > main.py; printf '\\nEDIT_%s\\n' READY", '\r\nEDIT_READY\r\n');
  const backupNotice = event(a, 'terminal:output', value => value.workspaceId === workspaceA && value.data.includes('main.py.syncscript-backup-'));
  await api('PATCH', `/workspaces/${workspaceA}/files/${files[0].id}`, tokens[0], { content: 'print("HTTP_MIRROR")' });
  const notice = await backupNotice;
  const backup = /main\.py\.syncscript-backup-[a-f0-9]+/.exec(notice.data)?.[0];
  assert(backup);
  await shell(a, workspaceA, `cat ${backup}; cat main.py; printf '\\nMIRROR_%s\\n' DONE`, 'TERMINAL_ONLY_EDIT');
  await shell(a, workspaceA, "cat main.py; printf '\\nSOURCE_%s\\n' DONE", 'HTTP_MIRROR');
  a.disconnect();
  await delay(1500);
  await api('PATCH', `/workspaces/${workspaceA}/files/${files[0].id}`, tokens[0], { content: 'print("DB_WHILE_DISCONNECTED")' });
  const reopened = await connect(tokens[0]);
  reopened.emit('join_workspace', { workspaceId: workspaceA });
  await openTerminal(reopened, workspaceA);
  await shell(reopened, workspaceA, "cat main.py; printf '\\nREOPEN_%s\\n' DONE", 'DB_WHILE_DISCONNECTED');
  await shell(b, workspaceB, "cat main.py; printf '\\nOTHER_%s\\n' ALIVE", 'DB_1');
  console.log('PASS HTTP file mirror, terminal-edit recovery copy, disconnect cleanup and fresh DB sync after reconnect');
  console.log('ALL FULL-STACK API SMOKE CHECKS PASSED');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  for (const socket of sockets) socket.disconnect();
  await db.end().catch(() => {});
});
