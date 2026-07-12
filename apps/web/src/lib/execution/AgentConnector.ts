import { RuntimeCallbacks } from './types';

/**
 * AgentConnector — Connects to the SyncScript Local Agent running on the user's machine.
 * The agent listens on ws://localhost:9876 by default.
 */
export class AgentConnector {
  private ws: WebSocket | null = null;
  private runtimes: string[] = [];
  private connected = false;
  private onStatusChange?: (connected: boolean, runtimes: string[]) => void;
  private messageHandler?: (e: MessageEvent) => void;

  /**
   * Attempt to connect to the local agent.
   * Returns true if successful, false if agent is not running.
   */
  async connect(port = 9876): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const timeout = setTimeout(() => {
          this.ws?.close();
          resolve(false);
        }, 2000);

        this.ws = new WebSocket(`ws://localhost:${port}`);

        this.ws.onopen = () => {
          this.ws!.send(JSON.stringify({ type: 'handshake' }));
        };

        this.ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'handshake-ack') {
              clearTimeout(timeout);
              this.runtimes = msg.runtimes || [];
              this.connected = true;
              this.onStatusChange?.(true, this.runtimes);
              resolve(true);
            }
          } catch {}
        };

        this.ws.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.onStatusChange?.(false, []);
        };
      } catch {
        resolve(false);
      }
    });
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getRuntimes(): string[] {
    return this.runtimes;
  }

  onStatus(cb: (connected: boolean, runtimes: string[]) => void) {
    this.onStatusChange = cb;
  }

  /**
   * Execute code on the local machine via the agent.
   */
  async execute(language: string, code: string, callbacks: RuntimeCallbacks): Promise<void> {
    if (!this.isConnected()) {
      callbacks.onStderr('Local agent not connected\r\n');
      callbacks.onExit(1);
      return;
    }

    return new Promise((resolve) => {
      // Clean up any previous handler
      if (this.messageHandler) {
        this.ws!.removeEventListener('message', this.messageHandler);
      }

      this.messageHandler = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
          switch (msg.type) {
            case 'stdout':
              callbacks.onStdout(msg.data);
              break;
            case 'stderr':
              callbacks.onStderr(msg.data);
              break;
            case 'waiting-input':
              callbacks.onRequestInput();
              break;
            case 'exit':
              callbacks.onExit(msg.code ?? 0);
              if (this.messageHandler) {
                this.ws?.removeEventListener('message', this.messageHandler);
                this.messageHandler = undefined;
              }
              resolve();
              break;
          }
        } catch {}
      };

      this.ws!.addEventListener('message', this.messageHandler);
      this.ws!.send(JSON.stringify({ type: 'execute', language, code }));
    });
  }

  sendInput(text: string) {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify({ type: 'stdin', data: text }));
    }
  }

  kill() {
    if (this.isConnected()) {
      this.ws!.send(JSON.stringify({ type: 'kill' }));
    }
  }

  disconnect() {
    if (this.messageHandler && this.ws) {
      this.ws.removeEventListener('message', this.messageHandler);
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.runtimes = [];
  }
}
