import { NotebookCell, CellOutput } from './NotebookRenderer';
import { PythonRuntime } from '../runtimes/PythonRuntime';

/** Parse a raw .ipynb JSON string into our cell model */
export function parseNotebook(json: string): NotebookCell[] {
  try {
    const nb = JSON.parse(json);
    const cells = nb.cells || [];

    return cells.map((cell: any, i: number) => ({
      id: `cell-${i}-${Date.now()}`,
      type: cell.cell_type === 'code' ? 'code' : 'markdown',
      source: Array.isArray(cell.source) ? cell.source.join('') : (cell.source || ''),
      outputs: (cell.outputs || []).map((o: any) => parseOutput(o)),
      executionCount: cell.execution_count ?? null,
      isRunning: false,
    }));
  } catch (e) {
    console.error('Failed to parse notebook JSON', e);
    // Return empty notebook if invalid
    return [{
      id: 'cell-0', type: 'code', source: '', outputs: [], executionCount: null, isRunning: false
    }];
  }
}

function parseOutput(raw: any): CellOutput {
  if (raw.output_type === 'stream') {
    return {
      type: raw.name === 'stderr' ? 'stderr' : 'stdout',
      text: Array.isArray(raw.text) ? raw.text.join('') : raw.text,
    };
  }
  if (raw.output_type === 'error') {
    return { type: 'error', traceback: raw.traceback };
  }
  if (raw.output_type === 'display_data' || raw.output_type === 'execute_result') {
    return { type: 'display_data', data: raw.data, text: raw.data?.['text/plain'] };
  }
  return { type: 'stdout', text: JSON.stringify(raw) };
}

/** Serialize cells back to .ipynb format */
export function serializeNotebook(cells: NotebookCell[]): string {
  return JSON.stringify({
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: cells.map(c => ({
      cell_type: c.type,
      source: c.source.split('\n').map((l, i, arr) => i === arr.length - 1 ? l : l + '\n'),
      metadata: {},
      execution_count: c.type === 'code' ? (c.executionCount || null) : undefined,
      outputs: c.type === 'code' ? c.outputs.map(o => ({
        output_type: o.type === 'error' ? 'error'
          : o.type === 'display_data' ? 'display_data' : 'stream',
        ...(o.type === 'error' ? { traceback: o.traceback } : {}),
        ...(o.type === 'display_data' ? { data: o.data } : {}),
        ...(o.type === 'stdout' || o.type === 'stderr'
          ? { name: o.type, text: o.text?.split('\n').map((l, i, arr) => i === arr.length - 1 ? l : l + '\n') } : {}),
      })) : undefined,
    })),
  }, null, 2);
}

/**
 * Execute notebook cells using Pyodide.
 * Maintains kernel state across cells.
 */
export class NotebookKernel {
  private runtime = new PythonRuntime();
  private executionCount = 0;

  async runCell(
    cell: NotebookCell,
    onOutput: (outputs: CellOutput[]) => void,
    onInputRequest: () => void
  ): Promise<CellOutput[]> {
    const outputs: CellOutput[] = [];
    this.executionCount++;

    await this.runtime.execute(cell.source, {
      onStdout: (data) => {
        // Find existing stdout and append, or create new
        const last = outputs[outputs.length - 1];
        if (last && last.type === 'stdout') {
          last.text = (last.text || '') + data;
        } else {
          outputs.push({ type: 'stdout', text: data });
        }
        onOutput([...outputs]);
      },
      onStderr: (data) => {
        const last = outputs[outputs.length - 1];
        if (last && last.type === 'stderr') {
          last.text = (last.text || '') + data;
        } else {
          outputs.push({ type: 'stderr', text: data });
        }
        onOutput([...outputs]);
      },
      onRequestInput: onInputRequest,
      onExit: () => {},
    });

    return outputs;
  }

  sendInput(text: string) { this.runtime.sendInput(text); }
  getExecutionCount() { return this.executionCount; }
  terminate() { this.runtime.terminate(); }
}
