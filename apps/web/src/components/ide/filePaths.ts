import type { FileSystemItem } from './hooks/useFileSystem';

/** Include folders so identically named files can be distinguished. */
export function getFilePath(file: FileSystemItem, files: FileSystemItem[]): string {
  const names = [file.name];
  const seen = new Set([file.id]);
  let parentId = file.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = files.find(item => item.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join('/');
}
