import { WebSocketServer, WebSocket } from 'ws';
import { ProcessExecutor } from './executor.js';
import { DetectedRuntime } from './runtimes.js';

interface AgentConfig {
  port: number;
  runtimes: DetectedRuntime[];
}

export class AgentServer {
  private wss: WebSocketServer | null = null;
  private executor = new ProcessExecutor();
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.config.port });

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
