import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSocket } from './useWorkspaceSocket';

const { apiClient, auth, ioMock } = vi.hoisted(() => ({
  apiClient: { get: vi.fn() },
  auth: { accessToken: 'token' as string | null, user: { id: 'self' } },
  ioMock: vi.fn(),
}));

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ ...auth, apiClient }) }));
vi.mock('socket.io-client', () => ({ io: ioMock }));

class FakeSocket {
  connected = true;
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  emit = vi.fn();
  on(event: string, handler: (...args: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) || []), handler]);
  }
  receive(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) || []) handler(...args);
  }
  disconnect = vi.fn(() => {
    this.connected = false;
    this.receive('disconnect', 'transport close');
  });
}

const chat = (id: string, userId = 'other') => ({ id, userId, message: id, createdAt: `2026-10-03T10:00:0${id === 'old' ? 0 : 1}.000Z` });
const history = (messages: unknown[]) => ({ data: { success: true, data: { messages } } });

function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(res => { resolve = res; });
  return { promise, resolve };
}

describe('useWorkspaceSocket', () => {
  let sockets: FakeSocket[];

  beforeEach(() => {
    vi.resetAllMocks();
    auth.accessToken = 'token';
    sockets = [];
    ioMock.mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    apiClient.get.mockResolvedValue(history([]));
  });

  afterEach(() => { vi.useRealTimers(); });

  it('retains live messages received while history loads, without duplicates', async () => {
    const loading = deferred();
    apiClient.get.mockReturnValueOnce(loading.promise);
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    act(() => { sockets[0].receive('chat_message', chat('new')); });
    await act(async () => { loading.resolve(history([chat('old'), chat('new')])); });
    expect(result.current.chatMessages.map(message => message.id)).toEqual(['old', 'new']);
  });

  it('ignores delayed history and socket events from a previous workspace', async () => {
    const oldHistory = deferred();
    apiClient.get.mockReturnValueOnce(oldHistory.promise).mockResolvedValueOnce(history([chat('new')]));
    const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceSocket(workspaceId), { initialProps: { workspaceId: 'workspace-a' } });
    await act(async () => { rerender({ workspaceId: 'workspace-b' }); });
    await act(async () => {
      oldHistory.resolve(history([chat('old')]));
      sockets[0].receive('chat_message', chat('late'));
    });
    expect(result.current.chatMessages.map(message => message.id)).toEqual(['new']);
    expect(sockets[0].disconnect).toHaveBeenCalledOnce();
  });

  it('deduplicates people with multiple sockets and clears stale presence on disconnect', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    const person = { id: 'other', name: 'Other', email: 'other@example.com' };
    await act(async () => {
      sockets[0].receive('workspace_users', [person, person]);
      sockets[0].receive('typing_status', { userId: 'other', name: 'Other', isTyping: true });
    });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.activeCollaborators).toEqual([person]);
    act(() => { sockets[0].disconnect(); });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.activeCollaborators).toEqual([]);
    expect(result.current.typingUsers).toEqual([]);
    await act(async () => { sockets[0].connected = true; sockets[0].receive('connect'); });
    expect(result.current.isConnected).toBe(true);
    expect(sockets[0].emit.mock.calls.filter(([event]) => event === 'join_workspace')).toHaveLength(2);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('clears typing timers when switching workspace and allows typing in the new room', async () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(({ workspaceId }) => useWorkspaceSocket(workspaceId), { initialProps: { workspaceId: 'workspace-a' } });
    await act(async () => { result.current.handleChatInputChange('draft'); });
    await act(async () => { rerender({ workspaceId: 'workspace-b' }); });
    sockets[0].emit.mockClear();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(sockets[0].emit).not.toHaveBeenCalled();
    act(() => { result.current.handleChatInputChange('new draft'); });
    expect(sockets[1].emit).toHaveBeenLastCalledWith('typing_status', { workspaceId: 'workspace-b', isTyping: true });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count own messages or visible chat as unread and keeps offline input', async () => {
    const { result, rerender } = renderHook(({ visible }) => useWorkspaceSocket('workspace-a', visible), { initialProps: { visible: false } });
    await act(async () => {
      sockets[0].receive('chat_message', chat('own', 'self'));
      sockets[0].receive('chat_message', chat('other'));
    });
    expect(result.current.unreadMessages).toBe(1);
    rerender({ visible: true });
    act(() => { sockets[0].receive('chat_message', chat('visible')); });
    expect(result.current.unreadMessages).toBe(0);
    act(() => {
      sockets[0].disconnect();
      result.current.handleChatInputChange('offline draft');
      result.current.sendChatMessage('offline draft');
    });
    expect(result.current.chatInput).toBe('offline draft');
    expect(sockets[0].emit.mock.calls.some(([event]) => event === 'chat_message')).toBe(false);
  });

  it('drops the exposed socket and connection state when the token is removed', async () => {
    const { result, rerender } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { auth.accessToken = null; rerender(); });
    expect(result.current.socket).toBeNull();
    expect(result.current.isConnected).toBe(false);
    expect(sockets[0].disconnect).toHaveBeenCalledOnce();
  });
});
