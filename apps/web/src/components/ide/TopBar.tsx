import React from 'react';
import { ArrowLeft, Users, Share2 } from 'lucide-react';
import { useTheme } from './IDEThemeProvider';

interface TopBarProps {
  workspaceName: string;
  collaboratorCount: number;
  isConnected: boolean;
  userName: string;
  onBack: () => void;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  workspaceName, collaboratorCount, isConnected,
  userName, onBack, rightPanelOpen, onToggleRightPanel
}) => {
  return (
    <div className="ide-topbar">
      <div className="ide-topbar-left">
        <button className="ide-topbar-btn" onClick={onBack} title="Back to Dashboard">
          <ArrowLeft size={16} />
        </button>
        <span className="ide-workspace-name">{workspaceName}</span>
      </div>

      <div className="ide-topbar-center" />

      <div className="ide-topbar-right">
        <span className={`ide-connection-dot ${isConnected ? '' : 'offline'}`} />
        <span className="ide-collab-count">
          <Users size={12} />
          {collaboratorCount}
        </span>
        <button className="ide-topbar-btn" onClick={onToggleRightPanel} title="Toggle collaboration panel">
          {rightPanelOpen ? 'Hide Panel' : 'Show Panel'}
        </button>
        <div className="ide-user-avatar" title={userName}>
          {userName.charAt(0).toUpperCase()}
        </div>
      </div>
    </div>
  );
};
