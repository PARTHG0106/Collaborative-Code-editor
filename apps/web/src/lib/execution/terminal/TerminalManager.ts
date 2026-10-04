import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

export class TerminalManager {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private inputBuffer = '';
  private onInputSubmit?: (data: string) => void;
  private onRawDataCallback?: (data: string) => void;
  private onResizeCallback?: (size: { cols: number; rows: number }) => void;
  private isRawMode = false;
  private resizeObserver: ResizeObserver | null = null;
  private fitFrame: number | null = null;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#111312',
        foreground: '#F5F5F2',
        cursor: '#7B917F',
        selectionBackground: '#2A312D80',
        black: '#1C1F1D',
        red: '#B56A6A',
        green: '#5E8B68',
        yellow: '#B19764',
        blue: '#5D7FB5',
        magenta: '#8B6A8B',
        cyan: '#5B8B8B',
        white: '#F5F5F2',
      },
      convertEol: true,
      scrollback: 5000,
      cursorStyle: 'bar',
      allowTransparency: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.open(container);

    // Delay fit to ensure container has dimensions
    this.scheduleFit();

    // onData includes paste, IME and keyboard input. PTYs receive the original
    // bytes so shells, Ctrl+C, completion and full-screen programs work normally.
    this.terminal.onData((data) => {
      if (this.disposed || this.terminal.options.disableStdin) return;
      if (this.isRawMode) {
        this.onRawDataCallback?.(data);
        return;
      }

      // Browser/local code runners consume lines rather than a PTY. Strip
      // terminal key sequences (including bracketed-paste markers), not text.
      // eslint-disable-next-line no-control-regex -- ANSI key sequences start with ESC.
      const text = data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/g, '').replace(/\r\n/g, '\n');
      for (const character of text) {
        if (character === '\r' || character === '\n') {
          this.terminal.write('\r\n');
          const input = this.inputBuffer + '\n';
          this.inputBuffer = '';
          this.onInputSubmit?.(input);
        } else if (character === '\x7f' || character === '\b') {
          if (this.inputBuffer.length > 0) {
            this.inputBuffer = Array.from(this.inputBuffer).slice(0, -1).join('');
            this.terminal.write('\b \b');
          }
        } else if (character >= ' ' || character === '\t') {
          this.inputBuffer += character;
          this.terminal.write(character);
        }
      }
    });

    this.terminal.onResize((size) => {
      if (!this.disposed) this.onResizeCallback?.(size);
    });

    // Auto-resize on container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleFit();
    });
    this.resizeObserver.observe(container);
  }

  writeStdout(data: string) {
    if (this.disposed) return;
    // xterm follows new output when already at the bottom and preserves the
    // viewport when the user scrolls back to inspect earlier output.
    this.terminal.write(data);
  }

  writeStderr(data: string) {
    if (this.disposed) return;
    // Red color for stderr
    this.terminal.write(`\x1b[31m${data}\x1b[0m`);
  }

  writeInfo(data: string) {
    if (this.disposed) return;
    // Cyan color for info
    this.terminal.write(`\x1b[36m${data}\x1b[0m`);
  }

  onData(callback: (input: string) => void) {
    this.onInputSubmit = callback;
    return () => { if (this.onInputSubmit === callback) this.onInputSubmit = undefined; };
  }

  onRawData(callback: (data: string) => void) {
    this.onRawDataCallback = callback;
    return () => { if (this.onRawDataCallback === callback) this.onRawDataCallback = undefined; };
  }

  onResize(callback: (size: { cols: number; rows: number }) => void) {
    this.onResizeCallback = callback;
    return () => { if (this.onResizeCallback === callback) this.onResizeCallback = undefined; };
  }

  getDimensions() {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  setInputEnabled(enabled: boolean) {
    if (!this.disposed) this.terminal.options.disableStdin = !enabled;
  }

  setRawMode(raw: boolean) {
    if (this.isRawMode !== raw) this.inputBuffer = '';
    this.isRawMode = raw;
  }

  clear() {
    if (this.disposed) return;
    this.terminal.clear();
    this.terminal.write('\x1b[2J\x1b[H');
    this.inputBuffer = '';
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.fitFrame !== null) cancelAnimationFrame(this.fitFrame);
    this.fitFrame = null;
    this.onInputSubmit = undefined;
    this.onRawDataCallback = undefined;
    this.onResizeCallback = undefined;
    this.resizeObserver?.disconnect();
    this.terminal.dispose();
  }

  focus() {
    if (!this.disposed) this.terminal.focus();
  }

  private scheduleFit() {
    if (this.disposed || this.fitFrame !== null) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      this.fit();
    });
  }

  fit() {
    if (this.disposed) return;
    try { this.fitAddon.fit(); } catch { /* container not laid out yet; fit retried on next resize */ }
  }
}
