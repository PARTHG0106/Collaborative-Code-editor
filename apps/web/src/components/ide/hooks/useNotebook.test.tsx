import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotebook } from './useNotebook';
import { parseNotebook } from '../../../lib/execution/notebook/NotebookExecutor';
import type { CellOutput } from '../../../lib/execution/notebook/NotebookRenderer';

const mocks = vi.hoisted(() => ({ kernels: [] as Array<{ runCell: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; count: number }> }));
vi.mock('../../../lib/execution/notebook/NotebookExecutor', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/execution/notebook/NotebookExecutor')>();
  return { ...actual, NotebookKernel: class {
    count = 0;
    runCell = vi.fn(async () => { this.count++; return [{ type: 'stdout', text: `${this.count}\n` }]; });
    terminate = vi.fn();
    getExecutionCount() { return this.count; }
    constructor() { mocks.kernels.push(this); }
  } };
});

const document = (second = 'x + 1') => JSON.stringify({
  nbformat: 4, nbformat_minor: 5, metadata: { custom: 'keep' },
  cells: [
    { id: 'a', cell_type: 'code', source: 'x = 10', outputs: [], execution_count: null, metadata: {} },
    { id: 'notes', cell_type: 'markdown', source: 'Notes', metadata: {} },
    { id: 'b', cell_type: 'code', source: second, outputs: [], execution_count: null, metadata: {} },
  ],
});

function setup() {
  const onChange = vi.fn();
  const props = { fileId: 'notebook-a', content: document(), enabled: true, writable: true, onChange };
  const hook = renderHook(options => useNotebook(options), { initialProps: props });
  return { ...hook, props, onChange };
}

