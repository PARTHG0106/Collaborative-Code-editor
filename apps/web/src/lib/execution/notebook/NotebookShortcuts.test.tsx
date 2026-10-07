import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookRenderer, type NotebookCell } from './NotebookRenderer';

const mocks = vi.hoisted(() => ({ editors: [] as Array<{
  actions: Map<string, { keybindings: number[]; run: () => void }>;
  focus: ReturnType<typeof vi.fn>;
  disposed: boolean;
}> }));

vi.mock('@monaco-editor/react', async () => {
  const { useEffect, useRef } = await import('react');
  return { default: function MockEditor(props: any) {
    const input = useRef<HTMLTextAreaElement>(null);
    const onMount = useRef(props.onMount);
    useEffect(() => {
      const disposal: Array<() => void> = [];
      const actions = new Map<string, { keybindings: number[]; run: () => void }>();
      const editor = {
        actions, disposed: false,
        focus: vi.fn(() => input.current?.focus()),
        getDomNode: () => null,
        addAction: (action: { id: string; keybindings: number[]; run: () => void }) => {
          actions.set(action.id, action);
          return { dispose: () => actions.delete(action.id) };
        },
        onDidFocusEditorText: () => ({ dispose: vi.fn() }),
        onDidDispose: (callback: () => void) => disposal.push(callback),
      };
      mocks.editors.push(editor);
      onMount.current?.(editor, { KeyMod: { CtrlCmd: 2048, Shift: 1024 }, KeyCode: { Enter: 3 } });
      return () => { disposal.forEach(callback => callback()); editor.disposed = true; };
    }, []);
    return <textarea ref={input} aria-label={props.options.ariaLabel} value={props.value} readOnly />;
  } };
});

const cell = (id: string, type: NotebookCell['type'] = 'code'): NotebookCell => ({
  id, type, source: id, outputs: [], executionCount: null, isRunning: false,
});
const callbacks = () => ({ onCellChange: vi.fn(), onRunCell: vi.fn(), onRunAll: vi.fn(), onAddCell: vi.fn(), onDeleteCell: vi.fn(), onMoveCell: vi.fn() });
const run = (index: number, advance: boolean) => act(() => {
  mocks.editors[index].actions.get(advance ? 'notebook.run-cell-and-advance' : 'notebook.run-cell')!.run();
});

describe('notebook execution shortcuts', () => {
  beforeEach(() => { mocks.editors.length = 0; });

  it('binds Ctrl/Cmd+Enter to the current cell without moving focus or adding a cell', () => {
    const actions = callbacks();
    render(<NotebookRenderer cells={[cell('first'), cell('second')]} {...actions} theme="light" />);
    screen.getByRole('textbox', { name: 'Notebook cell 1' }).focus();
    expect(mocks.editors[0].actions.get('notebook.run-cell')!.keybindings).toEqual([2048 | 3]);
    run(0, false);
    expect(actions.onRunCell).toHaveBeenCalledOnce();
    expect(actions.onRunCell).toHaveBeenCalledWith('first');
    expect(actions.onAddCell).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Notebook cell 1' })).toHaveFocus();
  });

  it('binds Shift+Enter to run and focus the next editor immediately', () => {
    const actions = callbacks();
    render(<NotebookRenderer cells={[cell('first'), cell('second')]} {...actions} theme="light" />);
    expect(mocks.editors[0].actions.get('notebook.run-cell-and-advance')!.keybindings).toEqual([1024 | 3]);
    run(0, true);
    expect(actions.onRunCell).toHaveBeenCalledOnce();
    expect(actions.onRunCell).toHaveBeenCalledWith('first');
    expect(screen.getByRole('textbox', { name: 'Notebook cell 2' })).toHaveFocus();
    expect(actions.onAddCell).not.toHaveBeenCalled();
  });

  it('creates and focuses a new code cell when advancing from the last cell', () => {
    const actions = callbacks();
    function Notebook() {
      const [cells, setCells] = useState([cell('first')]);
      return <NotebookRenderer cells={cells} {...actions} theme="light" onAddCell={(after, type) => {
        actions.onAddCell(after, type);
        setCells(current => [...current, cell('new')]);
        return 'new';
      }} />;
    }
    render(<Notebook />);
    run(0, true);
    expect(actions.onRunCell).toHaveBeenCalledOnce();
    expect(actions.onRunCell).toHaveBeenCalledWith('first');
    expect(actions.onAddCell).toHaveBeenCalledOnce();
    expect(actions.onAddCell).toHaveBeenCalledWith('first', 'code');
    expect(screen.getByRole('textbox', { name: 'Notebook cell 2' })).toHaveFocus();
  });

  it('advances through markdown and raw cells without executing Python', () => {
    const actions = callbacks();
    render(<NotebookRenderer cells={[cell('notes', 'markdown'), cell('raw', 'raw'), cell('code')]} {...actions} theme="light" />);
    run(0, true);
    expect(screen.getByRole('textbox', { name: 'Notebook cell 2' })).toHaveFocus();
    run(1, true);
    expect(screen.getByRole('textbox', { name: 'Notebook cell 3' })).toHaveFocus();
    expect(actions.onRunCell).not.toHaveBeenCalled();
  });

  it('uses current permissions, busy state and callbacks without remounting editors', () => {
    const actions = callbacks();
    const cells = [cell('first')];
    const view = render(<NotebookRenderer cells={cells} {...actions} theme="light" />);
    view.rerender(<NotebookRenderer cells={cells} {...actions} theme="light" readOnly />);
    run(0, true);
    view.rerender(<NotebookRenderer cells={cells} {...actions} theme="light" isExecuting />);
    run(0, false);
    expect(actions.onRunCell).not.toHaveBeenCalled();
    expect(actions.onAddCell).not.toHaveBeenCalled();
    const nextRun = vi.fn();
    view.rerender(<NotebookRenderer cells={cells} {...actions} onRunCell={nextRun} theme="light" />);
    run(0, false);
    expect(nextRun).toHaveBeenCalledOnce();
    expect(nextRun).toHaveBeenCalledWith('first');
    expect(mocks.editors).toHaveLength(1);
    view.unmount();
    expect(mocks.editors[0].disposed).toBe(true);
    expect(mocks.editors[0].actions.size).toBe(0);
  });

  it('does not capture Enter shortcuts from the separate Python input field', () => {
    const actions = callbacks();
    render(<NotebookRenderer cells={[cell('first')]} {...actions} theme="light" inputText="" onInputTextChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Python input'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Python input lines' }), { key: 'Enter', shiftKey: true });
    expect(actions.onRunCell).not.toHaveBeenCalled();
    expect(actions.onAddCell).not.toHaveBeenCalled();
  });
});
