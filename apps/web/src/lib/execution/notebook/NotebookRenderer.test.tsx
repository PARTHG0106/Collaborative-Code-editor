import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotebookRenderer } from './NotebookRenderer';
import { parseNotebook } from './NotebookExecutor';

const editor = vi.hoisted(() => ({ onChange: null as null | ((value: string, event: any) => void) }));
vi.mock('@monaco-editor/react', () => ({ default: (props: any) => { editor.onChange = props.onChange; return null; } }));

const callbacks = () => ({ onCellChange: vi.fn(), onRunCell: vi.fn(), onRunAll: vi.fn(), onAddCell: vi.fn(), onDeleteCell: vi.fn(), onMoveCell: vi.fn() });

describe('notebook HTML outputs', () => {
  it('preserves formatted results while removing executable imported HTML', () => {
    const { container } = render(<NotebookRenderer
      cells={[{
        id: 'cell', type: 'code', source: 'display(result)', executionCount: 1, isRunning: false,
        outputs: [{ type: 'display_data', data: { 'text/html': `
          <table><tbody><tr><td><strong>Useful result</strong></td></tr></tbody></table>
          <img src="data:image/png;base64,aA==" onerror="window.compromised=true">
          <a href="javascript:window.compromised=true">Unsafe link</a>
          <script>window.compromised=true</script>
          <iframe srcdoc="<script>parent.compromised=true</script>"></iframe>
          <svg onload="window.compromised=true"></svg>
        ` } }],
      }]}
      onCellChange={vi.fn()} onRunCell={vi.fn()} onRunAll={vi.fn()}
      onAddCell={vi.fn()} onDeleteCell={vi.fn()} onMoveCell={vi.fn()}
      theme="dark"
    />);

    expect(screen.getByRole('cell')).toHaveTextContent('Useful result');
    expect(screen.getByText('Useful result').tagName).toBe('STRONG');
    expect(container.querySelector('img')).not.toHaveAttribute('onerror');
    expect(screen.getByText('Unsafe link')).not.toHaveAttribute('href');
    const output = screen.getByRole('table').parentElement!;
    expect(output.querySelector('script, iframe, svg, [onload], [onerror]')).toBeNull();
  });

  it('shows imported text/plain expression results and multiline MIME text arrays', () => {
    const cells = parseNotebook(JSON.stringify({ cells: [{
      cell_type: 'code', source: 'value', outputs: [
        { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'text/plain': ['first line\n', 'second line'] } },
        { output_type: 'display_data', metadata: {}, data: { 'text/plain': 'displayed value' } },
      ],
    }] }));
    render(<NotebookRenderer cells={cells} {...callbacks()} theme="dark" />);
    expect(screen.getByText(/first line/)).toHaveTextContent('first line second line');
    expect(screen.getByText('displayed value')).toBeInTheDocument();
  });

  it('disables competing runs while keeping Stop and editing available', () => {
    const actions = callbacks();
    const onStop = vi.fn();
    render(<NotebookRenderer cells={parseNotebook('')} {...actions} theme="dark" isExecuting onStop={onStop} />);
    expect(screen.getByRole('button', { name: 'Run All' })).toBeDisabled();
    expect(screen.getByTitle('Run cell')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Running cell…');
    expect(screen.getByRole('button', { name: 'Code' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('ignores Monaco model flushes while forwarding user edits', () => {
    const actions = callbacks();
    render(<NotebookRenderer cells={parseNotebook('')} {...actions} theme="dark" />);
    editor.onChange?.('incoming document', { isFlush: true });
    editor.onChange?.('line endings changed', { isEolChange: true });
    expect(actions.onCellChange).not.toHaveBeenCalled();
    editor.onChange?.('print(1)', { isFlush: false });
    expect(actions.onCellChange).toHaveBeenCalledWith('cell-0', 'print(1)');
  });

  it('accepts prepared Python input lines and keeps them read-only for viewers', () => {
    const actions = callbacks();
    const onInputTextChange = vi.fn();
    const view = render(<NotebookRenderer cells={parseNotebook('')} {...actions} theme="dark"
      inputText={'Ada\n42'} onInputTextChange={onInputTextChange} />);
    fireEvent.click(screen.getByText('Python input'));
    const input = screen.getByRole('textbox', { name: 'Python input lines' });
    expect(input).toHaveValue('Ada\n42');
    expect(input).toHaveAccessibleDescription('One line for each input() call. Used from the beginning on each run.');
    expect(input).not.toHaveAttribute('readonly');
    fireEvent.change(input, { target: { value: 'Grace\n37' } });
    expect(onInputTextChange).toHaveBeenCalledWith('Grace\n37');

    view.rerender(<NotebookRenderer cells={parseNotebook('')} {...actions} theme="dark" readOnly
      inputText={'Ada\n42'} onInputTextChange={onInputTextChange} />);
    expect(input).toHaveAttribute('readonly');
    onInputTextChange.mockClear();
    fireEvent.change(input, { target: { value: 'changed' } });
    expect(onInputTextChange).not.toHaveBeenCalled();
  });
});