describe('notebook editing and execution state', () => {
  beforeEach(() => { mocks.kernels.length = 0; vi.restoreAllMocks(); });

  it('runs cells sequentially and preserves every result even before React commits saved content', async () => {
    const { result, onChange } = setup();
    await act(async () => { await result.current.runAll(); });
    expect(mocks.kernels[0].runCell.mock.calls.map(call => call[0].id)).toEqual(['a', 'b']);
    const saved = JSON.parse(onChange.mock.calls.at(-1)![1]);
    const cells = parseNotebook(onChange.mock.calls.at(-1)![1]);
    expect(cells[0]).toMatchObject({ executionCount: 1, outputs: [{ type: 'stdout', text: '1\n' }] });
    expect(cells[2]).toMatchObject({ executionCount: 2, outputs: [{ type: 'stdout', text: '2\n' }] });
    expect(saved.metadata).toEqual({ custom: 'keep' });
    expect(result.current.isExecuting).toBe(false);
  });

  it('prevents overlapping runs and merges outputs into the latest collaborator changes', async () => {
    const { result, onChange, rerender, props } = setup();
    await act(async () => { await result.current.runCell('a'); });
    onChange.mockClear();
    let finish!: (outputs: CellOutput[]) => void;
    const pending = new Promise<CellOutput[]>(resolve => { finish = resolve; });
    mocks.kernels[0].runCell.mockImplementationOnce((_cell, onOutput) => {
      onOutput([{ type: 'stdout', text: 'working' }]);
      return pending;
    });
    let run!: Promise<void>;
    act(() => { run = result.current.runCell('a'); });
    act(() => { void result.current.runAll(); void result.current.runCell('b'); });
    expect(mocks.kernels[0].runCell).toHaveBeenCalledTimes(2);
    rerender({ ...props, content: document('new collaborator code') });
    expect(result.current.cells[0]).toMatchObject({ isRunning: true, outputs: [{ text: 'working' }] });
    await act(async () => { finish([{ type: 'stdout', text: 'done' }]); await run; });
    const cells = parseNotebook(onChange.mock.calls.at(-1)![1]);
    expect(cells[0].outputs[0].text).toBe('done');
    expect(cells[2].source).toBe('new collaborator code');
  });

  it('does not attach stale results to an edited or deleted running cell', async () => {
    const { result, onChange, rerender, props } = setup();
    await act(async () => { await result.current.runCell('a'); });
    onChange.mockClear();
    let finish!: (outputs: CellOutput[]) => void;
    mocks.kernels[0].runCell.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.runCell('b'); });
    rerender({ ...props, content: document('changed while running') });
    await act(async () => { finish([{ type: 'stdout', text: 'old answer' }]); await pending; });
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.isExecuting).toBe(false);
  });

  it('cancels on file switches and ignores late output without changing the destination notebook', async () => {
    const { result, onChange, rerender, props } = setup();
    await act(async () => { await result.current.runCell('a'); });
    onChange.mockClear();
    let finish!: (outputs: CellOutput[]) => void;
    mocks.kernels[0].runCell.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.runAll(); });
    rerender({ ...props, fileId: 'notebook-b' });
    expect(mocks.kernels[0].terminate).toHaveBeenCalledTimes(1);
    await act(async () => { finish([{ type: 'stdout', text: 'old file' }]); await pending; });
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.isExecuting).toBe(false);
    expect(mocks.kernels[0].runCell).toHaveBeenCalledTimes(2);
  });

  it('keeps completed kernels separate per file and disposes them on unmount', async () => {
    const { result, rerender, props, unmount } = setup();
    await act(async () => { await result.current.runCell('a'); });
    rerender({ ...props, fileId: 'notebook-b' });
    await act(async () => { await result.current.runCell('a'); });
    rerender(props);
    await act(async () => { await result.current.runCell('b'); });
    expect(mocks.kernels).toHaveLength(2);
    expect(mocks.kernels[0].runCell).toHaveBeenCalledTimes(2);
    expect(mocks.kernels[1].runCell).toHaveBeenCalledTimes(1);
    unmount();
    mocks.kernels.forEach(kernel => expect(kernel.terminate).toHaveBeenCalledTimes(1));
  });

  it('leaves malformed and read-only documents unchanged and allows a new empty notebook', async () => {
    const { result, rerender, props, onChange } = setup();
    rerender({ ...props, content: '{broken json' });
    expect(result.current.error).toBeTruthy();
    act(() => { result.current.addCell('', 'code'); });
    await act(async () => { await result.current.runAll(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(mocks.kernels).toHaveLength(0);
    rerender({ ...props, writable: false });
    act(() => { result.current.changeCell('a', 'changed'); });
    await act(async () => { await result.current.runCell('a'); });
    expect(onChange).not.toHaveBeenCalled();
    rerender({ ...props, content: '' });
    expect(result.current.error).toBeNull();
    act(() => { result.current.changeCell(result.current.cells[0].id, 'print(42)'); });
    expect(parseNotebook(onChange.mock.calls.at(-1)![1])[0].source).toBe('print(42)');
  });

  it('unlocks the notebook and shows a failure if the runtime rejects', async () => {
    const { result, onChange } = setup();
    await act(async () => { await result.current.runCell('a'); });
    mocks.kernels[0].runCell.mockRejectedValueOnce(new Error('Kernel unavailable'));
    await act(async () => { await result.current.runCell('b'); });
    expect(result.current.isExecuting).toBe(false);
    const cells = parseNotebook(onChange.mock.calls.at(-1)![1]);
    expect(cells[2].outputs[0]).toMatchObject({ type: 'stderr', text: 'Kernel unavailable' });
  });

  it('uses the supplied input lines across Run All without saving the input field in the notebook', async () => {
    const { result, onChange, rerender, props } = setup();
    await act(async () => { await result.current.runCell('a'); });
    mocks.kernels[0].runCell.mockImplementation(async (_cell, _output, input) => [{ type: 'stdout', text: input() }]);
    act(() => { result.current.changeInput('Ada\nLondon'); });
    await act(async () => { await result.current.runAll(); });
    const cells = parseNotebook(onChange.mock.calls.at(-1)![1]);
    expect(cells[0].outputs[0].text).toBe('Ada');
    expect(cells[2].outputs[0].text).toBe('London');
    expect(JSON.parse(onChange.mock.calls.at(-1)![1])).not.toHaveProperty('inputText');
    rerender({ ...props, fileId: 'notebook-b' });
    expect(result.current.inputText).toBe('');
    rerender(props);
    expect(result.current.inputText).toBe('Ada\nLondon');
  });
});
