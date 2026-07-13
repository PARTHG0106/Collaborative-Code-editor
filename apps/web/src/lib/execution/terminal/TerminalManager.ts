import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

export class TerminalManager {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private inputBuffer = '';
  private onInputSubmit?: (data: string) => void;
  private isWaitingForInput = false;
  private resizeObserver: ResizeObserver | null = null;

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
    requestAnimationFrame(() => {
      try { this.fitAddon.fit(); } catch {}
    });

    // Handle user keyboard input for stdin
    this.terminal.onKey(({ key, domEvent }) => {
      if (domEvent.key === 'Enter') {
        this.terminal.write('\r\n');
        const input = this.inputBuffer + '\n';
        this.inputBuffer = '';
        this.onInputSubmit?.(input);
      } else if (domEvent.key === 'Backspace') {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.terminal.write('\b \b');
        }
      } else if (key.length === 1 && !domEvent.ctrlKey && !domEvent.altKey && !domEvent.metaKey) {
        this.inputBuffer += key;
        this.terminal.write(key);
      }
    });

    // Auto-resize on container resize
    this.resizeObserver = new ResizeObserver(() => {
      try { this.fitAddon.fit(); } catch {}
    });
    this.resizeObserver.observe(container);
  }

  writeStdout(data: string) {
    this.terminal.write(data);
  }

  writeStderr(data: string) {
    // Red color for stderr
    this.terminal.write(`\x1b[31m${data}\x1b[0m`);
  }

  writeInfo(data: string) {
    // Cyan color for info
    this.terminal.write(`\x1b[36m${data}\x1b[0m`);
  }

  onData(callback: (input: string) => void) {
    this.onInputSubmit = callback;
  }

  clear() {
    this.terminal.clear();
    this.terminal.write('\x1b[2J\x1b[H');
    this.inputBuffer = '';
  }

  dispose() {
    this.resizeObserver?.disconnect();
    this.terminal.dispose();
  }

  focus() {
    this.terminal.focus();
  }

  fit() {
    try { this.fitAddon.fit(); } catch {}
  }
}
