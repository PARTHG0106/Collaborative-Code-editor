import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeCallbacks } from '../types';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function callbacks(): RuntimeCallbacks {
  return { onStdout: vi.fn(), onStderr: vi.fn(), onRequestInput: vi.fn(), onExit: vi.fn() };
}

function mockPyodide() {
  return {
    setStdout: vi.fn(),
    setStderr: vi.fn(),
    setStdin: vi.fn(),
    loadPackage: vi.fn().mockResolvedValue(undefined),
    loadPackagesFromImports: vi.fn().mockResolvedValue(undefined),
    runPython: vi.fn(() => ({ destroy: vi.fn() })),
    toPy: vi.fn((data: Record<string, unknown>) => ({ ...data, destroy: vi.fn() })),
    runPythonAsync: vi.fn().mockResolvedValue(undefined),
    pyimport: vi.fn(() => ({ install: vi.fn().mockResolvedValue(undefined), destroy: vi.fn() })),
  };
}

describe('PythonRuntime', () => {
  let pyodide: ReturnType<typeof mockPyodide>;
  let PythonRuntime: typeof import('./PythonRuntime').PythonRuntime;

  beforeEach(async () => {
    vi.resetModules();
    pyodide = mockPyodide();
    window.loadPyodide = vi.fn().mockResolvedValue(pyodide);
    ({ PythonRuntime } = await import('./PythonRuntime'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('script[src*="pyodide"]').forEach((script) => script.remove());
    window.loadPyodide = undefined;
  });

  it('loads imports and returns the Python-formatted expression result', async () => {
    pyodide.runPythonAsync.mockResolvedValueOnce("'hello'");
    const onResult = vi.fn();
    const output = callbacks();
    await new PythonRuntime().execute('import numpy\n"hello"', output, { onResult });

    expect(pyodide.loadPackagesFromImports).toHaveBeenCalledWith('import numpy\n"hello"', expect.any(Object));
    expect(pyodide.runPythonAsync).toHaveBeenCalledWith(expect.stringContaining('repr(value)'), {
      globals: expect.objectContaining({ source: 'import numpy\n"hello"' }),
    });
    expect(onResult).toHaveBeenCalledWith("'hello'");
    expect(output.onExit).toHaveBeenCalledOnce();
    expect(output.onExit).toHaveBeenCalledWith(0);
    expect(pyodide.toPy.mock.results[0].value.destroy).toHaveBeenCalledOnce();
  });

  it('does not emit a result for statements or None', async () => {
    const onResult = vi.fn();
    await new PythonRuntime().execute('value = 42', callbacks(), { onResult });
    expect(onResult).not.toHaveBeenCalled();
  });

  it('keeps notebook variables in a persistent, private namespace', async () => {
    const first = new PythonRuntime();
    const second = new PythonRuntime();
    await first.execute('value = 42', callbacks());
    await first.execute('value', callbacks());
    await second.execute('value', callbacks());

    const namespaces = pyodide.toPy.mock.calls.map(([data]) => data.namespace);
    expect(namespaces[0]).toBe(namespaces[1]);
    expect(namespaces[2]).not.toBe(namespaces[0]);
    expect(pyodide.runPython).toHaveBeenCalledTimes(2);
  });

  it.each(['!pip install pandas', '%pip install -q pandas'])('loads bundled packages for %s', async (source) => {
    const output = callbacks();
    await new PythonRuntime().execute(`${source}\nimport pandas`, output);

    expect(pyodide.loadPackage).toHaveBeenCalledWith('pandas', expect.any(Object));
    expect(pyodide.pyimport).not.toHaveBeenCalled();
    expect(pyodide.loadPackagesFromImports).toHaveBeenCalledWith('\nimport pandas', expect.any(Object));
    expect(output.onExit).toHaveBeenCalledWith(0);
  });

  it('falls back to micropip for packages outside the Pyodide distribution', async () => {
    pyodide.loadPackage.mockRejectedValueOnce(new Error("No known package with name 'sampleproject'"));
    const micropip = { install: vi.fn().mockResolvedValue(undefined), destroy: vi.fn() };
    pyodide.pyimport.mockReturnValue(micropip);
    await new PythonRuntime().execute('%pip install sampleproject', callbacks());

    expect(pyodide.loadPackage).toHaveBeenNthCalledWith(2, 'micropip', expect.any(Object));
    expect(micropip.install).toHaveBeenCalledWith('sampleproject');
    expect(micropip.destroy).toHaveBeenCalledOnce();
  });

  it('honors quoted version requirements through micropip', async () => {
    const micropip = { install: vi.fn().mockResolvedValue(undefined), destroy: vi.fn() };
    pyodide.pyimport.mockReturnValue(micropip);
    await new PythonRuntime().execute('%pip install "packaging>=23.0,<25"', callbacks());
    expect(pyodide.loadPackage).toHaveBeenCalledOnce();
    expect(pyodide.loadPackage).toHaveBeenCalledWith('micropip', expect.any(Object));
    expect(micropip.install).toHaveBeenCalledWith('packaging>=23.0,<25');
  });

  it('detects Pyodide package failures reported only through its error callback', async () => {
    pyodide.loadPackage.mockImplementationOnce(async (_name, options) => {
      options.errorCallback('Failed to download pandas');
      return [];
    });
    const output = callbacks();
    await new PythonRuntime().execute('!pip install pandas', output);
    expect(output.onStderr).toHaveBeenCalledWith(expect.stringContaining('Failed to download pandas'));
    expect(output.onExit).toHaveBeenCalledWith(1);
    expect(pyodide.pyimport).not.toHaveBeenCalled();
    expect(pyodide.runPythonAsync).not.toHaveBeenCalled();
  });

  it('explains packages that cannot run in the browser and releases micropip', async () => {
    const micropip = { install: vi.fn().mockRejectedValue(new Error('No pure Python wheel found')), destroy: vi.fn() };
    pyodide.pyimport.mockReturnValue(micropip);
    const output = callbacks();
    await new PythonRuntime().execute('%pip install nativepackage==1.0', output);
    expect(output.onStderr).toHaveBeenCalledWith(expect.stringContaining('compatible pure-Python wheels'));
    expect(output.onExit).toHaveBeenCalledWith(1);
    expect(micropip.destroy).toHaveBeenCalledOnce();
    expect(pyodide.runPythonAsync).not.toHaveBeenCalled();
  });

  it.each(['!ls -la', '%matplotlib inline', '!pip install pandas && curl example.com', '%pip install --upgrade pandas'])('rejects unsupported notebook commands: %s', async (source) => {
    const output = callbacks();
    await new PythonRuntime().execute(source, output);
    expect(output.onStderr).toHaveBeenCalledWith(expect.stringContaining('local or remote'));
    expect(output.onExit).toHaveBeenCalledWith(1);
    expect(window.loadPyodide).not.toHaveBeenCalled();
  });

  it('preserves command-like text inside strings and modulo expressions', async () => {
    const source = 'message = """\n!pip install pandas\n"""\nvalue = (10\n% 3)';
    await new PythonRuntime().execute(source, callbacks());
    expect(pyodide.loadPackage).not.toHaveBeenCalled();
    expect(pyodide.loadPackagesFromImports).toHaveBeenCalledWith(source, expect.any(Object));
  });

  it('reads synchronous stdin and lets cancellation return EOF', async () => {
    const onInput = vi.fn().mockReturnValueOnce('Ada').mockReturnValueOnce(null);
    const output = callbacks();
    pyodide.runPythonAsync.mockImplementationOnce(async () => {
      const stdin = pyodide.setStdin.mock.calls[0][0].stdin;
      expect(stdin()).toBe('Ada');
      expect(stdin()).toBeNull();
    });
    await new PythonRuntime().execute('input("Name: ")', output, { onInput });
    expect(output.onRequestInput).toHaveBeenCalledTimes(2);
    expect(output.onExit).toHaveBeenCalledWith(0);
    expect(pyodide.runPythonAsync.mock.calls[0][0]).not.toContain('run_until_complete');
  });

  it('reports missing synchronous input support instead of waiting forever', async () => {
    const output = callbacks();
    pyodide.runPythonAsync.mockImplementationOnce(async () => pyodide.setStdin.mock.calls[0][0].stdin());
    await new PythonRuntime().execute('input()', output);
    expect(output.onStderr).toHaveBeenCalledWith(expect.stringContaining('synchronous input handler'));
    expect(output.onRequestInput).not.toHaveBeenCalled();
    expect(output.onExit).toHaveBeenCalledWith(1);
  });

  it('serializes interpreter use so simultaneous notebooks retain their output callbacks', async () => {
    const firstStarted = deferred();
    const finishFirst = deferred();
    const firstOutput = callbacks();
    const secondOutput = callbacks();
    pyodide.runPythonAsync.mockImplementationOnce(async () => {
      firstStarted.resolve();
      await finishFirst.promise;
      pyodide.setStdout.mock.calls.at(-1)![0].batched('first output');
    });

    const firstRun = new PythonRuntime().execute('await work()', firstOutput);
    await firstStarted.promise;
    const secondRun = new PythonRuntime().execute('print("second")', secondOutput);
    await Promise.resolve();
    expect(pyodide.setStdout).toHaveBeenCalledTimes(1);
    finishFirst.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(firstOutput.onStdout).toHaveBeenCalledWith('first output\r\n');
    expect(secondOutput.onStdout).not.toHaveBeenCalledWith('first output\r\n');
    expect(pyodide.setStdout).toHaveBeenCalledTimes(2);
  });

  it('cancels queued cells and suppresses late output before releasing the namespace', async () => {
    const started = deferred();
    const finish = deferred();
    pyodide.runPythonAsync.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      pyodide.setStdout.mock.calls[0][0].batched('late output');
    });
    const runtime = new PythonRuntime();
    const output = callbacks();
    const queuedOutput = callbacks();
    const active = runtime.execute('await work()', output);
    await started.promise;
    const oldGlobals = pyodide.runPython.mock.results[0].value;
    const queued = runtime.execute('queued()', queuedOutput);
    runtime.terminate();
    expect(oldGlobals.destroy).not.toHaveBeenCalled();
    finish.resolve();
    await Promise.all([active, queued]);
    await runtime.execute('fresh()', callbacks());
    expect(output.onStdout).not.toHaveBeenCalledWith('late output\r\n');
    expect(output.onExit).not.toHaveBeenCalled();
    expect(queuedOutput.onExit).not.toHaveBeenCalled();
    expect(oldGlobals.destroy).toHaveBeenCalledOnce();
    expect(pyodide.runPythonAsync).toHaveBeenCalledTimes(2);
    expect(pyodide.runPython).toHaveBeenCalledTimes(2);
  });

  it('retries initialization after a transient failure', async () => {
    window.loadPyodide = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue(pyodide);
    const runtime = new PythonRuntime();
    const failed = callbacks();
    const retried = callbacks();
    await runtime.execute('1', failed);
    await runtime.execute('2', retried);
    expect(window.loadPyodide).toHaveBeenCalledTimes(2);
    expect(failed.onExit).toHaveBeenCalledWith(1);
    expect(retried.onExit).toHaveBeenCalledWith(0);
  });

  it('cancels an awaiting Python task so Stop releases the shared interpreter queue', async () => {
    const started = deferred();
    const pending = deferred();
    const task = {
      copy: vi.fn(),
      cancel: vi.fn(() => pending.reject(new Error('CancelledError'))),
      destroy: vi.fn(),
    };
    task.copy.mockReturnValue(task);
    pyodide.runPythonAsync.mockImplementationOnce(async (_source, { globals }) => {
      globals.register_task(task);
      started.resolve();
      await pending.promise;
    });
    const runtime = new PythonRuntime();
    const output = callbacks();
    const first = runtime.execute('import asyncio\nawait asyncio.Future()', output);
    await started.promise;
    runtime.terminate();
    const followingOutput = callbacks();
    await Promise.all([first, new PythonRuntime().execute('2 + 3', followingOutput)]);

    expect(task.copy).toHaveBeenCalledOnce();
    expect(task.cancel).toHaveBeenCalledOnce();
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(output.onExit).not.toHaveBeenCalled();
    expect(output.onStderr).not.toHaveBeenCalled();
    expect(followingOutput.onExit).toHaveBeenCalledWith(0);
  });

  it('removes failed loader scripts so a later cell can retry', async () => {
    window.loadPyodide = undefined;
    const runtime = new PythonRuntime();
    const failed = callbacks();
    const first = runtime.execute('1', failed);
    await vi.waitFor(() => expect(document.querySelector('script[src*="pyodide"]')).not.toBeNull());
    document.querySelector('script[src*="pyodide"]')!.dispatchEvent(new Event('error'));
    await first;
    expect(document.querySelector('script[src*="pyodide"]')).toBeNull();

    const retried = callbacks();
    const second = runtime.execute('2', retried);
    await vi.waitFor(() => expect(document.querySelector('script[src*="pyodide"]')).not.toBeNull());
    window.loadPyodide = vi.fn().mockResolvedValue(pyodide);
    document.querySelector('script[src*="pyodide"]')!.dispatchEvent(new Event('load'));
    await second;
    expect(retried.onExit).toHaveBeenCalledWith(0);
  });
});
