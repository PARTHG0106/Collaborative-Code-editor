import { RuntimeCallbacks } from '../types';

export class JavaScriptRuntime {
  private worker: Worker | null = null;

  async execute(code: string, callbacks: RuntimeCallbacks): Promise<void> {
    const blob = new Blob([this.buildWorkerScript(code)], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    this.worker = new Worker(url);

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        callbacks.onStderr('\n[Execution timed out after 15 seconds]\n');
        this.terminate();
        callbacks.onExit(1);
        resolve();
      }, 15000);

      this.worker!.onmessage = (e) => {
        const { type, data } = e.data;
        switch (type) {
          case 'stdout': callbacks.onStdout(data); break;
          case 'stderr': callbacks.onStderr(data); break;
          case 'request-input': callbacks.onRequestInput(); break;
          case 'exit':
            clearTimeout(timeout);
            URL.revokeObjectURL(url);
            callbacks.onExit(data ?? 0);
            resolve();
            break;
        }
      };

      this.worker!.onerror = (err) => {
        clearTimeout(timeout);
        URL.revokeObjectURL(url);
        callbacks.onStderr(err.message || 'Unknown worker error');
        callbacks.onExit(1);
        resolve();
      };
    });
  }

  sendInput(text: string) {
    this.worker?.postMessage({ type: 'stdin', data: text });
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
  }

  private buildWorkerScript(userCode: string): string {
    // Escape backticks and backslashes in user code for safe embedding
    const escapedCode = userCode.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

    return `
      const _stdout = (msg) => postMessage({ type: 'stdout', data: String(msg) });
      const _stderr = (msg) => postMessage({ type: 'stderr', data: String(msg) });

      const console = {
        log: (...args) => _stdout(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') + '\\n'),
        error: (...args) => _stderr(args.map(a => String(a)).join(' ') + '\\n'),
        warn: (...args) => _stdout(args.map(a => String(a)).join(' ') + '\\n'),
        info: (...args) => _stdout(args.map(a => String(a)).join(' ') + '\\n'),
        dir: (...args) => _stdout(args.map(a => JSON.stringify(a, null, 2)).join(' ') + '\\n'),
        table: (data) => _stdout(JSON.stringify(data, null, 2) + '\\n'),
      };

      const _inputQueue = [];
      let _inputWaiting = null;

      self.addEventListener('message', (e) => {
        if (e.data.type === 'stdin') {
          if (_inputWaiting) {
            _inputWaiting(e.data.data);
            _inputWaiting = null;
          } else {
            _inputQueue.push(e.data.data);
          }
        }
      });

      const prompt = (msg) => {
        if (msg) _stdout(msg);
        postMessage({ type: 'request-input' });
        return new Promise((resolve) => {
          if (_inputQueue.length > 0) {
            resolve(_inputQueue.shift());
          } else {
            _inputWaiting = resolve;
          }
        });
      };

      const readline = prompt;

      (async () => {
        try {
          await (async function() {
            ${userCode}
          })();
          postMessage({ type: 'exit', data: 0 });
        } catch (err) {
          _stderr((err.stack || err.message || String(err)) + '\\n');
          postMessage({ type: 'exit', data: 1 });
        }
      })();
    `;
  }
}
