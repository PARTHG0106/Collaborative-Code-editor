import React, { useState } from 'react';
import { UserPlus, Trash2, LogOut, Shield, ShieldCheck, ShieldAlert } from 'lucide-react';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  joinedAt: string;
}

interface CollaboratorsPanelProps {
  members: Member[];
  currentUserId: string;
  currentUserRole: string;
  activeCollaborators: { id: string; name: string; email: string }[];
  canModify: boolean;
  onInvite: (email: string, role: 'EDITOR' | 'VIEWER') => void;
  onChangeRole: (userId: string, role: 'EDITOR' | 'VIEWER') => void;
  onRemoveMember: (userId: string) => void;
}

const getColor = (id: string) => {
  const colors = ['#556B5D','#70806e','#8f9e8b','#a99f8c','#5d6b70','#7f8e94','#5c6454','#58705c'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h % colors.length)];
};

export const CollaboratorsPanel: React.FC<CollaboratorsPanelProps> = ({
  members, currentUserId, currentUserRole, activeCollaborators, canModify,
  onInvite, onChangeRole, onRemoveMember
}) => {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('EDITOR');
  const isOwner = currentUserRole === 'OWNER';
  const onlineIds = new Set(activeCollaborators.map(c => c.id));

  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Collaborators ({members.length})</span>
      </div>
      {canModify && (
        <form className="ide-invite-form" onSubmit={e => { e.preventDefault(); if (email.trim()) { onInvite(email.trim(), role); setEmail(''); } }}>
          <div className="ide-invite-row">
            <input className="ide-input" type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
            <select className="ide-select" value={role} onChange={e => setRole(e.target.value as any)}>
              <option value="EDITOR">Editor</option>
              <option value="VIEWER">Viewer</option>
            </select>
          </div>
          <button type="submit" className="ide-btn primary" style={{ width: '100%' }}>
            <UserPlus size={12} /> Invite
          </button>
        </form>
      )}
      <div className="ide-sidebar-body">
        {members.map(m => (
          <div key={m.userId} className="ide-member-row">
            <div className="ide-online-avatar" style={{ background: getColor(m.userId) }}>
              {m.name.charAt(0).toUpperCase()}
              {onlineIds.has(m.userId) && <span className="ide-online-dot" />}
            </div>
            <div className="ide-member-info">
              <span className="ide-member-name">
                {m.name} {m.userId === currentUserId && <span style={{ fontSize: 10, color: 'var(--ide-accent)' }}>(you)</span>}
              </span>
              <span className="ide-member-email">{m.email}</span>
            </div>
            {isOwner && m.role !== 'OWNER' && m.userId !== currentUserId ? (
              <select className="ide-select" value={m.role} onChange={e => onChangeRole(m.userId, e.target.value as any)} style={{ fontSize: 10, padding: '2px 4px' }}>
                <option value="EDITOR">Editor</option>
                <option value="VIEWER">Viewer</option>
              </select>
            ) : (
              <span className="ide-member-role-badge">{m.role}</span>
            )}
            {((isOwner && m.role !== 'OWNER') || m.userId === currentUserId) && (
              <button className="ide-icon-btn danger" title={m.userId === currentUserId ? 'Leave' : 'Remove'} onClick={() => onRemoveMember(m.userId)}>
                {m.userId === currentUserId ? <LogOut size={12} /> : <Trash2 size={12} />}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
};
