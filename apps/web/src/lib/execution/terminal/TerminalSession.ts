import type { Socket } from 'socket.io-client';
import type { TerminalManager } from './TerminalManager';

export type TerminalStatus = 'connecting' | 'ready' | 'disconnected' | 'exited' | 'error';

type TerminalView = Pick<TerminalManager, 'fit' | 'getDimensions' | 'onRawData' | 'onResize' | 'writeStdout' | 'writeInfo' | 'writeStderr'>;
type WorkspacePayload = { workspaceId?: string };

/** Owns one socket binding while the terminal view survives panel toggles. */
export class TerminalSession {
  private disposed = false;
  private status: TerminalStatus = 'disconnected';
  private readonly removeInput: () => void;
  private readonly removeResize: () => void;

  constructor(
    private readonly socket: Socket,
    private readonly manager: TerminalView,
    private readonly workspaceId: string,
    private readonly onStatus: (status: TerminalStatus) => void,
  ) {
    // Attach before spawning: an immediately available shell can print its
    // prompt before the next render or animation frame.
    socket.on('terminal:output', this.onOutput);
    socket.on('terminal:ready', this.onReady);
    socket.on('terminal:exit', this.onExit);
    socket.on('terminal:error', this.onError);
    socket.on('authz_error', this.onAuthorizationError);
    socket.on('connect', this.onConnect);
    socket.on('disconnect', this.onDisconnect);
    this.removeInput = manager.onRawData(this.sendInput);
    this.removeResize = manager.onResize(this.resize);
    this.restart();
  }

  private belongsToWorkspace(payload: WorkspacePayload) {
    return !this.disposed && (!payload.workspaceId || payload.workspaceId === this.workspaceId);
  }

  private setStatus(status: TerminalStatus) {
    if (this.disposed) return;
    this.status = status;
    this.onStatus(status);
  }

  private onOutput = (payload: WorkspacePayload & { data?: string } = {}) => {
    if (this.belongsToWorkspace(payload) && typeof payload.data === 'string') this.manager.writeStdout(payload.data);
  };

  private onReady = (payload: WorkspacePayload = {}) => {
    if (!this.belongsToWorkspace(payload) || !this.socket.connected) return;
    this.setStatus('ready');
    // Layout may have changed while the server was preparing the workspace.
    this.manager.fit();
    this.resize(this.manager.getDimensions());
  };

  private onExit = (payload: WorkspacePayload & { exitCode?: number } = {}) => {
    if (!this.belongsToWorkspace(payload)) return;
    this.setStatus('exited');
    const code = typeof payload.exitCode === 'number' ? ` with code ${payload.exitCode}` : '';
    this.manager.writeInfo(`\r\n[Terminal exited${code}. Select Restart terminal to open a new shell.]\r\n`);
  };

  private onError = (payload: WorkspacePayload & { message?: string } = {}) => {
    if (!this.belongsToWorkspace(payload)) return;
    this.setStatus('error');
    this.manager.writeStderr(`\r\n${payload.message || 'Unable to open the terminal.'}\r\n`);
  };

  private onAuthorizationError = (payload: { event?: string; message?: string } = {}) => {
    if (payload.event?.startsWith('terminal:')) this.onError(payload);
  };

  private onConnect = () => { this.restart(); };

  private onDisconnect = () => {
    this.setStatus('disconnected');
    if (!this.disposed) this.manager.writeInfo('\r\n[Connection lost. A new terminal session will open after reconnecting.]\r\n');
  };

  private sendInput = (data: string) => {
    // Never let Socket.IO buffer commands across disconnects and unexpectedly
    // run them in the replacement shell.
    if (!this.disposed && this.socket.connected && this.status === 'ready') {
      this.socket.emit('terminal:data', { workspaceId: this.workspaceId, data });
    }
  };

  private resize = (size: { cols: number; rows: number }) => {
    if (!this.disposed && this.socket.connected && this.status === 'ready') {
      this.socket.emit('terminal:resize', { workspaceId: this.workspaceId, ...size });
    }
  };

  restart() {
    if (this.disposed) return;
    if (!this.socket.connected) {
      this.setStatus('disconnected');
      return;
    }
    // Repeated opens and clicks must not restart an active shell or race two
    // asynchronous spawns. Exit/error and reconnect are explicit new attempts.
    if (this.status === 'connecting' || this.status === 'ready') return;
    this.setStatus('connecting');
    this.manager.fit();
    this.socket.emit('terminal:spawn', { workspaceId: this.workspaceId, ...this.manager.getDimensions() });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.off('terminal:output', this.onOutput);
    this.socket.off('terminal:ready', this.onReady);
    this.socket.off('terminal:exit', this.onExit);
    this.socket.off('terminal:error', this.onError);
    this.socket.off('authz_error', this.onAuthorizationError);
    this.socket.off('connect', this.onConnect);
    this.socket.off('disconnect', this.onDisconnect);
    this.removeInput();
    this.removeResize();
    if (this.socket.connected) this.socket.emit('terminal:close', { workspaceId: this.workspaceId });
  }
}
