import React, { useState } from 'react';
import { Edit2, Check, X, Trash2, LogOut } from 'lucide-react';

interface SettingsPanelProps {
  workspace: { id: string; name: string; description: string | null; createdAt: string; currentUserRole: string };
  isOwner: boolean;
  canModify: boolean;
  onSave: (name: string, desc: string) => void;
  onDelete: () => void;
  onLeave: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  workspace, isOwner, canModify, onSave, onDelete, onLeave
}) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [desc, setDesc] = useState(workspace.description || '');

  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Settings</span>
      </div>
      <div className="ide-settings-panel ide-sidebar-body">
        <div className="ide-settings-group">
          <span className="ide-settings-label">Workspace Name</span>
          {editing ? (
            <input className="ide-input" value={name} onChange={e => setName(e.target.value)} />
          ) : (
            <span className="ide-settings-value">{workspace.name}</span>
          )}
        </div>
        <div className="ide-settings-group">
          <span className="ide-settings-label">Description</span>
          {editing ? (
            <textarea className="ide-input" value={desc} onChange={e => setDesc(e.target.value)} rows={3} style={{ resize: 'vertical' }} />
          ) : (
            <span className="ide-settings-value">{workspace.description || 'No description'}</span>
          )}
        </div>
        <div className="ide-settings-group">
          <span className="ide-settings-label">Created</span>
          <span className="ide-settings-value">{new Date(workspace.createdAt).toLocaleDateString()}</span>
        </div>
        <div className="ide-settings-group">
          <span className="ide-settings-label">Your Role</span>
          <span className="ide-settings-value" style={{ textTransform: 'capitalize' }}>{workspace.currentUserRole.toLowerCase()}</span>
        </div>

        {canModify && (
          <div style={{ display: 'flex', gap: 6 }}>
            {editing ? (
              <>
                <button className="ide-btn primary" onClick={() => { onSave(name, desc); setEditing(false); }}>
                  <Check size={12} /> Save
                </button>
                <button className="ide-btn" onClick={() => setEditing(false)}>
                  <X size={12} /> Cancel
                </button>
              </>
            ) : (
              <button className="ide-btn" onClick={() => setEditing(true)}>
                <Edit2 size={12} /> Edit
              </button>
            )}
          </div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isOwner ? (
            <button className="ide-btn danger" onClick={onDelete} style={{ width: '100%' }}>
              <Trash2 size={12} /> Delete Workspace
            </button>
          ) : (
            <button className="ide-btn danger" onClick={onLeave} style={{ width: '100%' }}>
              <LogOut size={12} /> Leave Workspace
            </button>
          )}
        </div>
      </div>
    </>
  );
};
