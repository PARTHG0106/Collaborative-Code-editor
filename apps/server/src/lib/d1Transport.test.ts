import { readFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1Client } from './d1ContentStore.js';

const options = { accountId: 'a'.repeat(32), databaseId: '11111111-1111-1111-1111-111111111111', apiToken: 'synthetic-test-token' };

describe('D1 Node HTTP transport settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses IPv4, bounded requests, no redirects, and verified TLS without disabling environment proxies', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 200, data: JSON.stringify({ success: true, result: [{ success: true, results: [{ ok: 1 }] }] }) });
    expect(await new D1Client(options).query('SELECT 1')).toEqual([{ ok: 1 }]);
    const config = request.mock.calls[0][0]!;
    expect(config).toMatchObject({ adapter: 'http', method: 'POST', family: 4, timeout: 15000, maxRedirects: 0,
      maxBodyLength: 2 * 1024 * 1024, maxContentLength: 8 * 1024 * 1024 });
    expect(config.httpsAgent.options.rejectUnauthorized).toBe(true);
    expect(config.httpsAgent.options.keepAlive).toBe(true);
    expect(config.httpsAgent.options.family).toBe(4);
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(Object.hasOwn(config, 'proxy')).toBe(false);
  });

  it('does not expose provider bodies for redirects or invalid JSON', async () => {
    vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 302, data: 'private-provider-response' })
      .mockResolvedValueOnce({ status: 200, data: 'private-invalid-json' });
    await expect(new D1Client(options).query('SELECT 1')).rejects.toThrow(/^D1 request failed \(HTTP 302\)\.$/);
    await expect(new D1Client(options).query('SELECT 1')).rejects.toThrow(/^D1 returned an invalid response\.$/);
  });
});

describe('D1 environment proxy integration over loopback only', () => {
  // Public test fixtures, generated solely for these local servers. The CA is
  // trusted only by the per-test agent below; production TLS stays unchanged.
  const cert = readFileSync(path.join(__dirname, '__fixtures__/d1-loopback-cert.pem'));
  const key = readFileSync(path.join(__dirname, '__fixtures__/d1-loopback-key.pem'));
  let server: Server;
  let origin: https.Server;
  let status: number;
  let trustOrigin: boolean;
  let requests: Array<{ url: string; authorization?: string; proxyAuthorization?: string; body: string }>;
  let tunnels: Array<{ target: string; authorization?: string; proxyAuthorization?: string }>;
  let connections: Array<{ host?: string; family?: number }>;
  let sockets: Set<Socket>;
  let agents: https.Agent[];

  beforeEach(async () => {
    status = 200;
    trustOrigin = true;
    requests = [];
    tunnels = [];
    connections = [];
    sockets = new Set();
    agents = [];
    origin = https.createServer({ cert, key }, (req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        requests.push({ url: req.url!, authorization: req.headers.authorization, proxyAuthorization: req.headers['proxy-authorization'], body });
        res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 302 ? { Location: 'https://must-not-follow.invalid/' } : {}) });
        res.end(JSON.stringify({ success: true, result: [{ success: true, results: [{ ok: 1 }] }] }));
      });
    });
    const track = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
    origin.on('connection', track);
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
    server = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
    server.on('connection', track);
    server.on('connect', (req, client, head) => {
      tunnels.push({ target: req.url!, authorization: req.headers.authorization, proxyAuthorization: req.headers['proxy-authorization'] });
      // Always tunnel to the local fixture, never to the supplied hostname.
      const upstream = net.connect({ host: '127.0.0.1', port: (origin.address() as AddressInfo).port, family: 4 }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) vi.stubEnv(key, '');
    vi.stubEnv('HTTPS_PROXY', `http://test-user:test-password@127.0.0.1:${(server.address() as AddressInfo).port}`);
    // A broken proxy regression must never turn this test into an outbound
    // Cloudflare request. Guard actual sockets, since HTTPS CONNECT keeps the
    // origin hostname in https.request while connecting only to the proxy.
    const connect = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function(this: Socket, ...args: unknown[]): Socket {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const target = (typeof normalized[0] === 'object' ? normalized[0] : { host: normalized[1] }) as { host?: string; family?: number };
      if (target.host !== '127.0.0.1') throw new Error('External network blocked in test');
      connections.push(target);
      return Reflect.apply(connect, this, args) as Socket;
    } as typeof net.Socket.prototype.connect);
    const request = axios.request;
    vi.spyOn(axios, 'request').mockImplementation(config => {
      if (!trustOrigin) return request(config);
      const agent = new https.Agent({ ...config.httpsAgent.options, ca: cert });
      agents.push(agent);
      return request({ ...config, httpsAgent: agent });
    });
  });

  afterEach(async () => {
    agents.forEach(agent => agent.destroy());
    sockets.forEach(socket => socket.destroy());
    await Promise.all([server, origin].map(item => new Promise<void>(resolve => item.close(() => resolve()))));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('routes HTTPS through an IPv4 CONNECT tunnel and keeps the bearer token inside TLS', async () => {
    expect(await new D1Client(options).query('SELECT ?', ['synthetic-content'])).toEqual([{ ok: 1 }]);
    expect(requests).toHaveLength(1);
    expect(tunnels).toEqual([{ target: 'api.cloudflare.com:443', authorization: undefined,
      proxyAuthorization: `Basic ${Buffer.from('test-user:test-password').toString('base64')}` }]);
    expect(connections).toHaveLength(2);
    expect(connections.every(connection => connection.family === 4)).toBe(true);
    expect(requests[0]).toMatchObject({ authorization: 'Bearer synthetic-test-token', proxyAuthorization: undefined });
    expect(requests[0].url).toBe(`/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}/query`);
    expect(JSON.parse(requests[0].body)).toEqual({ sql: 'SELECT ?', params: ['synthetic-content'] });
  });

  it('does not follow a redirect that could forward the bearer token', async () => {
    status = 302;
    await expect(new D1Client(options).query('SELECT 1')).rejects.toThrow('HTTP 302');
    expect(requests).toHaveLength(1);
    expect(tunnels).toHaveLength(1);
  });

  it('rejects an untrusted origin certificate before sending credentials or query text', async () => {
    trustOrigin = false;
    await expect(new D1Client(options).query('SELECT ?', ['synthetic-content'])).rejects.toThrow('code=DEPTH_ZERO_SELF_SIGNED_CERT;');
    expect(tunnels).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  it('honors NO_PROXY without allowing the test to open an external socket', async () => {
    vi.stubEnv('NO_PROXY', 'api.cloudflare.com');
    await expect(new D1Client(options).query('SELECT 1')).rejects.toThrow('D1 request failed');
    expect(tunnels).toHaveLength(0);
    expect(connections).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});
