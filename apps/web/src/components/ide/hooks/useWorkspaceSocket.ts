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
  activeCollaborators: UserPayload[];
  chatMessages: ChatMessage[];
  typingUsers: TypingUser[];
  unreadMessages: number;
  setUnreadMessages: React.Dispatch<React.SetStateAction<number>>;
  sendChatMessage: (message: string) => void;
  handleChatInputChange: (value: string) => void;
  chatInput: string;
  setChatInput: React.Dispatch<React.SetStateAction<string>>;
}

export function useWorkspaceSocket(workspaceId: string): UseWorkspaceSocketReturn {
  const { apiClient, user, accessToken } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [activeCollaborators, setActiveCollaborators] = useState<UserPayload[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [chatInput, setChatInput] = useState('');
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<any>(null);
  const rightPanelOpenRef = useRef(false);

  // Fetch chat history
  const fetchChatHistory = useCallback(async () => {
    try {
      const res = await apiClient.get(`/workspaces/${workspaceId}/chat`);
      if (res.data && res.data.success) {
        setChatMessages(res.data.data.messages);
      }
    } catch (err) {
      console.error('Failed to load chat history:', err);
    }
  }, [workspaceId, apiClient]);

  useEffect(() => {
    fetchChatHistory();
  }, [fetchChatHistory]);

  // Connect socket
  useEffect(() => {
    const token = accessToken;
    if (!token) return;

    const wsUrl = (import.meta as any).env?.VITE_WS_URL || 'http://localhost:3000';
    const newSocket = io(wsUrl, { auth: { token }, forceNew: true });
    setSocket(newSocket);

    if (newSocket.connected) {
      console.info('🔌 Already Connected to Socket.IO Server');
      newSocket.emit('join_workspace', { workspaceId });
    }

    newSocket.on('connect', () => {
      console.info('🔌 Connected to Socket.IO Server');
      newSocket.emit('join_workspace', { workspaceId });
    });

    newSocket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
    });

    newSocket.on('disconnect', (reason) => {
      console.info('🔌 Disconnected from Socket.IO Server:', reason);
    });

    newSocket.on('workspace_users', (users: UserPayload[]) => {
      setActiveCollaborators(users);
    });

    newSocket.on('chat_message', (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
      if (!rightPanelOpenRef.current) {
        setUnreadMessages(prev => prev + 1);
      }
    });

    newSocket.on('typing_status', ({ userId, name, isTyping }: { userId: string; name: string; isTyping: boolean }) => {
      setTypingUsers(prev => {
        if (isTyping) {
          if (prev.some(u => u.userId === userId)) return prev;
          return [...prev, { userId, name }];
        }
        return prev.filter(u => u.userId !== userId);
      });
    });

    newSocket.on('error', (errMsg: string) => {
      console.error('Socket error:', errMsg);
    });

    return () => {
      newSocket.emit('leave_workspace', { workspaceId });
      newSocket.disconnect();
    };
  }, [workspaceId, accessToken]);

  const sendChatMessage = useCallback((message: string) => {
    if (!message.trim() || !socket) return;

    socket.emit('chat_message', { workspaceId, message: message.trim() });
    setChatInput('');

    if (isTypingRef.current) {
      isTypingRef.current = false;
      socket.emit('typing_status', { workspaceId, isTyping: false });
    }
  }, [workspaceId, socket]);

  const handleChatInputChange = useCallback((value: string) => {
    setChatInput(value);
    if (!socket) return;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket.emit('typing_status', { workspaceId, isTyping: true });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      isTypingRef.current = false;
      socket.emit('typing_status', { workspaceId, isTyping: false });
    }, 2000);
  }, [workspaceId, socket]);

  return {
    socket,
    activeCollaborators,
    chatMessages,
    typingUsers,
    unreadMessages,
    setUnreadMessages,
    sendChatMessage,
    handleChatInputChange,
    chatInput,
    setChatInput,
  };
}

// Re-export socket ref accessor for editor sync
export function getSocketRef() {
  return null; // Socket is managed via context
}
