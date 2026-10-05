import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchPanel } from './SearchPanel';
import type { FileSystemItem } from '../hooks/useFileSystem';

const item = (id: string, name: string, content: string | null, parentId: string | null = null, type: FileSystemItem['type'] = 'FILE'): FileSystemItem => ({ id, name, content, parentId, type, workspaceId: 'workspace', createdAt: '', updatedAt: '' });
const files = [
  item('src', 'src', null, null, 'FOLDER'),
  item('tests', 'tests', null, null, 'FOLDER'),
  item('source', 'index.ts', 'first line\n  const target = 1;\nlast line', 'src'),
  item('test', 'index.ts', 'test TARGET\nsecond target', 'tests'),
];

describe('SearchPanel', () => {
  it('labels duplicate files by their paths and sends the matching one-based line to the editor', () => {
    const onOpenFile = vi.fn();
    render(<SearchPanel files={files} onOpenFile={onOpenFile} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file contents' }), { target: { value: 'target' } });
    expect(screen.getByRole('status')).toHaveTextContent('3 matching lines in 2 files');
    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts, line 2: const target = 1;' }));
    expect(onOpenFile).toHaveBeenLastCalledWith(files[2], 2);
    fireEvent.click(screen.getByRole('button', { name: 'tests/index.ts, line 1: test TARGET' }));
    expect(onOpenFile).toHaveBeenLastCalledWith(files[3], 1);
    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts (1)' }));
    expect(onOpenFile).toHaveBeenLastCalledWith(files[2]);
  });

  it('announces invalid regular expressions and recovers when the pattern is corrected or cleared', () => {
    render(<SearchPanel files={files} onOpenFile={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search file contents' });
    const toggle = screen.getByRole('button', { name: 'Use regular expression' });
    fireEvent.change(input, { target: { value: '[' } });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid regular expression');
    fireEvent.change(input, { target: { value: '^test target$' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 matching line in 1 file');
    expect(screen.getByRole('button', { name: 'tests/index.ts, line 1: test TARGET' })).toBeInTheDocument();

    const clear = screen.getByRole('button', { name: 'Clear search' });
    clear.focus();
    fireEvent.click(clear);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Find text across this workspace');
  });

  it('caps broad searches with guidance and still lets the last displayed result open', () => {
    const manyLines = item('many', 'large.txt', Array.from({ length: 205 }, (_, index) => `target ${index + 1}`).join('\n'));
    const onOpenFile = vi.fn();
    render(<SearchPanel files={[manyLines]} onOpenFile={onOpenFile} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'target' } });
    expect(screen.getByRole('status')).toHaveTextContent('200+ matching lines');
    expect(screen.getByRole('status')).toHaveTextContent('Narrow your search');
    expect(screen.queryByRole('button', { name: 'large.txt, line 201: target 201' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'large.txt, line 200: target 200' }));
    expect(onOpenFile).toHaveBeenCalledWith(manyLines, 200);
  });
});
