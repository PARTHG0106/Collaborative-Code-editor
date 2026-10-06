import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceDownloads } from './useWorkspaceDownloads';
import type { FileSystemItem } from './useFileSystem';

const mocks = vi.hoisted(() => ({
  apiClient: { get: vi.fn() },
  user: { id: 'viewer' } as { id: string } | null,
  createWorkspaceArchive: vi.fn(),
  createFileDownload: vi.fn(),
  downloadBlob: vi.fn(),
  workspaceArchiveName: vi.fn((name: string) => `${name}.zip`),
}));

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ apiClient: mocks.apiClient, user: mocks.user }) }));
vi.mock('../../../lib/workspaceExport', () => ({
  createWorkspaceArchive: mocks.createWorkspaceArchive,
  createFileDownload: mocks.createFileDownload,
  downloadBlob: mocks.downloadBlob,
  workspaceArchiveName: mocks.workspaceArchiveName,
}));

function file(id: string, content = 'server text', workspaceId = 'a'): FileSystemItem {
  return { id, name: `${id}.txt`, type: 'FILE', parentId: null, content, workspaceId, createdAt: '', updatedAt: '' };
}
const response = (data: unknown) => ({ data: { success: true, data } });
const emptyOverrides = () => new Map<string, string>();
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('useWorkspaceDownloads', () => {
  let blob: Blob;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'viewer' };
    blob = new Blob(['download bytes']);
    mocks.apiClient.get.mockResolvedValue(response([file('open'), file('unopened')]));
    mocks.createWorkspaceArchive.mockResolvedValue(blob);
    mocks.createFileDownload.mockReturnValue(blob);
  });
  afterEach(() => vi.useRealTimers());

  it('uses fresh server contents for unopened files and snapshots local edits after the request completes', async () => {
    const request = deferred();
    mocks.apiClient.get.mockReturnValue(request.promise);
    let localContents = new Map([['open', 'first draft']]);
    const getContents = vi.fn(() => localContents);
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', getContents));
    let pending!: Promise<void>;
    act(() => { pending = result.current.downloadWorkspace(); });
    expect(result.current.downloading).toBe('workspace');
    expect(getContents).not.toHaveBeenCalled();
    localContents = new Map([['open', 'newest unsaved draft\r\n']]);
    const freshFiles = [file('open', 'server copy'), file('unopened', 'teammate edit')];
    await act(async () => { request.resolve(response(freshFiles)); await pending; });

    expect(mocks.apiClient.get).toHaveBeenCalledWith('/workspaces/a/files', { signal: expect.any(AbortSignal), timeout: 30_000 });
    expect(mocks.createWorkspaceArchive).toHaveBeenCalledWith(freshFiles, { contentOverrides: localContents });
    expect(mocks.downloadBlob).toHaveBeenCalledWith(blob, 'Project.zip');
    expect(result.current.downloading).toBeNull();
    expect(result.current.notice).toContain('Project.zip');
    expect(result.current.error).toBeNull();
  });

  it('allows a viewer to download a freshly renamed file, including an empty local buffer', async () => {
    const renamed = { ...file('open'), name: 'renamed.txt' };
    mocks.apiClient.get.mockResolvedValue(response([renamed]));
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', () => new Map([['open', '']])));
    await act(async () => { await result.current.downloadFile('open'); });
    expect(mocks.createFileDownload).toHaveBeenCalledWith(renamed, '');
    expect(mocks.downloadBlob).toHaveBeenCalledWith(blob, 'renamed.txt');
    expect(mocks.createWorkspaceArchive).not.toHaveBeenCalled();
  });

  it('blocks duplicate clicks and other downloads until the active operation finishes', async () => {
    const request = deferred();
    mocks.apiClient.get.mockReturnValue(request.promise);
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', emptyOverrides));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.downloadWorkspace();
      void result.current.downloadWorkspace();
      void result.current.downloadFile('open');
    });
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(1);
    act(() => result.current.dismissFeedback());
    expect(result.current.downloading).toBe('workspace');
    await act(async () => { request.resolve(response([file('open')])); await pending; });
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1);
    act(() => result.current.dismissFeedback());
    expect(result.current.notice).toBeNull();
  });

  it('reports permission failures without exporting cached content or an empty archive', async () => {
    mocks.apiClient.get.mockRejectedValue({ response: { data: { error: { message: 'Access to this workspace was removed.' } } } });
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', () => new Map([['open', 'cached text']])));
    await act(async () => { await result.current.downloadWorkspace(); });
    expect(result.current.error).toBe('Access to this workspace was removed.');
    expect(result.current.downloading).toBeNull();
    expect(mocks.createWorkspaceArchive).not.toHaveBeenCalled();
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
    act(() => result.current.dismissFeedback());
    expect(result.current.error).toBeNull();
  });

  it.each([
    null,
    { data: { success: false, data: [] } },
    response({ files: [] }),
    response([file('open', 'text', 'another-workspace')]),
    response([file('same'), file('same')]),
    response([{ ...file('open'), content: { data: 'not text' } }]),
    response([{ ...file('open'), parentId: 42 }]),
    response([null]),
  ])('rejects malformed or ambiguous file lists before starting any download: %j', async (invalidResponse) => {
    mocks.apiClient.get.mockResolvedValue(invalidResponse);
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', emptyOverrides));
    await act(async () => { await result.current.downloadFile('open'); });
    expect(result.current.error).toBeTruthy();
    expect(mocks.createWorkspaceArchive).not.toHaveBeenCalled();
    expect(mocks.createFileDownload).not.toHaveBeenCalled();
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
  });

  it('does not resurrect a file absent from the fresh listing', async () => {
    mocks.apiClient.get.mockResolvedValue(response([]));
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', () => new Map([['deleted', 'old draft']])));
    await act(async () => { await result.current.downloadFile('deleted'); });
    expect(result.current.error).toContain('no longer in the workspace');
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
  });

  it('surfaces archive validation errors without showing a successful download', async () => {
    mocks.createWorkspaceArchive.mockRejectedValueOnce(new Error('Folder paths would overwrite each other.'));
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', emptyOverrides));
    await act(async () => { await result.current.downloadWorkspace(); });
    expect(result.current.error).toBe('Folder paths would overwrite each other.');
    expect(result.current.notice).toBeNull();
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
  });

  it('aborts old workspace requests and ignores their late responses without clearing the new operation', async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    mocks.apiClient.get.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const { result, rerender } = renderHook(({ id }) => useWorkspaceDownloads(id, id, emptyOverrides), { initialProps: { id: 'a' } });
    let oldDownload!: Promise<void>;
    let newDownload!: Promise<void>;
    const oldCallback = result.current.downloadWorkspace;
    act(() => { oldDownload = oldCallback(); });
    const signal = mocks.apiClient.get.mock.calls[0][1].signal;
    rerender({ id: 'b' });
    expect(signal.aborted).toBe(true);
    act(() => { newDownload = result.current.downloadWorkspace(); void oldCallback(); });
    await act(async () => { oldRequest.resolve(response([file('old')])); await oldDownload; });
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(2);
    expect(mocks.createWorkspaceArchive).not.toHaveBeenCalled();
    expect(result.current.downloading).toBe('workspace');
    await act(async () => { newRequest.resolve(response([file('new', 'current text', 'b')])); await newDownload; });
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1);
    expect(mocks.downloadBlob).toHaveBeenCalledWith(blob, 'b.zip');
  });

  it.each([null, { id: 'another-user' }])('cancels in-flight exports when the signed-in account changes to %j', async (nextUser) => {
    const archive = deferred<Blob>();
    mocks.createWorkspaceArchive.mockReturnValueOnce(archive.promise);
    const { result, rerender } = renderHook(() => useWorkspaceDownloads('a', 'Project', emptyOverrides));
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.downloadWorkspace(); });
    expect(mocks.createWorkspaceArchive).toHaveBeenCalledTimes(1);
    mocks.user = nextUser;
    rerender();
    await act(async () => { archive.resolve(blob); await pending; });
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
    expect(result.current.downloading).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(result.current.error).toBeNull();
    if (!nextUser) {
      await act(async () => { await result.current.downloadWorkspace(); });
      expect(mocks.apiClient.get).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['request', 'archive'])('prevents late %s completions from downloading after unmount', async (phase) => {
    const waiting = deferred<unknown>();
    if (phase === 'request') mocks.apiClient.get.mockReturnValueOnce(waiting.promise);
    else mocks.createWorkspaceArchive.mockReturnValueOnce(waiting.promise);
    const { result, unmount } = renderHook(() => useWorkspaceDownloads('a', 'Project', emptyOverrides));
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.downloadWorkspace(); });
    const signal = mocks.apiClient.get.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { waiting.resolve(phase === 'request' ? response([file('open')]) : blob); await pending; });
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
  });

  it('times out an unresponsive request, allows retry, and ignores the timed-out result', async () => {
    vi.useFakeTimers();
    const oldRequest = deferred();
    mocks.apiClient.get.mockReturnValueOnce(oldRequest.promise);
    const { result } = renderHook(() => useWorkspaceDownloads('a', 'Project', emptyOverrides));
    let pending!: Promise<void>;
    act(() => { pending = result.current.downloadWorkspace(); });
    const signal = mocks.apiClient.get.mock.calls[0][1].signal;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await pending; });
    expect(signal.aborted).toBe(true);
    expect(result.current.error).toContain('took too long');
    expect(result.current.downloading).toBeNull();
    await act(async () => { await result.current.downloadFile('open'); });
    expect(result.current.error).toBeNull();
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1);
    await act(async () => { oldRequest.resolve(response([file('old')])); });
    expect(mocks.downloadBlob).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceArchive).not.toHaveBeenCalled();
  });
});
