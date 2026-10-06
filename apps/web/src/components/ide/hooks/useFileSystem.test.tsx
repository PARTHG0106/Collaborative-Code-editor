import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { useFileSystem, type FileSystemItem } from './useFileSystem';

const { apiClient } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ apiClient }) }));

function item(id: string, parentId: string | null = null, type: 'FILE' | 'FOLDER' = 'FILE'): FileSystemItem {
  return { id, name: `${id}.txt`, parentId, type, content: 'initial', workspaceId: 'workspace-a', createdAt: '', updatedAt: '' };
}

const response = (data: unknown) => ({ data: { success: true, data } });

function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(res => { resolve = res; });
  return { promise, resolve };
}

describe('useFileSystem collaboration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    apiClient.get.mockResolvedValue(response([]));
    apiClient.delete.mockResolvedValue(response({}));
  });

  it('marks a listing ready only after a successful response and resets readiness for another workspace', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result, rerender } = renderHook(({ workspaceId }) => useFileSystem(workspaceId), {
        initialProps: { workspaceId: 'workspace-a' },
      });
      expect(result.current.hasLoadedFiles).toBe(false);
      apiClient.get.mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValueOnce({ data: { success: false } })
        .mockResolvedValueOnce(response({ files: [] }))
        .mockResolvedValueOnce(response([]))
        .mockRejectedValueOnce(new Error('Refresh failed'));
      for (let attempt = 0; attempt < 3; attempt++) {
        await act(async () => { await result.current.fetchFiles(); });
        expect(result.current.hasLoadedFiles).toBe(false);
      }
      await act(async () => { await result.current.fetchFiles(); });
      expect(result.current.hasLoadedFiles).toBe(true);
      await act(async () => { await result.current.fetchFiles(); });
      expect(result.current.hasLoadedFiles).toBe(true);
      rerender({ workspaceId: 'workspace-b' });
      expect(result.current.hasLoadedFiles).toBe(false);
    } finally {
      quiet.mockRestore();
    }
  });

  it('removes every descendant and clears the selected file and expanded folders after a folder deletion', async () => {
    const { result } = renderHook(() => useFileSystem('workspace-a'));
    act(() => {
      result.current.setFiles([item('root', null, 'FOLDER'), item('nested', 'root', 'FOLDER'), item('deep', 'nested'), item('keep')]);
      result.current.setActiveFileId('deep');
      result.current.setExpandedFolders(new Set(['root', 'nested']));
    });

    await act(async () => { await result.current.deleteFile('root'); });

    expect(result.current.files.map(file => file.id)).toEqual(['keep']);
    expect(result.current.activeFileId).toBeNull();
    expect([...result.current.expandedFolders]).toEqual([]);
  });

  it('ignores a listing response from a workspace that is no longer open', async () => {
    const oldRequest = deferred();
    apiClient.get.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(response([item('new-file')]));
    const { result, rerender } = renderHook(({ workspaceId }) => useFileSystem(workspaceId), { initialProps: { workspaceId: 'workspace-a' } });
    let oldFetch!: Promise<void>;
    act(() => { oldFetch = result.current.fetchFiles(); });
    rerender({ workspaceId: 'workspace-b' });
    await act(async () => { await result.current.fetchFiles(); });
    await act(async () => {
      oldRequest.resolve(response([item('old-file')]));
      await oldFetch;
    });

    expect(result.current.files.map(file => file.id)).toEqual(['new-file']);
    expect(result.current.filesLoading).toBe(false);
  });

  it('keeps the newest listing when two refreshes complete out of order', async () => {
    const older = deferred();
    const newer = deferred();
    apiClient.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useFileSystem('workspace-a'));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.fetchFiles(); second = result.current.fetchFiles(); });
    await act(async () => { newer.resolve(response([item('new')])); await second; });
    await act(async () => { older.resolve(response([item('old')])); await first; });
    expect(result.current.files.map(file => file.id)).toEqual(['new']);
  });

  it('refreshes metadata without overwriting a cached draft or resurrecting a deleted item', async () => {
    const listing = deferred();
    apiClient.get.mockReturnValueOnce(listing.promise);
    const { result } = renderHook(() => useFileSystem('workspace-a'));
    act(() => { result.current.setFiles([item('edit'), item('deleted')]); });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.fetchFiles();
      result.current.setFiles([{ ...item('edit'), content: 'my unsent draft' }]);
    });
    await act(async () => {
      listing.resolve(response([{ ...item('edit'), name: 'renamed.txt' }, item('deleted')]));
      await pending;
    });
    expect(result.current.files).toEqual([{ ...item('edit'), name: 'renamed.txt', content: 'my unsent draft' }]);
  });

  it('does not duplicate a file when its broadcast is fetched before the create response arrives', async () => {
    const creating = deferred();
    apiClient.post.mockReturnValueOnce(creating.promise);
    apiClient.get.mockResolvedValueOnce(response([item('created')]));
    const { result } = renderHook(() => useFileSystem('workspace-a'));
    let pending!: Promise<FileSystemItem | null>;
    act(() => { pending = result.current.createFile('created.txt', 'FILE', null); });
    await act(async () => { await result.current.fetchFiles(); });
    await act(async () => { creating.resolve(response(item('created'))); await pending; });
    expect(result.current.files.map(file => file.id)).toEqual(['created']);
  });

  it('refreshes for collaborator tree changes and reconnects, and detaches listeners on unmount', async () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const socket = {
      on: vi.fn((event, listener) => handlers.set(event, listener)),
      off: vi.fn((event) => handlers.delete(event)),
    };
    const { result, unmount } = renderHook(() => useFileSystem('workspace-a', socket as unknown as Socket));
    act(() => { result.current.setFiles([item('removed')]); result.current.setActiveFileId('removed'); });
    await act(async () => { handlers.get('workspace_files_changed')!({ workspaceId: 'workspace-b' }); });
    expect(apiClient.get).not.toHaveBeenCalled();
    await act(async () => { handlers.get('workspace_files_changed')!({ workspaceId: 'workspace-a' }); });
    expect(result.current.files).toEqual([]);
    expect(result.current.activeFileId).toBeNull();
    await act(async () => { handlers.get('connect')!(); });
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    unmount();
    expect(handlers.size).toBe(0);
  });

  it('serializes saves of one file and only confirms the newest queued content', async () => {
    const firstResponse = deferred();
    const secondResponse = deferred();
    apiClient.patch.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise);
    const { result } = renderHook(() => useFileSystem('workspace-a'));
    act(() => { result.current.setFiles([item('edit')]); result.current.setActiveFileId('edit'); });
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.saveFileContent('edit', 'first edit');
      second = result.current.saveFileContent('edit', 'second edit');
    });
    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    await act(async () => { firstResponse.resolve(response({ content: 'first edit' })); await first; });
    expect(result.current.saveStatus).toBe('saving');
    expect(apiClient.patch).toHaveBeenLastCalledWith('/workspaces/workspace-a/files/edit', { content: 'second edit' });
    await act(async () => { secondResponse.resolve(response({ content: 'second edit' })); await second; });
    expect(result.current.files[0].content).toBe('second edit');
    expect(result.current.saveStatus).toBe('saved');
  });

  it('does not roll back edits made while a save is in flight or report them saved', async () => {
    const saving = deferred();
    apiClient.patch.mockReturnValueOnce(saving.promise);
    const { result } = renderHook(() => useFileSystem('workspace-a'));
    act(() => { result.current.setFiles([item('edit')]); result.current.setActiveFileId('edit'); });
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.saveFileContent('edit', 'saved edit'); });
    act(() => { result.current.setFiles([{ ...item('edit'), content: 'newer draft' }]); });
    await act(async () => { saving.resolve(response({ content: 'saved edit' })); await pending; });
    expect(result.current.files[0].content).toBe('newer draft');
    expect(result.current.saveStatus).toBe('unsaved');
  });
});
