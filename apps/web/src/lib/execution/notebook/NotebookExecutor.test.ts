import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNotebookError, NotebookKernel, parseNotebook, serializeNotebook } from './NotebookExecutor';

const runtime = vi.hoisted(() => ({ execute: vi.fn(), terminate: vi.fn() }));
vi.mock('../runtimes/PythonRuntime', () => ({ PythonRuntime: class {
  execute = runtime.execute;
  terminate = runtime.terminate;
} }));

describe('notebook cell identity during collaboration', () => {
  it('keeps cell identities across incoming updates and a save/reopen', () => {
    const content = JSON.stringify({ cells: [
      { id: 'shared-cell', cell_type: 'code', source: ['print(1)'], outputs: [] },
      { cell_type: 'markdown', source: ['Notes'] },
    ] });
    const cells = parseNotebook(content);
    const edited = cells.map(cell => ({ ...cell, source: cell.source + '\n' }));
    expect(parseNotebook(content).map(cell => cell.id)).toEqual(cells.map(cell => cell.id));
    expect(parseNotebook(serializeNotebook(edited)).map(cell => cell.id)).toEqual(cells.map(cell => cell.id));
    expect(cells[0]!.id).toBe('shared-cell');
  });

  it('keeps notebook metadata, cell attachments/raw cells, and valid rich/error outputs while editing', () => {
    const notebook = {
      nbformat: 4, nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Research Python', language: 'python' }, custom: { project: 'keep' } },
      custom_field: 'preserved',
      cells: [
        { id: 'code', cell_type: 'code', source: ['value = 3\n', 'value'], metadata: { tags: ['parameters'] }, execution_count: 0,
          outputs: [
            { output_type: 'execute_result', execution_count: 0, metadata: { isolated: true }, data: { 'text/plain': ['3'], 'application/json': { value: 3 } } },
            { output_type: 'error', ename: 'ValueError', evalue: 'bad value', traceback: ['ValueError: bad value'] },
          ],
        },
        { id: 'notes', cell_type: 'markdown', source: '![plot](attachment:plot.png)', metadata: { tags: ['report'] }, attachments: { 'plot.png': { 'image/png': 'aW1hZ2U=' } } },
        { id: 'raw', cell_type: 'raw', source: 'Raw document block', metadata: { format: 'text/x-rst' } },
      ],
    };
    const originalJson = JSON.stringify(notebook);
    const cells = parseNotebook(originalJson);
    cells[0]!.source += '\n# edited';
    const saved = JSON.parse(serializeNotebook(cells, originalJson));
    expect(saved.metadata).toEqual(notebook.metadata);
    expect(saved.custom_field).toBe('preserved');
    expect(saved.cells[0]).toEqual({ ...notebook.cells[0], source: 'value = 3\nvalue\n# edited' });
    expect(saved.cells.slice(1)).toEqual(notebook.cells.slice(1));
    expect(getNotebookError(JSON.stringify(saved))).toBeNull();
  });

  it('preserves cell fields by identity after cells are reordered and new cells are added', () => {
    const original = JSON.stringify({ cells: [
      { id: 'a', cell_type: 'markdown', source: 'A', metadata: { name: 'first' }, attachments: { figure: { 'text/plain': 'A' } } },
      { id: 'b', cell_type: 'raw', source: 'B', metadata: { name: 'second' } },
    ] });
    const cells = parseNotebook(original);
    const saved = JSON.parse(serializeNotebook([cells[1]!, cells[0]!, {
      id: 'new', type: 'code', source: '2', outputs: [{ type: 'execute_result', data: { 'text/plain': '2' }, executionCount: 1 }], executionCount: 1, isRunning: false,
    }], original));
    expect(saved.cells[0].metadata).toEqual({ name: 'second' });
    expect(saved.cells[1].attachments).toEqual({ figure: { 'text/plain': 'A' } });
    expect(saved.cells[2].outputs).toEqual([{ output_type: 'execute_result', data: { 'text/plain': '2' }, metadata: {}, execution_count: 1 }]);
  });

  it('assigns stable distinct IDs when an imported notebook has missing or duplicate IDs', () => {
    const source = JSON.stringify({ cells: [
      { cell_type: 'code', source: '' },
      { id: 'cell-0', cell_type: 'code', source: '' },
      { id: 'duplicate', cell_type: 'markdown', source: '' },
      { id: 'duplicate', cell_type: 'raw', source: '' },
    ] });
    const ids = parseNotebook(source).map(cell => cell.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[1]).toBe('cell-0');
    expect(parseNotebook(source).map(cell => cell.id)).toEqual(ids);
    expect(parseNotebook(serializeNotebook(parseNotebook(source), source)).map(cell => cell.id)).toEqual(ids);
  });

  it.each([
    '{', 'null', '{}', '{"nbformat":3,"cells":[]}', '{"cells":{}}',
    '{"cells":[{"cell_type":"code","source":42}]}',
    '{"cells":[{"cell_type":"unknown","source":"x"}]}',
    '{"cells":[{"cell_type":"code","source":"x","outputs":[{"output_type":"stream","text":42}]}]}',
  ])('rejects malformed notebooks without returning editable replacement cells: %s', json => {
    expect(getNotebookError(json)).toEqual(expect.any(String));
    expect(parseNotebook(json)).toEqual([]);
    expect(() => serializeNotebook([], json)).toThrow();
  });

  it('allows a new empty file and older cells-array documents without a version field', () => {
    expect(getNotebookError('')).toBeNull();
    expect(parseNotebook('')).toMatchObject([{ type: 'code', source: '' }]);
    expect(getNotebookError('{"cells":[]}')).toBeNull();
    expect(parseNotebook('{"cells":[]}')).toEqual([]);
  });
});

describe('notebook execution output', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits expression results with execution counts and passes synchronous input to the runtime', async () => {
    runtime.execute.mockImplementation(async (_source, callbacks, options) => {
      callbacks.onStdout('\x1b[36m[Python ready]\x1b[0m\r\n');
      callbacks.onStdout('Loading Python guide\n');
      callbacks.onStdout(`Hello ${options.onInput()}\n`);
      options.onResult('2');
    });
    const kernel = new NotebookKernel();
    const onOutput = vi.fn();
    const onInput = vi.fn(() => 'Ada');
    const [cell] = parseNotebook('');
    cell!.source = '1 + 1';
    const outputs = await kernel.runCell(cell!, onOutput, onInput);
    expect(onInput).toHaveBeenCalledOnce();
    expect(outputs).toEqual([
      { type: 'stdout', text: 'Loading Python guide\nHello Ada\n' },
      { type: 'execute_result', data: { 'text/plain': '2' }, executionCount: 1 },
    ]);
    expect(onOutput.mock.calls[0]![0]).toEqual([{ type: 'stdout', text: 'Loading Python guide\n' }]);
    const second = await kernel.runCell(cell!, vi.fn(), onInput);
    expect(second.at(-1)?.executionCount).toBe(2);
    expect(kernel.getExecutionCount()).toBe(2);
  });
});
