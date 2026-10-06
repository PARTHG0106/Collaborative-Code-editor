import type { NotebookCell, CellOutput } from './NotebookRenderer';
import { PythonRuntime } from '../runtimes/PythonRuntime';

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value) && value.every(part => typeof part === 'string'));
}

function text(value: unknown): string {
  return Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : '';
}

/** Empty newly-created files are allowed; malformed existing notebooks are not editable. */
export function getNotebookError(json: string): string | null {
  if (!json.trim()) return null;
  let notebook: unknown;
  try { notebook = JSON.parse(json); } catch { return 'This notebook is not valid JSON. Repair its source before editing cells.'; }
  if (!isRecord(notebook) || !Array.isArray(notebook.cells)) return 'This notebook must contain a cells array.';
  if (notebook.nbformat !== undefined && notebook.nbformat !== 4) return 'Only Jupyter notebook format 4 is supported.';
  if (notebook.metadata !== undefined && !isRecord(notebook.metadata)) return 'This notebook has invalid metadata.';
  for (const [index, cell] of notebook.cells.entries()) {
    if (!isRecord(cell) || !['code', 'markdown', 'raw'].includes(cell.cell_type)
      || (cell.source !== undefined && !isText(cell.source))
      || (cell.metadata !== undefined && !isRecord(cell.metadata))
      || (cell.attachments !== undefined && !isRecord(cell.attachments))) {
      return `Cell ${index + 1} has an invalid notebook structure.`;
    }
    if (cell.outputs !== undefined && (!Array.isArray(cell.outputs) || cell.outputs.some((output: unknown) =>
      !isRecord(output) || !['stream', 'error', 'display_data', 'execute_result'].includes(output.output_type)
      || (output.output_type === 'stream' && !isText(output.text))
      || (output.output_type === 'error' && (!Array.isArray(output.traceback) || !output.traceback.every((line: unknown) => typeof line === 'string')))
      || (['display_data', 'execute_result'].includes(output.output_type) && !isRecord(output.data))))) {
      return `Cell ${index + 1} has invalid output data.`;
    }
  }
  return null;
}

/** Parse cells without discarding notebook fields needed for a lossless save. */
export function parseNotebook(json: string): NotebookCell[] {
  if (getNotebookError(json)) return [];
  if (!json.trim()) return [{ id: 'cell-0', type: 'code', source: '', outputs: [], executionCount: null, isRunning: false }];
  const notebook = JSON.parse(json);
  const ids = new Set<string>();
  const reservedIds = new Set<string>(notebook.cells.map((cell: any) => cell.id).filter((id: unknown) => typeof id === 'string'));
  return notebook.cells.map((cell: any, index: number) => {
    let id = typeof cell.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(cell.id) ? cell.id : '';
    if (!id || ids.has(id)) {
      id = `cell-${index}`;
      while (ids.has(id) || reservedIds.has(id)) id += '-new';
    }
    ids.add(id);
    return {
      id, type: cell.cell_type, source: text(cell.source),
      outputs: (cell.outputs || []).map(parseOutput),
      executionCount: Number.isInteger(cell.execution_count) ? cell.execution_count : null,
      isRunning: false,
      original: cell,
    };
  });
}

function parseOutput(raw: any): CellOutput {
  if (raw.output_type === 'stream') {
    return { type: raw.name === 'stderr' ? 'stderr' : 'stdout', text: text(raw.text), original: raw };
  }
  if (raw.output_type === 'error') {
    return { type: 'error', traceback: raw.traceback, ename: raw.ename, evalue: raw.evalue, original: raw };
  }
  return {
    type: raw.output_type,
    data: raw.data,
    text: text(raw.data?.['text/plain']),
    executionCount: raw.execution_count,
    original: raw,
  };
}

function serializeOutput(output: CellOutput): Record<string, unknown> {
  const original = output.original ?? {};
  if (output.type === 'error') {
    return { ...original, output_type: 'error', ename: output.ename ?? original.ename ?? 'Error',
      evalue: output.evalue ?? original.evalue ?? '', traceback: output.traceback ?? [] };
  }
  if (output.type === 'display_data' || output.type === 'execute_result') {
    return { ...original, output_type: output.type, data: output.data ?? { 'text/plain': output.text ?? '' },
      metadata: isRecord(original.metadata) ? original.metadata : {},
      ...(output.type === 'execute_result' ? { execution_count: output.executionCount ?? original.execution_count ?? null } : {}),
    };
  }
  return { ...original, output_type: 'stream', name: output.type, text: output.text ?? '' };
}

/** Keep document metadata, cell attachments and MIME output fields from the source. */
export function serializeNotebook(cells: NotebookCell[], originalJson?: string): string {
  if (originalJson !== undefined) {
    const error = getNotebookError(originalJson);
    if (error) throw new Error(error);
  }
  const original = originalJson?.trim() ? JSON.parse(originalJson) : {};
  const originals = new Map(originalJson ? parseNotebook(originalJson).map(cell => [cell.id, cell.original]) : []);
  return JSON.stringify({
    ...original,
    nbformat: 4, nbformat_minor: Math.max(5, Number.isInteger(original.nbformat_minor) ? original.nbformat_minor : 5),
    metadata: original.metadata ?? { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: cells.map(cell => {
      const source = originals.get(cell.id) ?? cell.original ?? {};
      const result: Record<string, unknown> = {
        ...source, id: cell.id, cell_type: cell.type, source: cell.source,
        metadata: isRecord(source.metadata) ? source.metadata : {},
      };
      if (cell.type === 'code') {
        result.execution_count = cell.executionCount ?? null;
        result.outputs = cell.outputs.map(serializeOutput);
      } else {
        delete result.execution_count;
        delete result.outputs;
      }
      return result;
    }),
  }, null, 2);
}

/** Execute notebook cells in one isolated, persistent Python namespace. */
export class NotebookKernel {
  private runtime = new PythonRuntime();
  private executionCount = 0;

  async runCell(
    cell: NotebookCell,
    onOutput: (outputs: CellOutput[]) => void,
    onInput: () => string | null,
  ): Promise<CellOutput[]> {
    const outputs: CellOutput[] = [];
    const executionCount = ++this.executionCount;
    const appendStream = (type: 'stdout' | 'stderr', data: string) => {
      // eslint-disable-next-line no-control-regex
      const cleanData = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (!cleanData || (type === 'stdout' && data.startsWith('\x1b[36m')
        && /^(?:\[Python ready\]|Loading Python runtime|Initializing Python kernel)/.test(cleanData))) return;
      const last = outputs[outputs.length - 1];
      if (last?.type === type) last.text = (last.text ?? '') + cleanData;
      else outputs.push({ type, text: cleanData });
      onOutput(outputs.map(output => ({ ...output })));
    };

    await this.runtime.execute(cell.source, {
      onStdout: data => appendStream('stdout', data),
      onStderr: data => appendStream('stderr', data),
      onExit: () => {},
    }, {
      onInput,
      onResult: result => {
        outputs.push({ type: 'execute_result', data: { 'text/plain': result }, executionCount });
        onOutput(outputs.map(output => ({ ...output })));
      },
    });
    return outputs;
  }

  getExecutionCount() { return this.executionCount; }
  terminate() { this.runtime.terminate(); }
}
