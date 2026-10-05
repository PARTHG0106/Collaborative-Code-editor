import React from 'react';
import { ArrowLeft, Users, Search, Maximize2, Minimize2 } from 'lucide-react';

interface TopBarProps {
  workspaceName: string;
  collaboratorCount: number;
  isConnected: boolean;
  presenceReady: boolean;
  userName: string;
  onBack: () => void;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
  unreadMessages?: number;
  onQuickOpen?: () => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  workspaceName, collaboratorCount, isConnected, presenceReady,
  userName, onBack, rightPanelOpen, onToggleRightPanel, unreadMessages = 0,
  onQuickOpen, focusMode, onToggleFocusMode
}) => {
  return (
    <div className="ide-topbar">
      <div className="ide-topbar-left">
        <button className="ide-topbar-btn" onClick={onBack} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <span className="ide-workspace-name">{workspaceName}</span>
      </div>

      <div className="ide-topbar-center">
        {onQuickOpen && <button className="ide-topbar-btn ide-quick-open-trigger" onClick={onQuickOpen} title="Open a file (Ctrl/Cmd+P)"><Search size={14} /> <span>Open a file</span><kbd>Ctrl/⌘ P</kbd></button>}
      </div>

      <div className="ide-topbar-right">
        <span className={`ide-connection-dot ${isConnected ? '' : 'offline'}`} title={isConnected ? 'Connected' : 'Reconnecting'} />
        <span className="ide-collab-count" aria-label={presenceReady ? `${collaboratorCount} online` : 'Online count unavailable'} title={presenceReady ? 'People online' : isConnected ? 'Loading online users' : 'Reconnecting'}>
          <Users size={12} />
          {presenceReady ? collaboratorCount : '—'}
        </span>
        {onToggleFocusMode && <button className="ide-topbar-btn" onClick={onToggleFocusMode} aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'} aria-pressed={focusMode} title={focusMode ? 'Exit focus mode' : 'Focus mode: hide side panels'}>{focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
        <button className="ide-topbar-btn" onClick={onToggleRightPanel} aria-expanded={rightPanelOpen} title="Toggle collaboration panel">
          {rightPanelOpen ? 'Hide Panel' : 'Show Panel'}
          {unreadMessages > 0 && <span className="ide-unread-count" aria-label={`${unreadMessages} unread messages`}>{unreadMessages > 99 ? '99+' : unreadMessages}</span>}
        </button>
        <div className="ide-user-avatar" title={userName}>
          {userName.charAt(0).toUpperCase()}
        </div>
      </div>
    </div>
  );
};
