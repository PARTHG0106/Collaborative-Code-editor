import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager } from './TerminalManager';

const mocks = vi.hoisted(() => ({
  terminal: null as unknown as {
    write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>;
    options: { disableStdin?: boolean }; cols: number; rows: number;
    data: (data: string) => void; resize: (size: { cols: number; rows: number }) => void;
  },
  fit: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    write = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    data = (_data: string) => {};
    resize = (_size: { cols: number; rows: number }) => {};
    constructor() { mocks.terminal = this; }
    loadAddon() {}
    open() {}
    clear() {}
    scrollToBottom() {}
    onData(callback: (data: string) => void) { this.data = callback; }
    onResize(callback: (size: { cols: number; rows: number }) => void) { this.resize = callback; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = mocks.fit; } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

describe('TerminalManager', () => {
  let manager: TerminalManager;
  let resize: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    frames = new Map();
    disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      disconnect = disconnect;
      constructor(callback: () => void) { resize = callback; }
      observe() {}
    });
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    manager = new TerminalManager(document.createElement('div'));
  });

  afterEach(() => { manager.dispose(); vi.unstubAllGlobals(); });

  it('preserves PTY key sequences, multiline paste and interrupt bytes without local echo', () => {
    const input = vi.fn();
    const lineInput = vi.fn();
    manager.setRawMode(true);
    manager.onRawData(input);
    manager.onData(lineInput);
    for (const data of ['ls\r', '\x1b[A', '\t', '\x03', '\x1b[200~one\ntwo\x1b[201~']) {
      mocks.terminal.data(data);
      expect(input).toHaveBeenLastCalledWith(data);
    }
    expect(mocks.terminal.write).not.toHaveBeenCalled();
    expect(lineInput).not.toHaveBeenCalled();
  });

  it('submits pasted lines once and keeps the remaining input editable for code runners', () => {
    const input = vi.fn();
    manager.onData(input);
    mocks.terminal.data('\x1b[200~first\r\nsecond\nthird\x1b[201~');
    expect(input.mock.calls).toEqual([['first\n'], ['second\n']]);
    mocks.terminal.data('\x7f!\r');
    expect(input).toHaveBeenLastCalledWith('thir!\n');
    mocks.terminal.data('😀\x7fok\r');
    expect(input).toHaveBeenLastCalledWith('ok\n');
  });

  it('drops a partial execution line when switching to a shell and back', () => {
    const input = vi.fn();
    manager.onData(input);
    mocks.terminal.data('old input');
    manager.setRawMode(true);
    manager.setRawMode(false);
    mocks.terminal.data('new\r');
    expect(input.mock.calls).toEqual([['new\n']]);
  });

  it('reports terminal geometry and removes only the callback owned by its subscriber', () => {
    const previous = vi.fn();
    const current = vi.fn();
    const removePrevious = manager.onResize(previous);
    const removeCurrent = manager.onResize(current);
    removePrevious();
    mocks.terminal.cols = 120;
    mocks.terminal.rows = 32;
    mocks.terminal.resize(manager.getDimensions());
    expect(current).toHaveBeenCalledWith({ cols: 120, rows: 32 });
    expect(previous).not.toHaveBeenCalled();
    removeCurrent();
    mocks.terminal.resize({ cols: 80, rows: 24 });
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('coalesces layout work and cancels pending fits when disposed', () => {
    resize();
    resize();
    expect(frames.size).toBe(1);
    const pendingFrame = [...frames.values()][0];
    manager.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    pendingFrame(0);
    resize();
    manager.fit();
    manager.writeStdout('late output');
    manager.writeInfo('late info');
    manager.writeStderr('late error');
    manager.focus();
    manager.dispose();
    expect(mocks.fit).not.toHaveBeenCalled();
    expect(mocks.terminal.write).not.toHaveBeenCalled();
    expect(mocks.terminal.focus).not.toHaveBeenCalled();
    expect(mocks.terminal.dispose).toHaveBeenCalledTimes(1);
  });
});
