import { RuntimeCallbacks } from '../types';

declare global {
  interface Window { loadPyodide: any; }
}

export interface PythonExecutionOptions {
  onResult?: (result: string) => void;
  // Pyodide runs on the main thread, so stdin must return synchronously.
  onInput?: () => string | null;
}

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
let pyodideInstance: any = null;
let pyodideLoading: Promise<any> | null = null;
let executionQueue: Promise<void> = Promise.resolve();

function withInterpreter<T>(work: () => T | Promise<T>): Promise<T> {
  const execution = executionQueue.then(work);
  executionQueue = execution.then(() => {}, () => {});
  return execution;
}

async function getPyodide(onProgress: (msg: string) => void): Promise<any> {
  if (pyodideInstance) return pyodideInstance;

  if (!pyodideLoading) {
    pyodideLoading = (async () => {
      if (!window.loadPyodide) {
        onProgress('Loading Python runtime (first time may take a few seconds)...\r\n');
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = `${PYODIDE_URL}pyodide.js`;
          script.onload = () => resolve();
          script.onerror = () => {
            script.remove();
            reject(new Error('Failed to load Pyodide. Check your connection and run the cell again.'));
          };
          document.head.appendChild(script);
        });
      }

      onProgress('Initializing Python kernel...\r\n');
      pyodideInstance = await window.loadPyodide({ indexURL: PYODIDE_URL });
      return pyodideInstance;
    })().catch((error) => {
      // A transient CDN or initialization failure must not poison later runs.
      pyodideLoading = null;
      throw error;
    });
  }

  return pyodideLoading;
}

function installRequirements(command: string): string[] {
  const match = command.match(/^[!%]pip\s+install(?:\s+(.*))?$/);
  if (!match) {
    throw new Error('Browser Python supports %pip install and !pip install, but cannot run other shell commands or IPython magics. Use a local or remote Python runtime for those commands.');
  }

  const args: string[] = [];
  let current = '';
  let quote = '';
  for (const char of (match[1] ?? '').trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('Unclosed quote in pip install command.');
  if (current) args.push(current);

  const requirements = args.filter((arg) => !/^-q+$/.test(arg) && arg !== '--quiet');
  if (!requirements.length) throw new Error('Provide a package name, for example: %pip install pandas');
  for (const requirement of requirements) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+(?:,(?:===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+)*)?$/.test(requirement)) {
      throw new Error(`Unsupported pip argument "${requirement}". Browser installs accept package names and version requirements, plus -q or --quiet. Use a local or remote runtime for other pip options or shell syntax.`);
    }
  }
  return requirements;
}

function prepareCode(code: string): { source: string; requirements: string[] } {
  const requirements: string[] = [];
  let quote = '';
  let brackets = 0;
  let continuation = false;
  const lines = code.split('\n').map((line) => {
    // Avoid interpreting text inside strings, comments, or continued expressions
    // as a notebook command (e.g. a multiline string containing !pip).
    if (!quote && brackets === 0 && !continuation && /^\s*[!%]/.test(line)) {
      if (/^\s+\S/.test(line)) {
        throw new Error('Run pip install commands at the top level of a notebook cell.');
      }
      requirements.push(...installRequirements(line.trim()));
      return '';
    }

    continuation = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (char === '\\') { i++; continue; }
        if (line.startsWith(quote, i)) {
          i += quote.length - 1;
          quote = '';
        }
      } else if (char === '#') {
        break;
      } else if (char === '"' || char === "'") {
        quote = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
        i += quote.length - 1;
      } else if ('([{'.includes(char)) {
        brackets++;
      } else if (')]}'.includes(char)) {
        brackets = Math.max(0, brackets - 1);
      } else if (char === '\\' && i === line.length - 1) {
        continuation = true;
      }
    }
    return line;
  });
  return { source: lines.join('\n'), requirements };
}

// Evaluate in the notebook's own namespace, but keep execution helpers private.
// Formatting in Python preserves repr for strings, booleans, floats and PyProxy
// objects, while eval_code_async suppresses a trailing semicolon as Jupyter does.
const EVALUATE_CELL = `
from asyncio import current_task
from pyodide.code import eval_code_async
register_task(current_task())
value = await eval_code_async(source, globals=namespace)
repr(value) if value is not None else None
`;

export class PythonRuntime {
  private globals: any = null;
  private generation = 0;
  private cancelCurrentRun: (() => void) | null = null;

  execute(code: string, callbacks: RuntimeCallbacks, options: PythonExecutionOptions = {}): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;

