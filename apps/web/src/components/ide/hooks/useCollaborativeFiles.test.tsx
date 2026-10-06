import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { useCollaborativeFiles } from './useCollaborativeFiles';

function fakeSocket() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const socket = {
    connected: true,
    emit: vi.fn(),
    on: vi.fn((event: string, listener: (payload?: unknown) => void) => handlers.set(event, listener)),
    off: vi.fn((event: string) => handlers.delete(event)),
  };
  return { socket, receive: (event: string, payload?: unknown) => handlers.get(event)?.(payload) };
}

describe('collaboration download contents', () => {
  it('only exports initialized live buffers and takes a copy including synchronous unsaved edits in every opened file', () => {
    const { socket, receive } = fakeSocket();
    const { result, rerender } = renderHook(({ id }) => useCollaborativeFiles(socket as unknown as Socket, id, 'stale cache', vi.fn()), { initialProps: { id: 'first' } });
    expect([...result.current.getDownloadContents()]).toEqual([]);
    act(() => receive('file_init', { fileId: 'first', content: 'first\r\n', version: 0 }));
    const beforeEdit = result.current.getDownloadContents();
    act(() => {
      result.current.replaceContent('first', 'first draft\r\n');
      expect(result.current.getDownloadContents().get('first')).toBe('first draft\r\n');
    });
    expect(beforeEdit.get('first')).toBe('first\r\n');
    rerender({ id: 'second' });
    act(() => receive('file_init', { fileId: 'second', content: 'second', version: 0 }));
    expect([...result.current.getDownloadContents()]).toEqual([['first', 'first draft\r\n'], ['second', 'second']]);
  });

  it('retains unsaved disconnected buffers while leaving saved disconnected files to the fresh server listing', () => {
    const { socket, receive } = fakeSocket();
    const { result, rerender } = renderHook(({ id }) => useCollaborativeFiles(socket as unknown as Socket, id, '', vi.fn()), { initialProps: { id: 'draft' } });
    act(() => receive('file_init', { fileId: 'draft', content: 'before', version: 0 }));
    act(() => result.current.replaceContent('draft', 'unsaved draft'));
    rerender({ id: 'saved' });
    act(() => receive('file_init', { fileId: 'saved', content: 'saved', version: 0 }));
    act(() => { socket.connected = false; receive('disconnect'); });
    expect([...result.current.getDownloadContents()]).toEqual([['draft', 'unsaved draft']]);
  });

  it('keeps acknowledged edits until persistence is confirmed, including while disconnected', () => {
    const { socket, receive } = fakeSocket();
    const { result } = renderHook(() => useCollaborativeFiles(socket as unknown as Socket, 'draft', '', vi.fn()));
    act(() => receive('file_init', { fileId: 'draft', content: 'before', version: 0 }));
    act(() => result.current.replaceContent('draft', 'acknowledged draft'));
    const edit = socket.emit.mock.calls.find(([event]) => event === 'edit_file')![1];
    act(() => receive('file_edit_ack', { fileId: 'draft', version: 1, operation: edit.operation, editId: edit.editId }));
    act(() => { socket.connected = false; receive('disconnect'); });
    expect([...result.current.getDownloadContents()]).toEqual([['draft', 'acknowledged draft']]);
    act(() => receive('file_saved', { fileId: 'draft', version: 1 }));
    expect([...result.current.getDownloadContents()]).toEqual([]);
  });

  it('never inserts deleted files or their preserved recovery copies into a workspace export', () => {
    const { socket, receive } = fakeSocket();
    const { result } = renderHook(() => useCollaborativeFiles(socket as unknown as Socket, 'deleted', '', vi.fn()));
    act(() => receive('file_init', { fileId: 'deleted', content: 'before', version: 0 }));
    act(() => result.current.replaceContent('deleted', 'unsaved draft'));
    act(() => receive('file_deleted', { fileId: 'deleted' }));
    expect(result.current.recoveries).toHaveLength(1);
    expect([...result.current.getDownloadContents()]).toEqual([]);
  });
});
