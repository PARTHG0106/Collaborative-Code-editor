import { RuntimeCallbacks } from './types';
import { JavaScriptRuntime } from './runtimes/JavaScriptRuntime';
import { TypeScriptRuntime } from './runtimes/TypeScriptRuntime';
import { PythonRuntime } from './runtimes/PythonRuntime';

type RuntimeInstance = JavaScriptRuntime | TypeScriptRuntime | PythonRuntime;

export class BrowserExecutor {
  private activeRuntime: RuntimeInstance | null = null;

  static SUPPORTED = ['javascript', 'typescript', 'python'];

  canExecute(language: string): boolean {
    return BrowserExecutor.SUPPORTED.includes(language);
  }

  async execute(language: string, code: string, callbacks: RuntimeCallbacks) {
    this.terminate();

    switch (language) {
      case 'javascript':
        this.activeRuntime = new JavaScriptRuntime();
        break;
      case 'typescript':
        this.activeRuntime = new TypeScriptRuntime();
        break;
      case 'python':
        this.activeRuntime = new PythonRuntime();
        break;
      default:
        callbacks.onStderr(`Browser execution not supported for: ${language}\r\n`);
        callbacks.onExit(1);
        return;
    }

    await this.activeRuntime.execute(code, callbacks);
  }

  sendInput(text: string) {
    this.activeRuntime?.sendInput(text);
  }

  terminate() {
    this.activeRuntime?.terminate();
    this.activeRuntime = null;
  }
}
