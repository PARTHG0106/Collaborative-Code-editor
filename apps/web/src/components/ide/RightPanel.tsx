import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, MessageSquare, Users } from 'lucide-react';
import './collaboration.css';

const getColor = (id: string) => {
  const colors = ['#556B5D', '#70806e', '#8f9e8b', '#a99f8c', '#5d6b70', '#7f8e94', '#5c6454', '#58705c'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h % colors.length)];
};

interface ChatMessage {
  id?: string;
  userId: string;
  message: string;
  createdAt: string;
  user?: { name: string };
}

interface RightPanelProps {
  collapsed: boolean;
  workspaceId?: string;
  chatMessages: ChatMessage[];
  chatHistoryLoading?: boolean;
  chatHistoryError?: string | null;
  onRetryChatHistory?: () => void;
  chatSendError?: string | null;
  isSendingChat?: boolean;
  unreadMessages?: number;
  onChatVisibilityChange?: (visible: boolean) => void;
  typingUsers: { userId: string; name: string }[];
  chatInput: string;
  onChatInputChange: (val: string) => void;
  onSendMessage: (msg: string) => void;
  activeCollaborators: { id: string; name: string; email: string }[];
  isConnected: boolean;
  presenceReady: boolean;
  currentUserId: string;
}

const messageKey = (message: ChatMessage) => message.id || JSON.stringify([message.userId, message.createdAt, message.message]);

