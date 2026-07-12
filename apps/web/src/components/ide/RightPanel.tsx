import React, { useRef, useEffect } from 'react';
import { MessageSquare, Users } from 'lucide-react';

const getColor = (id: string) => {
  const colors = ['#556B5D','#70806e','#8f9e8b','#a99f8c','#5d6b70','#7f8e94','#5c6454','#58705c'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h % colors.length)];
};

interface RightPanelProps {
  collapsed: boolean;
  chatMessages: any[];
  typingUsers: { userId: string; name: string }[];
  chatInput: string;
  onChatInputChange: (val: string) => void;
  onSendMessage: (msg: string) => void;
  activeCollaborators: { id: string; name: string; email: string }[];
  currentUserId: string;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  collapsed, chatMessages, typingUsers, chatInput,
  onChatInputChange, onSendMessage, activeCollaborators, currentUserId
}) => {
  const [activeTab, setActiveTab] = React.useState<'chat' | 'users'>('chat');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  if (collapsed) return null;

  return (
    <div className={`ide-right-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="ide-right-tabs">
        <button className={`ide-right-tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}>
          <MessageSquare size={12} /> Chat
        </button>
        <button className={`ide-right-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
          <Users size={12} /> Online ({activeCollaborators.length})
        </button>
      </div>

      <div className="ide-right-body">
        {activeTab === 'chat' ? (
          <div className="ide-chat">
            <div className="ide-chat-messages">
              {chatMessages.map((msg, i) => (
                <div key={msg.id || i} className="ide-chat-msg">
                  <div className="ide-chat-msg-meta">
                    <span className="ide-chat-msg-author" style={{ color: getColor(msg.userId) }}>
                      {msg.user?.name || 'User'}
                    </span>
                    <span className="ide-chat-msg-time">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="ide-chat-msg-text">{msg.message}</div>
                </div>
              ))}
              {typingUsers.length > 0 && (
                <div className="ide-chat-typing">
                  {typingUsers.map(u => u.name).join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <form className="ide-chat-form" onSubmit={e => { e.preventDefault(); onSendMessage(chatInput); }}>
              <input
                className="ide-chat-input"
                placeholder="Type a message..."
                value={chatInput}
                onChange={e => onChatInputChange(e.target.value)}
              />
              <button type="submit" className="ide-btn primary">Send</button>
            </form>
          </div>
        ) : (
          <div>
            {activeCollaborators.map(c => (
              <div key={c.id} className="ide-online-user">
                <div className="ide-online-avatar" style={{ background: getColor(c.id) }}>
                  {c.name.charAt(0).toUpperCase()}
                  <span className="ide-online-dot" />
                </div>
                <div className="ide-online-info">
                  <span className="ide-online-name">
                    {c.name} {c.id === currentUserId && <span style={{ fontSize: 10, color: 'var(--ide-accent)' }}>(you)</span>}
                  </span>
                  <span className="ide-online-status">{c.email}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
