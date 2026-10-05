import React, { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickOpen } from './QuickOpen';
import type { FileSystemItem } from './hooks/useFileSystem';

function item(id: string, name: string, parentId: string | null = null, type: FileSystemItem['type'] = 'FILE'): FileSystemItem {
  return { id, name, parentId, type, content: '', workspaceId: 'workspace', createdAt: '', updatedAt: '' };
}

const files = [
  item('src', 'src', null, 'FOLDER'),
  item('tests', 'tests', null, 'FOLDER'),
  item('src-index', 'index.ts', 'src'),
  item('test-index', 'index.ts', 'tests'),
  item('readme', 'README.md'),
];

describe('QuickOpen', () => {
  it('distinguishes duplicate names with folder paths and filters words case-insensitively', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<QuickOpen files={files} openFileIds={['src-index']} onSelect={onSelect} onClose={onClose} />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(within(options[0]).getByText('src/index.ts')).toBeInTheDocument();
    expect(within(options[0]).getByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /tests\/index.ts/ })).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: ' INDEX  TESTS ' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('tests/index.ts');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(files[3]);
  });

  it('supports arrow selection, wraparound, and query changes resetting selection', () => {
    const onSelect = vi.fn();
    render(<QuickOpen files={files} openFileIds={['src-index']} onSelect={onSelect} onClose={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-file-2');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(files[4]);

    fireEvent.change(input, { target: { value: 'index.ts' } });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('traps Tab within the dialog and restores focus to its trigger after Escape', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open files</button>{open && <QuickOpen files={files} openFileIds={[]} onSelect={vi.fn()} onClose={() => setOpen(false)} />}</>;
    }
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Open files' });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole('combobox');
    const close = screen.getByRole('button', { name: 'Close quick open' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not select or close files when Enter or Escape belongs to IME composition', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<QuickOpen files={files} openFileIds={[]} onClose={onClose} onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('distinguishes an empty workspace from an unmatched query without selecting nonexistent results', () => {
    const onSelect = vi.fn();
    const callbacks = { onSelect, onClose: vi.fn() };
    const { rerender } = render(<QuickOpen files={files} openFileIds={[]} {...callbacks} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'missing-file' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching files');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();

    rerender(<QuickOpen files={files.filter(file => file.type === 'FOLDER')} openFileIds={[]} {...callbacks} />);
    expect(screen.getByRole('status')).toHaveTextContent('Create or upload a file from the Explorer');
  });
});
