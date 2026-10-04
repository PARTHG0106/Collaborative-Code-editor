import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotebookRenderer } from './NotebookRenderer';

vi.mock('@monaco-editor/react', () => ({ default: () => null }));

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
});
