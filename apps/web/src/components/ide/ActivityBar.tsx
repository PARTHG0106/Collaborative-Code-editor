import React from 'react';
import {
  FolderTree, Search, Users, History, Settings, Sun, Moon,
  ArrowLeft, MessageSquare, PanelRightClose, PanelRightOpen
} from 'lucide-react';
import { useTheme } from './IDEThemeProvider';
import './IDELayout.css';

export type ActivityType = 'explorer' | 'search' | 'collaborators' | 'snapshots' | 'settings';

interface ActivityBarProps {
  active: ActivityType;
  onSelect: (a: ActivityType) => void;
  sidebarVisible: boolean;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({ active, onSelect, sidebarVisible }) => {
  const { theme, toggleTheme } = useTheme();

  const items: { id: ActivityType; icon: React.ReactNode; label: string }[] = [
    { id: 'explorer', icon: <FolderTree size={20} />, label: 'Explorer' },
    { id: 'search', icon: <Search size={20} />, label: 'Search' },
    { id: 'collaborators', icon: <Users size={20} />, label: 'Collaborators' },
    { id: 'snapshots', icon: <History size={20} />, label: 'Snapshots' },
    { id: 'settings', icon: <Settings size={20} />, label: 'Settings' },
  ];

  return (
    <div className="ide-activity-bar">
      <div className="ide-activity-bar-top">
        {items.map(item => (
          <button
            key={item.id}
            className={`ide-activity-btn ${active === item.id && sidebarVisible ? 'active' : ''}`}
            title={item.label}
            aria-label={item.label}
            aria-pressed={active === item.id && sidebarVisible}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <div className="ide-activity-bar-bottom">
        <button
          type="button"
          className="ide-activity-btn"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
};