export const RightPanel: React.FC<RightPanelProps> = ({
  collapsed, workspaceId, chatMessages, chatHistoryLoading = false, chatHistoryError,
  onRetryChatHistory, chatSendError, isSendingChat = false, unreadMessages = 0, onChatVisibilityChange, typingUsers, chatInput,
  onChatInputChange, onSendMessage, activeCollaborators, isConnected, presenceReady, currentUserId,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'users'>('chat');
  const [newMessages, setNewMessages] = useState(0);
  const chatListRef = useRef<HTMLDivElement>(null);
  const chatTabRef = useRef<HTMLButtonElement>(null);
  const usersTabRef = useRef<HTMLButtonElement>(null);
  const nearBottomRef = useRef(true);
  const previousMessagesRef = useRef(chatMessages);
  const panelId = useId();
  const chatVisible = !collapsed && activeTab === 'chat';
  const canSend = isConnected && presenceReady && !isSendingChat && Boolean(chatInput.trim());
  const visibleTypingUsers = isConnected && presenceReady ? typingUsers.filter(person => person.userId !== currentUserId) : [];

  const scrollToLatest = useCallback(() => {
    const list = chatListRef.current;
    // Scroll only the message list; scrollIntoView can also move the entire IDE.
    if (list) list.scrollTop = list.scrollHeight;
    nearBottomRef.current = true;
    setNewMessages(0);
  }, []);

  useEffect(() => {
    nearBottomRef.current = true;
    previousMessagesRef.current = [];
    setNewMessages(0);
  }, [workspaceId]);

  useEffect(() => {
    onChatVisibilityChange?.(chatVisible);
    return () => onChatVisibilityChange?.(false);
  }, [chatVisible, onChatVisibilityChange]);

  useEffect(() => {
    if (chatVisible) scrollToLatest();
  }, [chatVisible, workspaceId, scrollToLatest]);

  useEffect(() => {
    const previousMessages = previousMessagesRef.current;
    previousMessagesRef.current = chatMessages;
    if (!chatVisible) return;
    if (nearBottomRef.current) {
      scrollToLatest();
      return;
    }

    const previousNewest = previousMessages[previousMessages.length - 1];
    if (!previousNewest) return;
    const previousKeys = new Set(previousMessages.map(messageKey));
    // Older history arriving after a live message must not count as a new reply.
    const added = chatMessages.filter(message =>
      !previousKeys.has(messageKey(message)) && message.createdAt >= previousNewest.createdAt,
    );
    if (added.length) setNewMessages(count => count + added.length);
  }, [chatMessages, chatVisible, scrollToLatest]);

  const sendMessage = () => {
    if (!canSend) return;
    onSendMessage(chatInput.trim());
    scrollToLatest();
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextTab = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'users' : activeTab === 'chat' ? 'users' : 'chat';
    setActiveTab(nextTab);
    (nextTab === 'chat' ? chatTabRef : usersTabRef).current?.focus();
  };

  if (collapsed) return null;

  return (
    <aside className="ide-right-panel" aria-label="Workspace collaboration">
      <div className="ide-right-tabs" role="tablist" aria-label="Collaboration panels">
        <button ref={chatTabRef} id={`${panelId}-chat-tab`} type="button" role="tab"
          aria-selected={activeTab === 'chat'} aria-controls={`${panelId}-chat`} tabIndex={activeTab === 'chat' ? 0 : -1}
          className={`ide-right-tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')} onKeyDown={handleTabKeyDown}>
          <MessageSquare size={12} aria-hidden="true" /> Chat
          {unreadMessages > 0 && <span className="ide-chat-unread" aria-label={`${unreadMessages} unread messages`}>{unreadMessages > 99 ? '99+' : unreadMessages}</span>}
        </button>
        <button ref={usersTabRef} id={`${panelId}-users-tab`} type="button" role="tab"
          aria-selected={activeTab === 'users'} aria-controls={`${panelId}-users`} tabIndex={activeTab === 'users' ? 0 : -1}
          className={`ide-right-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')} onKeyDown={handleTabKeyDown}>
          <Users size={12} aria-hidden="true" /> Online ({presenceReady ? activeCollaborators.length : '—'})
        </button>
      </div>

      <div className="ide-right-body">
        <div className="ide-chat" id={`${panelId}-chat`} role="tabpanel" aria-labelledby={`${panelId}-chat-tab`} hidden={activeTab !== 'chat'}>
          <div className="ide-chat-messages" ref={chatListRef} role="log" aria-label="Workspace messages" aria-live="polite" aria-relevant="additions" tabIndex={0}
            onScroll={() => {
              const list = chatListRef.current;
              if (!list) return;
              nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
              if (nearBottomRef.current) setNewMessages(0);
            }}>
            {chatHistoryLoading && <p className="ide-collaboration-notice" role="status">Loading chat history…</p>}
            {chatHistoryError && <div className="ide-collaboration-notice ide-collaboration-error" role="alert">
              <p>{chatHistoryError}</p>
              {onRetryChatHistory && <button className="ide-btn" type="button" onClick={onRetryChatHistory} disabled={chatHistoryLoading}>Retry chat history</button>}
            </div>}
            {!chatHistoryLoading && !chatHistoryError && chatMessages.length === 0 && <div className="ide-chat-empty">
              <MessageSquare size={24} aria-hidden="true" />
              <strong>Start the conversation</strong>
              <p>Share a question with your team or leave a note for your next session.</p>
              <span>Messages are visible to everyone in this workspace.</span>
            </div>}
            {chatMessages.map(msg => {
              const createdAt = new Date(msg.createdAt);
              const validDate = !Number.isNaN(createdAt.getTime());
              return <div key={messageKey(msg)} className="ide-chat-msg">
                <div className="ide-chat-msg-meta">
                  <span className="ide-chat-msg-author">{msg.user?.name || 'User'}{msg.userId === currentUserId && <span className="ide-collaboration-you"> (you)</span>}</span>
                  {validDate && <time className="ide-chat-msg-time" dateTime={msg.createdAt} title={createdAt.toLocaleString()}>
                    {createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>}
                </div>
                <div className="ide-chat-msg-text">{msg.message}</div>
              </div>;
            })}
          </div>
          {newMessages > 0 && <button type="button" className="ide-chat-jump" onClick={scrollToLatest}>
            <ArrowDown size={12} aria-hidden="true" /> {newMessages} new {newMessages === 1 ? 'message' : 'messages'} · Jump to latest
          </button>}
          {visibleTypingUsers.length > 0 && <div className="ide-chat-typing" role="status">
            {visibleTypingUsers.map(person => person.name).join(', ')} {visibleTypingUsers.length === 1 ? 'is' : 'are'} typing…
          </div>}
          <div className="ide-chat-composer">
            {chatSendError && <p className="ide-collaboration-notice ide-collaboration-error" role="alert">{chatSendError}</p>}
            <form className="ide-chat-form" onSubmit={event => { event.preventDefault(); sendMessage(); }}>
              <textarea className="ide-chat-input" aria-label="Message to workspace" aria-describedby={`${panelId}-composer-help`}
                placeholder="Write a message…" rows={2} maxLength={4000} value={chatInput} onChange={event => onChatInputChange(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    sendMessage();
                  }
                }} />
              <button type="submit" className="ide-btn primary" disabled={!canSend}>{isSendingChat ? 'Sending…' : 'Send'}</button>
            </form>
            <p id={`${panelId}-composer-help`} className="ide-chat-composer-help" role={!isConnected || !presenceReady ? 'status' : undefined}>
              {!isConnected ? 'Reconnecting… You can keep writing your message.' : !presenceReady ? 'Joining the workspace… Your message will stay here.' : 'Enter to send · Shift+Enter for a new line'}
              {chatInput.length >= 3500 && <span> · {chatInput.length.toLocaleString()}/4,000 characters</span>}
            </p>
          </div>
        </div>

        <div id={`${panelId}-users`} role="tabpanel" aria-labelledby={`${panelId}-users-tab`} hidden={activeTab !== 'users'}>
          {!presenceReady && <p className="ide-collaboration-notice" role="status">
            {isConnected ? 'Loading online users…' : 'Reconnecting. Online users are temporarily unavailable.'}
          </p>}
          {presenceReady && activeCollaborators.map(person => <div key={person.id} className="ide-online-user">
            <div className="ide-online-avatar" style={{ background: getColor(person.id) }} aria-hidden="true">
              {person.name.trim().charAt(0).toUpperCase() || '?'}
              <span className="ide-online-dot" />
            </div>
            <div className="ide-online-info">
              <span className="ide-online-name">{person.name}{person.id === currentUserId && <span className="ide-collaboration-you"> (you)</span>}</span>
              <span className="ide-online-status" title={person.email}>{person.email}</span>
            </div>
          </div>)}
          {presenceReady && !activeCollaborators.some(person => person.id !== currentUserId) && <p className="ide-collaboration-notice">
            You’re the only person here. Others will appear when they join the workspace.
          </p>}
        </div>
      </div>
    </aside>
  );
};
