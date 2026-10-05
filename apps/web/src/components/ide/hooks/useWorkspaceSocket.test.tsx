import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSocket } from './useWorkspaceSocket';

const { apiClient, auth, ioMock, refreshAccessToken } = vi.hoisted(() => ({
  apiClient: { get: vi.fn() },
  auth: { accessToken: 'token' as string | null, user: { id: 'self' } },
  ioMock: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ ...auth, apiClient, refreshAccessToken }) }));
vi.mock('socket.io-client', () => ({ io: ioMock }));

class FakeSocket {
  connected = true;
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  emit = vi.fn();
  connect = vi.fn();
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
    auth.user = { id: 'self' };
    sockets = [];
    ioMock.mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    apiClient.get.mockResolvedValue(history([]));
    refreshAccessToken.mockImplementation(async () => {
      auth.accessToken = 'renewed-token';
      return auth.accessToken;
    });
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
    expect(result.current.presenceReady).toBe(false);
    const person = { id: 'other', name: 'Other', email: 'other@example.com' };
    await act(async () => {
      sockets[0].receive('workspace_users', [person, person]);
      sockets[0].receive('typing_status', { userId: 'other', name: 'Other', isTyping: true });
    });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.presenceReady).toBe(true);
    expect(result.current.activeCollaborators).toEqual([person]);
    act(() => { sockets[0].disconnect(); });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.presenceReady).toBe(false);
    expect(result.current.activeCollaborators).toEqual([]);
    expect(result.current.typingUsers).toEqual([]);
    act(() => { sockets[0].receive('workspace_users', [person]); });
    expect(result.current.activeCollaborators).toEqual([]);
    expect(result.current.presenceReady).toBe(false);
    await act(async () => { sockets[0].connected = true; sockets[0].receive('connect'); });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.presenceReady).toBe(false);
    expect(sockets[0].emit.mock.calls.filter(([event]) => event === 'join_workspace')).toHaveLength(2);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    act(() => { sockets[0].receive('workspace_users', [person]); });
    expect(result.current.presenceReady).toBe(true);
  });

  it('keeps a healthy socket and presence through token rotation, using the new token for the next handshake', async () => {
    const { result, rerender } = renderHook(() => useWorkspaceSocket('workspace-a'));
    const person = { id: 'self', name: 'Self', email: 'self@example.com' };
    await act(async () => { sockets[0].receive('workspace_users', [person]); });
    const sendAuth = vi.fn();
    const authenticate = ioMock.mock.calls[0][1].auth;
    authenticate(sendAuth);
    expect(sendAuth).toHaveBeenLastCalledWith({ token: 'token' });

    await act(async () => { auth.accessToken = 'refreshed-token'; rerender(); });

    expect(ioMock).toHaveBeenCalledOnce();
    expect(sockets[0].disconnect).not.toHaveBeenCalled();
    expect(result.current.socket).toBe(sockets[0]);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.presenceReady).toBe(true);
    expect(result.current.activeCollaborators).toEqual([person]);
    authenticate(sendAuth);
    expect(sendAuth).toHaveBeenLastCalledWith({ token: 'refreshed-token' });
  });

  it('replaces the socket when the signed-in user changes', async () => {
    const { result, rerender } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => {
      sockets[0].receive('workspace_users', [{ id: 'self', name: 'Self', email: 'self@example.com' }]);
      auth.user = { id: 'different-user' };
      auth.accessToken = 'different-token';
      rerender();
    });
    expect(sockets[0].disconnect).toHaveBeenCalledOnce();
    expect(ioMock).toHaveBeenCalledTimes(2);
    expect(result.current.socket).toBe(sockets[1]);
    expect(result.current.presenceReady).toBe(false);
    expect(result.current.activeCollaborators).toEqual([]);
  });

  it('renews an expired token and explicitly retries a middleware-denied reconnect once', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    const sendAuth = vi.fn();
    const authenticate = ioMock.mock.calls[0][1].auth;
    await act(async () => {
      sockets[0].disconnect();
      authenticate(sendAuth);
      sockets[0].receive('connect_error', new Error('Authentication error: Invalid token'));
    });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(sockets[0].connect).toHaveBeenCalledOnce();
    authenticate(sendAuth);
    expect(sendAuth).toHaveBeenLastCalledWith({ token: 'renewed-token' });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.presenceReady).toBe(false);

    await act(async () => {
      sockets[0].receive('connect_error', new Error('Authentication error: Invalid token'));
    });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(sockets[0].connect).toHaveBeenCalledOnce();
    expect(result.current.permissionError).toMatch(/Sign in again/);
  });

  it('does not refresh authentication for a transient network failure', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => {
      sockets[0].disconnect();
      sockets[0].receive('connect_error', new Error('websocket error'));
    });
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(sockets[0].connect).not.toHaveBeenCalled();
    expect(result.current.permissionError).toBeNull();
  });

  it.each(['workspace', 'logout', 'account'] as const)('does not reconnect an old socket when %s changes during token renewal', async change => {
    const renewal = deferred();
    refreshAccessToken.mockReturnValue(renewal.promise);
    const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceSocket(workspaceId), { initialProps: { workspaceId: 'workspace-a' } });
    await act(async () => {
      sockets[0].disconnect();
      sockets[0].receive('connect_error', new Error('Authentication error: Invalid token'));
    });
    await act(async () => {
      if (change === 'logout') auth.accessToken = null;
      if (change === 'account') { auth.user = { id: 'new-user' }; auth.accessToken = 'new-token'; }
      rerender({ workspaceId: change === 'workspace' ? 'workspace-b' : 'workspace-a' });
    });
    await act(async () => { renewal.resolve('old-session-token'); });
    expect(sockets[0].connect).not.toHaveBeenCalled();
    expect(result.current.socket).toBe(change === 'logout' ? null : sockets[1]);
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
    expect(result.current.presenceReady).toBe(false);
    expect(sockets[0].disconnect).toHaveBeenCalledOnce();
  });

  it('waits for delivery acknowledgment before clearing a sent draft and prevents duplicate submissions', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { result.current.handleChatInputChange('  A question  '); });
    act(() => {
      result.current.sendChatMessage('  A question  ');
      result.current.sendChatMessage('  A question  ');
    });
    const sends = sockets[0].emit.mock.calls.filter(([event]) => event === 'chat_message');
    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toEqual({ workspaceId: 'workspace-a', message: 'A question' });
    expect(result.current.chatInput).toBe('  A question  ');
    expect(result.current.isSendingChat).toBe(true);
    act(() => { sends[0][2]({ success: true }); });
    expect(result.current.chatInput).toBe('');
    expect(result.current.isSendingChat).toBe(false);
    expect(result.current.chatSendError).toBeNull();
  });

  it('preserves a draft after a delivery failure and allows an explicit retry', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { result.current.handleChatInputChange('Keep this draft'); });
    act(() => { result.current.sendChatMessage('Keep this draft'); });
    const sent = sockets[0].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    act(() => { sent[2]({ success: false, error: 'Please try again.' }); });
    expect(result.current.chatInput).toBe('Keep this draft');
    expect(result.current.isSendingChat).toBe(false);
    expect(result.current.chatSendError).toBe('Please try again.');
    act(() => { result.current.sendChatMessage('Keep this draft'); });
    const sends = sockets[0].emit.mock.calls.filter(([event]) => event === 'chat_message');
    expect(sends).toHaveLength(2);
    expect(result.current.chatSendError).toBeNull();
    act(() => { sends[1][2]({ success: true }); });
    expect(result.current.chatInput).toBe('');
  });

  it('preserves a newer draft typed while an earlier message is waiting for delivery', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { result.current.handleChatInputChange('First message'); });
    act(() => { result.current.sendChatMessage('First message'); });
    const sent = sockets[0].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    act(() => { result.current.handleChatInputChange('Second message in progress'); });
    act(() => { sent[2]({ success: true }); });
    expect(result.current.chatInput).toBe('Second message in progress');
    expect(result.current.isSendingChat).toBe(false);
  });

  it('times out uncertain delivery without erasing a draft or retrying automatically', async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { result.current.handleChatInputChange('Maybe delivered'); });
    act(() => { result.current.sendChatMessage('Maybe delivered'); });
    const sent = sockets[0].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    act(() => { vi.advanceTimersByTime(10000); });
    expect(result.current.isSendingChat).toBe(false);
    expect(result.current.chatInput).toBe('Maybe delivered');
    expect(result.current.chatSendError).toMatch(/Check the chat before sending again/);
    expect(sockets[0].emit.mock.calls.filter(([event]) => event === 'chat_message')).toHaveLength(1);
    act(() => { sent[2]({ success: true }); });
    expect(result.current.chatInput).toBe('Maybe delivered');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an unconfirmed draft on disconnect and ignores a late acknowledgment', async () => {
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { result.current.handleChatInputChange('Network interrupted'); });
    act(() => { result.current.sendChatMessage('Network interrupted'); });
    const sent = sockets[0].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    act(() => { sockets[0].disconnect(); });
    expect(result.current.isSendingChat).toBe(false);
    expect(result.current.chatSendError).toMatch(/Delivery was not confirmed/);
    act(() => { sent[2]({ success: true }); });
    expect(result.current.chatInput).toBe('Network interrupted');
  });

  it('ignores an old delivery response after switching workspaces, including during a new send', async () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(({ workspaceId }) => useWorkspaceSocket(workspaceId), { initialProps: { workspaceId: 'workspace-a' } });
    await act(async () => { result.current.handleChatInputChange('First room'); });
    act(() => { result.current.sendChatMessage('First room'); });
    const oldSend = sockets[0].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    await act(async () => { rerender({ workspaceId: 'workspace-b' }); });
    expect(result.current.isSendingChat).toBe(false);
    expect(result.current.chatSendError).toBeNull();
    act(() => { result.current.handleChatInputChange('Second room'); });
    act(() => { result.current.sendChatMessage('Second room'); });
    act(() => { oldSend[2]({ success: true }); });
    expect(result.current.chatInput).toBe('Second room');
    expect(result.current.isSendingChat).toBe(true);
    const newSend = sockets[1].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    act(() => { newSend[2]({ success: true }); });
    expect(result.current.chatInput).toBe('');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets a pending delivery when access is removed without an account change', async () => {
    const { result, rerender } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => { result.current.handleChatInputChange('Interrupted'); });
    act(() => { result.current.sendChatMessage('Interrupted'); });
    const sent = sockets[0].emit.mock.calls.find(([event]) => event === 'chat_message')!;
    await act(async () => { auth.accessToken = null; rerender(); });
    expect(result.current.isSendingChat).toBe(false);
    await act(async () => { auth.accessToken = 'restored-token'; rerender(); });
    act(() => { result.current.handleChatInputChange('After signing back in'); });
    act(() => { sent[2]({ success: true }); });
    expect(result.current.chatInput).toBe('After signing back in');
    expect(result.current.isSendingChat).toBe(false);
  });

  it('exposes a chat history failure and retries while retaining live messages', async () => {
    apiClient.get.mockRejectedValueOnce(new Error('Network unavailable'));
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    await act(async () => {});
    expect(result.current.chatHistoryLoading).toBe(false);
    expect(result.current.chatHistoryError).toMatch(/Chat history could not load/);
    act(() => { sockets[0].receive('chat_message', chat('new')); });
    const loading = deferred();
    apiClient.get.mockReturnValueOnce(loading.promise);
    act(() => { result.current.retryChatHistory(); });
    expect(result.current.chatHistoryLoading).toBe(true);
    expect(result.current.chatHistoryError).toBeNull();
    expect(result.current.chatMessages.map(message => message.id)).toEqual(['new']);
    await act(async () => { loading.resolve(history([chat('old'), chat('new')])); });
    expect(result.current.chatMessages.map(message => message.id)).toEqual(['old', 'new']);
    expect(result.current.chatHistoryLoading).toBe(false);
  });

  it('does not let a stale history request overwrite the outcome of a newer retry', async () => {
    const oldRequest = deferred();
    const latestRequest = deferred();
    apiClient.get.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(latestRequest.promise);
    const { result } = renderHook(() => useWorkspaceSocket('workspace-a'));
    act(() => { result.current.retryChatHistory(); });
    await act(async () => { latestRequest.resolve(history([chat('new')])); });
    await act(async () => { oldRequest.resolve({ data: { success: false } }); });
    expect(result.current.chatHistoryError).toBeNull();
    expect(result.current.chatHistoryLoading).toBe(false);
    expect(result.current.chatMessages.map(message => message.id)).toEqual(['new']);
  });
});
