import { RuntimeCallbacks } from '../types';
import { JavaScriptRuntime } from './JavaScriptRuntime';

export class TypeScriptRuntime {
  private jsRuntime = new JavaScriptRuntime();
  private tsLoaded = false;

  async execute(code: string, callbacks: RuntimeCallbacks): Promise<void> {
    callbacks.onStdout('\x1b[36m[Transpiling TypeScript...]\x1b[0m\r\n');

    try {
      const ts = await this.loadTypeScript();
      const transpiled = ts.transpileModule(code, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          strict: false,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;

      callbacks.onStdout('\x1b[36m[Running...]\x1b[0m\r\n');
      return this.jsRuntime.execute(transpiled, callbacks);
    } catch (err: any) {
      callbacks.onStderr(`TypeScript compilation error:\r\n${err.message}\r\n`);
      callbacks.onExit(1);
    }
  }

  sendInput(text: string) { this.jsRuntime.sendInput(text); }
  terminate() { this.jsRuntime.terminate(); }

  private async loadTypeScript(): Promise<any> {
    if ((window as any).ts) return (window as any).ts;

    if (!this.tsLoaded) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/typescript@5.5/lib/typescript.min.js';
        script.onload = () => { this.tsLoaded = true; resolve(); };
        script.onerror = () => reject(new Error('Failed to load TypeScript compiler'));
        document.head.appendChild(script);
      });
    }

    return (window as any).ts;
  }
}
