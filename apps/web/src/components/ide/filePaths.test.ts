import { describe, expect, it } from 'vitest';
import { getFilePath } from './filePaths';
import type { FileSystemItem } from './hooks/useFileSystem';

const item = (id: string, name: string, parentId: string | null = null): FileSystemItem => ({ id, name, parentId, type: 'FILE', content: '', workspaceId: 'workspace', createdAt: '', updatedAt: '' });

describe('getFilePath', () => {
  it('preserves full folder paths so repeated file names are distinguishable', () => {
    const files = [item('src', 'src'), item('nested', 'components', 'src'), item('tests', 'tests'), item('a', 'index.ts', 'nested'), item('b', 'index.ts', 'tests')];
    expect(getFilePath(files[3], files)).toBe('src/components/index.ts');
    expect(getFilePath(files[4], files)).toBe('tests/index.ts');
  });

  it('still provides a usable path when ancestors are missing or cyclic', () => {
    const orphan = item('orphan', 'orphan.ts', 'missing');
    expect(getFilePath(orphan, [orphan])).toBe('orphan.ts');
    const files = [item('a', 'a', 'b'), item('b', 'b', 'a'), item('file', 'index.ts', 'a')];
    expect(getFilePath(files[2], files)).toBe('b/a/index.ts');
  });
});
