import http from 'node:http';
import { io } from 'socket.io-client';
import { WorkspaceRuntime } from './runtime.mjs';

if (process.platform !== 'linux' || process.getuid?.() !== 0) {
  throw new Error('The workspace broker must run as root on Linux to launch user commands as uid 1000');
}
process.setgroups([]);

const apiUrl = process.env.SYNCSCRIPT_API_URL;
const workspaceId = process.env.SYNCSCRIPT_WORKSPACE_ID;
const token = process.env.SYNCSCRIPT_RUNTIME_TOKEN;
if (!apiUrl || !workspaceId || !token || token.length < 32) {
  throw new Error('SYNCSCRIPT_API_URL, SYNCSCRIPT_WORKSPACE_ID and a scoped SYNCSCRIPT_RUNTIME_TOKEN are required');
}
const destination = new URL(apiUrl);
if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password) {
  throw new Error('Invalid SYNCSCRIPT_API_URL');
}
if (destination.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)) {
  throw new Error('Runtime connections require HTTPS except on localhost');
}

const socket = io(`${destination.origin}/runtime`, {
  auth: { workspaceId, token },
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10_000,
});
const runtime = new WorkspaceRuntime({
  root: process.env.WORKSPACE_ROOT || '/workspace',
  // Never let Socket.IO accumulate output while disconnected.
  emit: (event, data) => { if (socket.connected) socket.emit(event, data); },
});

socket.on('connect', () => {
  console.info('Workspace runtime connected');
  socket.emit('runtime:ready', { workspaceId, version: '0.1.0' });
});
socket.on('connect_error', (error) => console.error(`Workspace runtime connection failed: ${error.message}`));
socket.on('disconnect', () => runtime.close());
socket.on('runtime:request', async (request, ack) => {
  if (typeof ack !== 'function') return;
  try {
    if (!request || typeof request.action !== 'string') throw new Error('Invalid runtime request');
    const result = await runtime.request(request.action, request.payload);
    ack({ ok: true, result });
  } catch (error) {
    ack({ ok: false, error: error instanceof Error ? error.message : 'Runtime request failed' });
  }
});

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && (request.url === '/health' || request.url === '/')) {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', connected: socket.connected, version: '0.1.0' }));
  } else {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  }
});
server.listen(Number(process.env.PORT || 7860), '0.0.0.0');

function shutdown() {
  runtime.close();
  socket.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