    // Stdout, stderr and stdin belong to the shared interpreter. The lock covers
    // initialization, package loading and evaluation so another notebook cannot
    // replace the active cell's callbacks while it is awaiting Python work.
    return withInterpreter(async () => {
      if (!isCurrent()) return;
      let executionGlobals: any = null;
      let inputError: Error | null = null;
      let pythonTask: any = null;
      const cancel = () => pythonTask?.cancel();
      try {
        const prepared = prepareCode(code);
        const pyodide = await getPyodide((msg) => {
          if (isCurrent()) callbacks.onStdout(`\x1b[36m${msg}\x1b[0m`);
        });
        if (!isCurrent()) return;
        callbacks.onStdout('\x1b[36m[Python ready]\x1b[0m\r\n');

        const packageCallbacks = {
          messageCallback: (msg: string) => { if (isCurrent()) callbacks.onStdout(`${msg}\r\n`); },
          errorCallback: (msg: string) => { if (isCurrent()) callbacks.onStderr(`${msg}\r\n`); },
        };
        pyodide.setStdout({ batched: packageCallbacks.messageCallback });
        pyodide.setStderr({ batched: packageCallbacks.errorCallback });
        pyodide.setStdin({ stdin: () => {
          if (!isCurrent()) return null;
          if (!options.onInput) {
            inputError = new Error('Interactive input requires a synchronous input handler in browser Python. Run this code in a notebook or use a local or remote Python runtime.');
            return null;
          }
          try {
            callbacks.onRequestInput?.();
            return options.onInput();
          } catch (error) {
            // Pyodide converts errors thrown by stdin into an opaque I/O error.
            // Return EOF and retain the original message for the cell instead.
            inputError = error instanceof Error ? error : new Error(String(error));
            return null;
          }
        }});

        for (const requirement of prepared.requirements) {
          if (!isCurrent()) return;
          try {
            // Bundled scientific packages include WebAssembly extensions that
            // ordinary PyPI wheels cannot provide. Versioned requirements go to
            // micropip so a requested version is never silently ignored.
            if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requirement)) {
              try {
                const errors: string[] = [];
                await pyodide.loadPackage(requirement, {
                  ...packageCallbacks,
                  errorCallback: (message: string) => errors.push(message),
                });
                // Pyodide 0.26 reports download/install failures via its callback
                // and resolves the promise, so check those errors explicitly.
                if (errors.length) throw new Error(errors.join('\n'));
                continue;
              } catch (error) {
                if (!(error instanceof Error) || !error.message.startsWith('No known package with name')) throw error;
                // Not a bundled package; try a compatible pure-Python wheel.
              }
            }
            await pyodide.loadPackage('micropip', packageCallbacks);
            const micropip = pyodide.pyimport('micropip');
            try {
              await micropip.install(requirement);
            } finally {
              micropip.destroy();
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Unable to install "${requirement}". Browser Python supports Pyodide packages and compatible pure-Python wheels. ${detail}`);
          }
        }

        if (!isCurrent()) return;
        await pyodide.loadPackagesFromImports(prepared.source, packageCallbacks);
        if (!isCurrent()) return;
        if (!this.globals) this.globals = pyodide.runPython('dict(__name__="__main__")');
        executionGlobals = pyodide.toPy({
          source: prepared.source,
          namespace: this.globals,
          register_task: (task: any) => {
            // Callback arguments are borrowed PyProxies; retain the task until
            // evaluation settles so Stop can cancel a cell awaiting Python work.
            pythonTask = task.copy();
            if (!isCurrent()) cancel();
          },
        });
        this.cancelCurrentRun = cancel;
        const result = await pyodide.runPythonAsync(EVALUATE_CELL, { globals: executionGlobals });
        if (inputError) throw inputError;
        if (isCurrent()) {
          if (result != null) options.onResult?.(String(result));
          callbacks.onExit(0);
        }
      } catch (error) {
        if (!isCurrent()) return;
        const failure = inputError ?? error;
        const msg = failure instanceof Error ? failure.message : String(failure);
        const cleaned = msg.split('\n').filter((line) =>
          !line.includes('pyodide.asm') && !line.includes('JsProxy') && line.trim() !== ''
        ).join('\r\n');
        callbacks.onStderr((cleaned || msg) + '\r\n');
        callbacks.onExit(1);
      } finally {
        if (this.cancelCurrentRun === cancel) this.cancelCurrentRun = null;
        pythonTask?.destroy();
        executionGlobals?.destroy();
      }
    });
  }

  // Retained for BrowserExecutor's common runtime interface. Browser Python's
  // synchronous stdin is supplied through execute's onInput option instead.
  sendInput(_text: string) {}

  terminate() {
    this.generation++;
    this.cancelCurrentRun?.();
    const globals = this.globals;
    this.globals = null;
    if (globals) void withInterpreter(() => globals.destroy());
  }
}
