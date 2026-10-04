import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { ProcessExecutor } from './executor.js';
import { DetectedRuntime } from './runtimes.js';

interface AgentConfig {
  port: number;
  runtimes: DetectedRuntime[];
}

/**
 * Browser origins allowed to drive the agent.
 *
 * The agent runs arbitrary code with the developer's privileges, so the set of
 * pages permitted to reach it must be an explicit allowlist - not "any page the
 * browser happens to load." Without this check, any website the developer
 * visits while the agent is running could connect to ws://localhost:9876 and
 * execute code (drive-by RCE). Extendable via SYNCSCRIPT_AGENT_ORIGINS
 * (comma-separated) for self-hosted IDE deployments.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://parthg0106.dev',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

function allowedOrigins(): Set<string> {
  const extra = (process.env.SYNCSCRIPT_AGENT_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

export class AgentServer {
  private wss: WebSocketServer | null = null;
  private executor = new ProcessExecutor();
  private config: AgentConfig;
  private origins = allowedOrigins();

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** True when the connection's Origin header is on the allowlist. */
  private isOriginAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // A missing Origin is a non-browser client (native tool, test harness).
    // Browsers always send Origin on a cross-origin WebSocket handshake, which
    // is the attack we are gating; allow the no-Origin case through.
    if (!origin) return true;
    return this.origins.has(origin.replace(/\/+$/, '').toLowerCase());
  }

  start() {
    // Bind to loopback only. Without an explicit host, ws listens on
    // 0.0.0.0/::, exposing an arbitrary-code-execution endpoint to every host
    // on the local network, not just this machine.
    this.wss = new WebSocketServer({
      port: this.config.port,
      host: '127.0.0.1',
      verifyClient: ({ req }, done) => {
        if (this.isOriginAllowed(req)) return done(true);
        console.warn(`Rejected connection from disallowed origin: ${req.headers.origin}`);
        done(false, 403, 'Origin not allowed');
      },
    });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('🔌 Browser IDE connected');

      ws.on('message', async (raw: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        switch (msg.type) {
          case 'handshake':
            ws.send(JSON.stringify({
              type: 'handshake-ack',
              runtimes: this.config.runtimes.map(r => r.language),
              platform: process.platform,
              version: '1.0.0',
              detectedRuntimes: this.config.runtimes,
            }));
            break;

          case 'execute': {
            const lang = msg.language as string;
            const code = msg.code as string;
            const supported = this.config.runtimes.some(r => r.language === lang);

            if (!supported) {
              ws.send(JSON.stringify({
                type: 'stderr',
                data: `Language "${lang}" is not installed on this machine\n`,
              }));
              ws.send(JSON.stringify({ type: 'exit', code: 1 }));
              return;
            }

            await this.executor.execute(lang, code, {
              onStdout: (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'stdout', data }));
                }
              },
              onStderr: (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'stderr', data }));
                }
              },
              onExit: (code) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'exit', code }));
                }
              },
            });
            break;
          }

          case 'stdin':
            this.executor.sendInput(msg.data);
            break;

          case 'kill':
            this.executor.kill();
            break;
        }
      });

      ws.on('close', () => {
        console.log('🔌 Browser IDE disconnected');
        this.executor.kill();
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
      });
    });

    this.wss.on('error', (err) => {
      console.error('Server error:', err.message);
    });
  }

  stop() {
    this.executor.kill();
    this.wss?.close();
  }
}
