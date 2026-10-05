import React, { useId, useRef, useState } from 'react';
import { UserPlus, Trash2, LogOut } from 'lucide-react';
import '../collaboration.css';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  joinedAt: string;
}

type MemberActionResult = void | boolean | Promise<void | boolean>;

interface CollaboratorsPanelProps {
  members: Member[];
  currentUserId: string;
  currentUserRole: string;
  activeCollaborators: { id: string; name: string; email: string }[];
  presenceReady: boolean;
  canModify: boolean;
  onInvite: (email: string, role: 'EDITOR' | 'VIEWER') => MemberActionResult;
  onChangeRole: (userId: string, role: 'EDITOR' | 'VIEWER') => MemberActionResult;
  onRemoveMember: (userId: string) => MemberActionResult;
}

const getColor = (id: string) => {
  const colors = ['#556B5D','#70806e','#8f9e8b','#a99f8c','#5d6b70','#7f8e94','#5c6454','#58705c'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h % colors.length)];
};

export const CollaboratorsPanel: React.FC<CollaboratorsPanelProps> = ({
  members, currentUserId, currentUserRole, activeCollaborators, presenceReady, canModify,
  onInvite, onChangeRole, onRemoveMember
}) => {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('EDITOR');
  const [inviting, setInviting] = useState(false);
  const invitingRef = useRef(false);
  const [pendingMembers, setPendingMembers] = useState<Set<string>>(new Set());
  const pendingMembersRef = useRef(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);
  const roleHelpId = useId();
  const isOwner = currentUserRole === 'OWNER';
  const onlineIds = new Set(presenceReady ? activeCollaborators.map(c => c.id) : []);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (invitingRef.current || !email.trim()) return;
    setActionError(null);
    invitingRef.current = true;
    setInviting(true);
    try {
      const result = await onInvite(email.trim(), role);
      if (result !== false) setEmail('');
    } catch {
      setActionError('Could not invite this person. Your email is still here; try again.');
    } finally {
      invitingRef.current = false;
      setInviting(false);
    }
  };

  const runMemberAction = async (userId: string, action: () => MemberActionResult) => {
    if (pendingMembersRef.current.has(userId)) return;
    setActionError(null);
    pendingMembersRef.current.add(userId);
    setPendingMembers(new Set(pendingMembersRef.current));
    try {
      await action();
    } catch {
      setActionError('Could not update this member. Please try again.');
    } finally {
      pendingMembersRef.current.delete(userId);
      setPendingMembers(new Set(pendingMembersRef.current));
    }
  };

  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Collaborators ({members.length})</span>
      </div>
      {canModify && (
        <form className="ide-invite-form" onSubmit={invite} aria-busy={inviting}>
          <div className="ide-invite-row">
            <input className="ide-input" type="email" aria-label="Collaborator email" placeholder="Email address" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} disabled={inviting} required />
            <select className="ide-select" aria-label="Invitation role" aria-describedby={roleHelpId} value={role} disabled={inviting} onChange={e => setRole(e.target.value as 'EDITOR' | 'VIEWER')}>
              <option value="EDITOR">Editor</option>
              <option value="VIEWER">Viewer</option>
            </select>
          </div>
          <p id={roleHelpId} className="ide-collaboration-role-help">{role === 'EDITOR' ? 'Editors can edit files and invite collaborators.' : 'Viewers can read files and participate in chat.'}</p>
          <button type="submit" className="ide-btn primary" style={{ width: '100%' }} disabled={inviting || !email.trim()}>
            <UserPlus size={12} aria-hidden="true" /> {inviting ? 'Inviting…' : 'Invite'}
          </button>
        </form>
      )}
      <div className="ide-sidebar-body">
        {actionError && <p className="ide-collaboration-notice ide-collaboration-error" role="alert">{actionError}</p>}
        {!presenceReady && <p className="ide-collaboration-notice" role="status">Online status is temporarily unavailable.</p>}
        {presenceReady && <p className="ide-collaboration-notice">{members.filter(member => onlineIds.has(member.userId)).length} of {members.length} {members.length === 1 ? 'member' : 'members'} online</p>}
        {members.map(m => (
          <div key={m.userId} className="ide-member-row" aria-busy={pendingMembers.has(m.userId)}>
            <div className="ide-online-avatar" style={{ background: getColor(m.userId) }} aria-hidden="true">
              {m.name.trim().charAt(0).toUpperCase() || '?'}
              {onlineIds.has(m.userId) && <span className="ide-online-dot" />}
            </div>
            <div className="ide-member-info">
              <span className="ide-member-name">
                {m.name} {m.userId === currentUserId && <span className="ide-collaboration-you">(you)</span>}
              </span>
              <span className="ide-member-email" title={m.email}>{m.email}</span>
              <span className="ide-member-presence">{!presenceReady ? 'Status unavailable' : onlineIds.has(m.userId) ? 'Online' : 'Offline'}</span>
            </div>
            {isOwner && m.role !== 'OWNER' && m.userId !== currentUserId ? (
              <select className="ide-select" aria-label={`Role for ${m.name}`} value={m.role} disabled={pendingMembers.has(m.userId)} onChange={e => { const nextRole = e.target.value as 'EDITOR' | 'VIEWER'; void runMemberAction(m.userId, () => onChangeRole(m.userId, nextRole)); }} style={{ fontSize: 10, padding: '2px 4px' }}>
                <option value="EDITOR">Editor</option>
                <option value="VIEWER">Viewer</option>
              </select>
            ) : (
              <span className="ide-member-role-badge">{m.role}</span>
            )}
            {m.role !== 'OWNER' && (isOwner || m.userId === currentUserId) && (
              <button type="button" className="ide-icon-btn danger" aria-label={m.userId === currentUserId ? 'Leave workspace' : `Remove ${m.name}`} title={m.userId === currentUserId ? 'Leave workspace' : `Remove ${m.name}`} disabled={pendingMembers.has(m.userId)} onClick={() => { void runMemberAction(m.userId, () => onRemoveMember(m.userId)); }}>
                {m.userId === currentUserId ? <LogOut size={12} aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
};
