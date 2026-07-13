import { RuntimeCallbacks } from '../types';

declare global {
  interface Window { loadPyodide: any; }
}

let pyodideInstance: any = null;
let pyodideLoading: Promise<any> | null = null;

async function getPyodide(onProgress: (msg: string) => void): Promise<any> {
  if (pyodideInstance) return pyodideInstance;

  if (!pyodideLoading) {
    pyodideLoading = (async () => {
      // Load Pyodide script if not present
      if (!window.loadPyodide) {
        onProgress('Loading Python runtime (first time may take a few seconds)...\r\n');
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Failed to load Pyodide'));
          document.head.appendChild(script);
        });
      }

      onProgress('Initializing Python kernel...\r\n');
      pyodideInstance = await window.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
      });
      return pyodideInstance;
    })();
  }

  return pyodideLoading;
}

export class PythonRuntime {
  private inputResolve: ((value: string) => void) | null = null;
  private running = false;

  async execute(code: string, callbacks: RuntimeCallbacks): Promise<void> {
    this.running = true;

    try {
      const pyodide = await getPyodide((msg) => callbacks.onStdout(`\x1b[36m${msg}\x1b[0m`));
      callbacks.onStdout('\x1b[36m[Python ready]\x1b[0m\r\n');

      // Redirect stdout/stderr
      pyodide.setStdout({ batched: (msg: string) => {
        if (this.running) callbacks.onStdout(msg + '\r\n');
      }});
      pyodide.setStderr({ batched: (msg: string) => {
        if (this.running) callbacks.onStderr(msg + '\r\n');
      }});

      // Set up interactive input() support
      // We store a JS callback on the window that Python can call
      (window as any).__syncscript_input = (promptText: string): Promise<string> => {
        if (promptText) callbacks.onStdout(promptText);
        callbacks.onRequestInput?.();
        return new Promise<string>((resolve) => {
          this.inputResolve = resolve;
        });
      };

      // Wrap user code with input() monkey-patch
      const wrappedCode = `
import asyncio
from pyodide.ffi import to_js
from js import window

_orig_input = input

async def _async_input(prompt=""):
    result = await window.__syncscript_input(prompt)
    return str(result)

def _sync_input(prompt=""):
    import asyncio
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(_async_input(prompt))

__builtins__.input = _sync_input

${code}
`;

      await pyodide.runPythonAsync(wrappedCode);
      if (this.running) callbacks.onExit(0);
    } catch (err: any) {
      if (!this.running) return; // terminated
      const msg = err.message || String(err);
      // Clean up Pyodide stack noise
      const lines = msg.split('\n');
      const cleaned = lines.filter((l: string) =>
        !l.includes('pyodide.asm') && !l.includes('JsProxy') && l.trim() !== ''
      ).join('\r\n');
      callbacks.onStderr((cleaned || msg) + '\r\n');
      callbacks.onExit(1);
    }
  }

  sendInput(text: string) {
    if (this.inputResolve) {
      this.inputResolve(text);
      this.inputResolve = null;
    }
  }

  terminate() {
    this.running = false;
    this.inputResolve = null;
  }
}
