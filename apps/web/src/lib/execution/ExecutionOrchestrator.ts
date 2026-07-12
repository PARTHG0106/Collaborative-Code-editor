import { ExecutionTarget, RuntimeCallbacks } from './types';
import { BrowserExecutor } from './BrowserExecutor';
import { analyzeCode } from './security';

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  cs: 'csharp',
  kt: 'kotlin',
  ipynb: 'jupyter',
};

export function getLangFromFilename(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext] || null;
}

export class ExecutionOrchestrator {
  private browserExecutor = new BrowserExecutor();
  private agentAvailable = false;
  private agentLanguages: string[] = [];
  private agentSendInput?: (text: string) => void;
  private statusListeners: Array<(target: ExecutionTarget | null, running: boolean) => void> = [];

  private currentTarget: ExecutionTarget | null = null;
  private isRunning = false;

  setAgentStatus(available: boolean, languages: string[] = []) {
    this.agentAvailable = available;
    this.agentLanguages = languages;
  }

  setAgentInputHandler(handler: (text: string) => void) {
    this.agentSendInput = handler;
  }

  onStatusChange(cb: (target: ExecutionTarget | null, running: boolean) => void) {
    this.statusListeners.push(cb);
  }

  private emitStatus(target: ExecutionTarget | null, running: boolean) {
    this.currentTarget = target;
    this.isRunning = running;
    this.statusListeners.forEach(cb => cb(target, running));
  }

  selectTarget(language: string): ExecutionTarget {
    if (BrowserExecutor.SUPPORTED.includes(language)) return 'browser';
    if (this.agentAvailable && this.agentLanguages.includes(language)) return 'local-agent';
    return 'remote';
  }

  getTargetLabel(target: ExecutionTarget): string {
    switch (target) {
      case 'browser': return '🌐 Browser';
      case 'local-agent': return '💻 Local';
      case 'remote': return '☁️ Remote';
    }
  }

  async execute(
    filename: string,
    code: string,
    callbacks: RuntimeCallbacks,
    // Optional overrides for agent/remote execution
    agentExecute?: (lang: string, code: string, cb: RuntimeCallbacks) => Promise<void>,
    remoteExecute?: (lang: string, code: string, cb: RuntimeCallbacks) => Promise<void>,
  ) {
    const language = getLangFromFilename(filename);
    if (!language) {
      callbacks.onStderr(`Unsupported file type: ${filename}\r\n`);
      callbacks.onExit(1);
      return;
    }

    const target = this.selectTarget(language);
    this.emitStatus(target, true);

    callbacks.onStdout(`\x1b[36m[${this.getTargetLabel(target)} | ${language}]\x1b[0m\r\n`);

    // Run Security Analysis
    const analysis = analyzeCode(code, language);
    if (!analysis.safe) {
      callbacks.onStderr(`\x1b[31m[Security Block] Execution aborted:\x1b[0m\r\n`);
      analysis.blocked.forEach(msg => callbacks.onStderr(`- ${msg}\r\n`));
      this.emitStatus(null, false);
      callbacks.onExit(1);
      return;
    }
    if (analysis.warnings.length > 0) {
      callbacks.onStdout(`\x1b[33m[Warnings]:\x1b[0m\r\n`);
      analysis.warnings.forEach(msg => callbacks.onStdout(`- ${msg}\r\n`));
    }

    const wrappedCallbacks: RuntimeCallbacks = {
      ...callbacks,
      onExit: (code) => {
        this.emitStatus(null, false);
        callbacks.onExit(code);
      },
    };

    try {
      switch (target) {
        case 'browser':
          await this.browserExecutor.execute(language, code, wrappedCallbacks);
          break;
        case 'local-agent':
          if (agentExecute) {
            await agentExecute(language, code, wrappedCallbacks);
          } else {
            wrappedCallbacks.onStderr('Local agent not configured\r\n');
            wrappedCallbacks.onExit(1);
          }
          break;
        case 'remote':
          if (remoteExecute) {
            await remoteExecute(language, code, wrappedCallbacks);
          } else {
            wrappedCallbacks.onStderr('Remote execution not configured\r\n');
            wrappedCallbacks.onExit(1);
          }
          break;
      }
    } catch (err: any) {
      this.emitStatus(null, false);
      callbacks.onStderr(`Execution error: ${err.message}\r\n`);
      callbacks.onExit(1);
    }
  }

  sendInput(text: string) {
    if (this.currentTarget === 'browser') {
      this.browserExecutor.sendInput(text);
    } else if (this.currentTarget === 'local-agent' && this.agentSendInput) {
      this.agentSendInput(text);
    }
  }

  cancel() {
    this.browserExecutor.terminate();
    this.emitStatus(null, false);
  }

  getCurrentTarget() { return this.currentTarget; }
  getIsRunning() { return this.isRunning; }
}
