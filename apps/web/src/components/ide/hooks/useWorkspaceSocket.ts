import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { io, Socket } from 'socket.io-client';

interface UserPayload {
  id: string;
  name: string;
  email: string;
}

interface ChatMessage {
  id?: string;
  workspaceId?: string;
  userId: string;
  message: string;
  createdAt: string;
  user?: { id: string; name: string; email: string };
}

interface TypingUser {
  userId: string;
  name: string;
}

interface UseWorkspaceSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  activeCollaborators: UserPayload[];
  chatMessages: ChatMessage[];
  typingUsers: TypingUser[];
  unreadMessages: number;
  setUnreadMessages: React.Dispatch<React.SetStateAction<number>>;
  sendChatMessage: (message: string) => void;
  handleChatInputChange: (value: string) => void;
  chatInput: string;
  setChatInput: React.Dispatch<React.SetStateAction<string>>;
  /** Most recent authorization denial from the server, if any. */
  permissionError: string | null;
  clearPermissionError: () => void;
}

function mergeMessages(history: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const messages = new Map<string, ChatMessage>();
  for (const message of [...history, ...live]) {
    const key = message.id || JSON.stringify([message.userId, message.createdAt, message.message]);
    messages.set(key, message);
  }
  return [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function useWorkspaceSocket(workspaceId: string, chatVisible = false): UseWorkspaceSocketReturn {
  const { apiClient, user, accessToken } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [activeCollaborators, setActiveCollaborators] = useState<UserPayload[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [chatInput, setChatInput] = useState('');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rightPanelOpenRef = useRef(chatVisible);
  rightPanelOpenRef.current = chatVisible;

  const clearPermissionError = useCallback(() => setPermissionError(null), []);

  useEffect(() => {
    setChatMessages([]);
    setChatInput('');
    setUnreadMessages(0);
    setPermissionError(null);
  }, [workspaceId, user?.id]);

  useEffect(() => {
    if (chatVisible) setUnreadMessages(0);
  }, [chatVisible]);

  // Connect socket
  useEffect(() => {
    const token = accessToken;
    setIsConnected(false);
    setActiveCollaborators([]);
    setTypingUsers([]);
    setSocket(null);
    if (!token) return;

    const wsUrl = (import.meta as any).env?.VITE_WS_URL || 'http://localhost:3000';
    const newSocket = io(wsUrl, { auth: { token }, forceNew: true });
    let active = true;
    let historyRequest = 0;
    setSocket(newSocket);

    const fetchChatHistory = async () => {
      const request = ++historyRequest;
      try {
        const res = await apiClient.get(`/workspaces/${workspaceId}/chat`);
        if (active && request === historyRequest && res.data?.success) {
          // Live messages can arrive before this request finishes. Merging
          // keeps them visible and avoids duplicates also present in history.
          setChatMessages(prev => mergeMessages(res.data.data.messages, prev));
        }
      } catch (err) {
        if (active) console.error('Failed to load chat history:', err);
      }
    };

    const onConnect = () => {
      if (!active) return;
      setIsConnected(true);
      console.info('\ud83d\udd0c Connected to Socket.IO Server');
      newSocket.emit('join_workspace', { workspaceId });
      // Also fills any chat gap after a reconnect.
      void fetchChatHistory();
    };

    newSocket.on('connect', onConnect);

    newSocket.on('connect_error', (err) => {
      if (!active) return;
      setIsConnected(false);
      console.error('Socket connection error:', err.message);
    });

    newSocket.on('disconnect', (reason) => {
      if (!active) return;
      setIsConnected(false);
      setActiveCollaborators([]);
      setTypingUsers([]);
      isTypingRef.current = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
      console.info('\ud83d\udd0c Disconnected from Socket.IO Server:', reason);
    });

    newSocket.on('workspace_users', (users: UserPayload[]) => {
      if (!active) return;
      // Presence is per socket on the server, but the list represents people.
      setActiveCollaborators([...new Map(users.map(person => [person.id, person])).values()]);
    });

    newSocket.on('chat_message', (msg: ChatMessage) => {
      if (!active || (msg.workspaceId && msg.workspaceId !== workspaceId)) return;
      setChatMessages(prev => mergeMessages([], [...prev, msg]));
      if (!rightPanelOpenRef.current && msg.userId !== user?.id) {
        setUnreadMessages(prev => prev + 1);
      }
    });

    newSocket.on('typing_status', ({ userId, name, isTyping }: { userId: string; name: string; isTyping: boolean }) => {
      if (!active || userId === user?.id) return;
      setTypingUsers(prev => {
        if (isTyping) {
          if (prev.some(u => u.userId === userId)) return prev;
          return [...prev, { userId, name }];
        }
        return prev.filter(u => u.userId !== userId);
      });
    });

    // The server now authorizes every socket event against workspace
    // membership and replies with authz_error when it refuses. Without this
    // listener a denial is completely silent and the UI just looks broken.
    newSocket.on('authz_error', ({ event, message }: { event: string; message: string }) => {
      if (!active) return;
      console.warn(`Socket event ${event} was denied: ${message}`);
      setPermissionError(message || 'You do not have permission to do that.');
    });

    newSocket.on('error', (errMsg: string) => {
      console.error('Socket error:', errMsg);
    });

    if (newSocket.connected) onConnect();
    else void fetchChatHistory();

    return () => {
      active = false;
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
      isTypingRef.current = false;
      if (newSocket.connected) newSocket.emit('leave_workspace', { workspaceId });
      newSocket.disconnect();
    };
  }, [workspaceId, accessToken, apiClient, user?.id]);

  const sendChatMessage = useCallback((message: string) => {
    if (!message.trim() || !socket?.connected) return;

    socket.emit('chat_message', { workspaceId, message: message.trim() });
    setChatInput('');
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = null;

    if (isTypingRef.current) {
      isTypingRef.current = false;
      socket.emit('typing_status', { workspaceId, isTyping: false });
    }
  }, [workspaceId, socket]);

  const handleChatInputChange = useCallback((value: string) => {
    setChatInput(value);
    if (!socket?.connected) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket.emit('typing_status', { workspaceId, isTyping: true });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      typingTimeoutRef.current = null;
      if (socket.connected) socket.emit('typing_status', { workspaceId, isTyping: false });
    }, 2000);
  }, [workspaceId, socket]);

  return {
    socket,
    isConnected,
    activeCollaborators,
    chatMessages,
    typingUsers,
    unreadMessages,
    setUnreadMessages,
    sendChatMessage,
    handleChatInputChange,
    chatInput,
    setChatInput,
    permissionError,
    clearPermissionError,
  };
}

// Re-export socket ref accessor for editor sync
export function getSocketRef() {
  return null; // Socket is managed via context
}
