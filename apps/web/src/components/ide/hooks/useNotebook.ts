import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getNotebookError, NotebookKernel, parseNotebook, serializeNotebook } from '../../../lib/execution/notebook/NotebookExecutor';
import type { CellOutput, NotebookCell } from '../../../lib/execution/notebook/NotebookRenderer';

interface NotebookOptions {
  fileId: string | null;
  content: string;
  enabled: boolean;
  writable: boolean;
  onChange: (fileId: string, content: string) => void;
}

interface Run {
  fileId: string;
  kernel: NotebookKernel;
}

/** Keep transient execution state out of the shared notebook document. */
export function useNotebook(options: NotebookOptions) {
  const error = useMemo(() => options.enabled ? getNotebookError(options.content) : null, [options.enabled, options.content]);
  const parsedCells = useMemo(() => options.enabled && !error ? parseNotebook(options.content) : [], [options.enabled, options.content, error]);
  const latest = useRef({ ...options, cells: parsedCells, error });
  latest.current = { ...options, cells: parsedCells, error };
  const kernels = useRef(new Map<string, NotebookKernel>());
  const [inputByFile, setInputByFile] = useState<Record<string, string>>({});
  const inputValues = useRef(inputByFile);
  inputValues.current = inputByFile;
  const run = useRef<Run | null>(null);
  const mounted = useRef(true);
  const [execution, setExecution] = useState<{ fileId: string; cellId: string; outputs: CellOutput[] } | null>(null);

  const stop = useCallback(() => {
    const active = run.current;
    run.current = null;
    if (active) {
      active.kernel.terminate();
      kernels.current.delete(active.fileId);
    }
    setExecution(null);
  }, []);

  useEffect(() => {
    if (run.current && (run.current.fileId !== options.fileId || !options.enabled || !options.writable || error)) stop();
  }, [options.fileId, options.enabled, options.writable, error, stop]);

  useEffect(() => {
    mounted.current = true;
    const sessions = kernels.current;
    return () => {
      mounted.current = false;
      run.current = null;
      sessions.forEach(kernel => kernel.terminate());
      sessions.clear();
    };
  }, []);

  const update = useCallback((change: (cells: NotebookCell[]) => NotebookCell[]) => {
    const current = latest.current;
    if (!mounted.current || !current.fileId || !current.enabled || !current.writable || current.error) return;
    const cells = change(current.cells);
    if (cells === current.cells) return;
    const content = serializeNotebook(cells, current.content);
    // Run All may finish a cell before React commits the preceding save.
    latest.current = { ...current, cells, content };
    current.onChange(current.fileId, content);
  }, []);

  const changeCell = useCallback((id: string, source: string) => {
    update(cells => {
      if (!cells.some(cell => cell.id === id && cell.source !== source)) return cells;
      return cells.map(cell => cell.id === id ? { ...cell, source } : cell);
    });
  }, [update]);

  const addCell = useCallback((afterId: string, type: 'code' | 'markdown') => {
    let addedId: string | undefined;
    update(cells => {
      const result = [...cells];
      const index = cells.findIndex(cell => cell.id === afterId);
      addedId = crypto.randomUUID();
      result.splice(index < 0 ? cells.length : index + 1, 0, {
        id: addedId, type, source: '', outputs: [], executionCount: null, isRunning: false,
      });
      return result;
    });
    return addedId;
  }, [update]);

  const deleteCell = useCallback((id: string) => update(cells => cells.filter(cell => cell.id !== id)), [update]);
  const moveCell = useCallback((id: string, direction: 'up' | 'down') => {
    update(cells => {
      const index = cells.findIndex(cell => cell.id === id);
      const target = index + (direction === 'up' ? -1 : 1);
      if (index < 0 || target < 0 || target >= cells.length) return cells;
      const result = [...cells];
      [result[index], result[target]] = [result[target], result[index]];
      return result;
    });
  }, [update]);

  const execute = useCallback(async (ids: string[]) => {
    const initial = latest.current;
    if (run.current || !mounted.current || !initial.fileId || !initial.enabled || !initial.writable || initial.error) return;
    let kernel = kernels.current.get(initial.fileId);
    if (!kernel) {
      kernel = new NotebookKernel();
      kernels.current.set(initial.fileId, kernel);
    }
    const active = { fileId: initial.fileId, kernel };
    const inputText = inputValues.current[initial.fileId];
    const inputLines = inputText === undefined ? null : inputText.split(/\r?\n/);
    let inputIndex = 0;
    run.current = active;
    const valid = () => mounted.current && run.current === active && latest.current.fileId === active.fileId
      && latest.current.enabled && latest.current.writable && !latest.current.error;
    try {
      for (const id of ids) {
        if (!valid()) break;
        const cell = latest.current.cells.find(item => item.id === id);
        if (!cell || cell.type !== 'code') continue;
        setExecution({ fileId: active.fileId, cellId: id, outputs: [] });
        let outputs: CellOutput[];
        try {
          outputs = await kernel.runCell(cell, value => {
            if (valid()) setExecution({ fileId: active.fileId, cellId: id, outputs: value });
          }, () => {
            if (!valid()) return null;
            if (inputLines) {
              if (inputIndex >= inputLines.length) throw new Error('Python input has no more lines. Add another line under Python input and run again.');
              return inputLines[inputIndex++];
            }
            try {
              return window.prompt('Python input:');
            } catch {
              throw new Error('This browser cannot show a Python prompt. Add input lines under Python input and run again.');
            }
          });
        } catch (cause) {
          outputs = [{ type: 'stderr', text: cause instanceof Error ? cause.message : String(cause) }];
        }
        if (!valid()) break;
        // A collaborator may edit or delete the cell while it executes. Merge
        // outputs into the newest document without reverting those changes.
        update(cells => {
          if (!cells.some(item => item.id === id && item.type === 'code' && item.source === cell.source)) return cells;
          return cells.map(item => item.id === id ? { ...item, outputs, executionCount: kernel!.getExecutionCount() } : item);
        });
      }
    } finally {
      if (run.current === active) {
        run.current = null;
        if (mounted.current) setExecution(null);
      }
    }
  }, [update]);

  const runCell = useCallback((id: string) => execute([id]), [execute]);
  const runAll = useCallback(() => execute(latest.current.cells.filter(cell => cell.type === 'code').map(cell => cell.id)), [execute]);
  const changeInput = useCallback((value: string) => {
    const fileId = latest.current.fileId;
    if (fileId) setInputByFile(previous => ({ ...previous, [fileId]: value }));
  }, []);
  const activeExecution = execution?.fileId === options.fileId ? execution : null;
  const cells = parsedCells.map(cell => cell.id === activeExecution?.cellId
    ? { ...cell, outputs: activeExecution.outputs, isRunning: true }
    : cell);

  return {
    cells, error, isExecuting: !!activeExecution, changeCell, addCell, deleteCell, moveCell, runCell, runAll, stop,
    inputText: options.fileId ? inputByFile[options.fileId] ?? '' : '', changeInput,
  };
}
