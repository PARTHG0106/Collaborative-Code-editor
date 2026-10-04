import type { Socket } from 'socket.io-client';
import type { ExecutionTarget, RuntimeCallbacks } from './types';

type StartRequest = { workspaceId: string; fileId: string; language: string; code: string; target: ExecutionTarget };
type SessionPayload = { sessionId?: string };

/** One Run action owns exactly one server-issued execution session. */
export class RemoteExecutionSession {
  private sessionId: string | null = null;
  private finished = false;
  private started = false;
  private cancellationRequested = false;
  private startTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly socket: Socket, private readonly request: StartRequest, private readonly callbacks: RuntimeCallbacks) {
    socket.on('execution:started', this.onStarted);
    socket.on('execution:stdout', this.onStdout);
    socket.on('execution:stderr', this.onStderr);
    socket.on('execution:completed', this.onCompleted);
    socket.on('execution:failed', this.onFailed);
    socket.on('authz_error', this.onAuthorizationError);
    socket.on('disconnect', this.onDisconnect);
  }

  start() {
    if (this.finished || this.started) return;
    this.started = true;
    if (!this.socket.connected) { this.onDisconnect(); return; }
    this.startTimer = setTimeout(() => this.fail('The server did not confirm this execution. Try again.'), 30_000);
    this.socket.emit('execution:start', this.request);
  }

  private matches(payload: SessionPayload | null | undefined): boolean {
    return !this.finished && this.sessionId !== null && payload?.sessionId === this.sessionId;
  }

  private onStarted = (payload: SessionPayload | null = {}) => {
    if (this.finished || this.sessionId || typeof payload?.sessionId !== 'string' || !payload.sessionId || payload.sessionId === 'unknown') return;
    this.sessionId = payload.sessionId;
    clearTimeout(this.startTimer);
    // Start already joins this room on the server. Avoid a redundant async
    // watch that could rejoin after a very short execution has completed.
    if (this.cancellationRequested && this.socket.connected) this.socket.emit('execution:cancel', { sessionId: this.sessionId });
  };

  private onStdout = (payload: SessionPayload & { data?: string } = {}) => {
    if (this.matches(payload) && typeof payload.data === 'string') this.callbacks.onStdout(payload.data);
  };

  private onStderr = (payload: SessionPayload & { data?: string } = {}) => {
    if (this.matches(payload) && typeof payload.data === 'string') this.callbacks.onStderr(payload.data);
  };

  private onCompleted = (payload: SessionPayload & { exitCode?: number } = {}) => {
    if (!this.matches(payload)) return;
    this.finish(Number.isInteger(payload.exitCode) ? payload.exitCode! : 1);
  };

  private onFailed = (payload: SessionPayload & { error?: string } = {}) => {
    if (this.finished || (this.sessionId ? !this.matches(payload) : payload.sessionId && payload.sessionId !== 'unknown')) return;
    this.fail(typeof payload.error === 'string' ? payload.error : 'Remote execution failed.');
  };

  private onAuthorizationError = (payload: { event?: string; message?: string } = {}) => {
    if (payload.event === 'execution:start' || (this.sessionId && ['execution:stdin', 'execution:cancel'].includes(payload.event || ''))) {
      this.fail(payload.message || 'Execution permission was denied.');
    }
  };

  private onDisconnect = () => {
    // The server cancels runs owned by the disconnected socket. Never replay
    // input or silently start a second process after Socket.IO reconnects.
    this.fail('Connection lost. The remote execution was stopped.');
  };

  private fail(message: string) {
    if (this.finished) return;
    this.callbacks.onStderr(`${message}\r\n`);
    this.finish(1);
  }

  private finish(exitCode: number) {
    if (this.finished) return;
    this.dispose();
    this.callbacks.onExit(exitCode);
  }

  sendInput(data: string) {
    if (!this.finished && !this.cancellationRequested && this.socket.connected && this.sessionId) {
      this.socket.emit('execution:stdin', { sessionId: this.sessionId, data });
    }
  }

  cancel() {
    if (this.finished || this.cancellationRequested) return;
    this.cancellationRequested = true;
    if (this.sessionId && this.socket.connected) this.socket.emit('execution:cancel', { sessionId: this.sessionId });
    // If Stop precedes the acknowledgement, onStarted sends the cancellation.
    // Keep the Run action active until the server completes this same session.
  }

  dispose() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.startTimer);
    this.socket.off('execution:started', this.onStarted);
    this.socket.off('execution:stdout', this.onStdout);
    this.socket.off('execution:stderr', this.onStderr);
    this.socket.off('execution:completed', this.onCompleted);
    this.socket.off('execution:failed', this.onFailed);
    this.socket.off('authz_error', this.onAuthorizationError);
    this.socket.off('disconnect', this.onDisconnect);
    if (this.socket.connected && this.sessionId) this.socket.emit('execution:unwatch', { sessionId: this.sessionId });
  }
}
