import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { 
  ArrowLeft, Users, Shield, ShieldAlert, ShieldCheck, UserPlus, 
  Trash2, LogOut, Check, X, Edit2, Loader2, Mail, Calendar 
} from 'lucide-react';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  joinedAt: string;
}

interface WorkspaceDetails {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  currentUserRole: 'OWNER' | 'EDITOR' | 'VIEWER';
  members: Member[];
}

interface WorkspaceDetailProps {
  workspaceId: string;
  onBack: () => void;
  onWorkspaceDeleted: () => void;
}

export const WorkspaceDetail: React.FC<WorkspaceDetailProps> = ({ 
  workspaceId, 
  onBack,
  onWorkspaceDeleted 
}) => {
  const { apiClient, user } = useAuth();
  
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Workspace settings editing
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Invite member form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER');

  // Fetch workspace details
  const fetchWorkspaceDetails = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.get(`/workspaces/${workspaceId}`);
      if (res.data && res.data.success) {
        setWorkspace(res.data.data);
        setEditName(res.data.data.name);
        setEditDesc(res.data.data.description || '');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to load workspace details');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, apiClient]);

  useEffect(() => {
    fetchWorkspaceDetails();
  }, [fetchWorkspaceDetails]);

  // Handle auto-clearing success messages
  useEffect(() => {
    if (successMsg) {
      const timer = setTimeout(() => setSuccessMsg(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [successMsg]);

  if (loading) {
    return (
      <div className="workspace-loading glass-card">
        <Loader2 className="animate-spin text-purple-500" size={32} />
        <p>Loading workspace environments...</p>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div className="workspace-error glass-card">
        <X size={48} className="text-red-500 mb-2" />
        <h2 className="text-xl font-bold">Error Loading Workspace</h2>
        <p className="text-gray-400 mb-4">{error}</p>
        <button className="btn btn-secondary btn-icon" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back to Dashboard</span>
        </button>
      </div>
    );
  }

  if (!workspace) return null;

  const userRole = workspace.currentUserRole;
  const isOwner = userRole === 'OWNER';
  const isEditor = userRole === 'EDITOR';
  const canModifySettings = isOwner || isEditor;

  // Save workspace updates
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}`, {
        name: editName,
        description: editDesc,
      });
      if (res.data && res.data.success) {
        setWorkspace(prev => prev ? { 
          ...prev, 
          name: res.data.data.name, 
          description: res.data.data.description 
        } : null);
        setIsEditing(false);
        setSuccessMsg('Workspace settings updated successfully');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to update workspace');
    } finally {
      setActionLoading(false);
    }
  };

  // Invite member
  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/members`, {
        email: inviteEmail,
        role: inviteRole,
      });
      if (res.data && res.data.success) {
        setWorkspace(prev => prev ? {
          ...prev,
          members: [...prev.members, res.data.data]
        } : null);
        setInviteEmail('');
        setSuccessMsg(`Successfully invited ${inviteEmail}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to invite member');
    } finally {
      setActionLoading(false);
    }
  };

  // Change member role
  const handleRoleChange = async (targetUserId: string, newRole: 'EDITOR' | 'VIEWER') => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/members/${targetUserId}`, {
        role: newRole,
      });
      if (res.data && res.data.success) {
        setWorkspace(prev => prev ? {
          ...prev,
          members: prev.members.map(m => m.userId === targetUserId ? { ...m, role: res.data.data.role } : m)
        } : null);
        setSuccessMsg('Member permission level updated');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to change role');
    } finally {
      setActionLoading(false);
    }
  };

  // Remove member or Leave Workspace
  const handleRemoveMember = async (targetUserId: string) => {
    const isSelf = targetUserId === user?.id;
    const confirmMessage = isSelf 
      ? 'Are you sure you want to leave this workspace? You will lose access to its files.'
      : 'Are you sure you want to remove this member?';
    
    if (!window.confirm(confirmMessage)) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.delete(`/workspaces/${workspaceId}/members/${targetUserId}`);
      if (res.data && res.data.success) {
        if (isSelf) {
          onBack(); // Return to dashboard since we left
        } else {
          setWorkspace(prev => prev ? {
            ...prev,
            members: prev.members.filter(m => m.userId !== targetUserId)
          } : null);
          setSuccessMsg('Member removed successfully');
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to remove member');
    } finally {
      setActionLoading(false);
    }
  };

  // Delete workspace
  const handleDeleteWorkspace = async () => {
    if (!window.confirm('CRITICAL: Are you sure you want to delete this workspace? This will permanently erase the workspace and ALL of its files. This action cannot be undone.')) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.delete(`/workspaces/${workspaceId}`);
      if (res.data && res.data.success) {
        onWorkspaceDeleted();
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to delete workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const getRoleIcon = (role: 'OWNER' | 'EDITOR' | 'VIEWER') => {
    switch (role) {
      case 'OWNER': return <ShieldCheck className="text-purple-400" size={16} />;
      case 'EDITOR': return <Shield className="text-blue-400" size={16} />;
      case 'VIEWER': return <ShieldAlert className="text-gray-400" size={16} />;
    }
  };

  return (
    <div className="workspace-detail-container">
      {/* Alert Overlays */}
      {error && (
        <div className="alert alert-danger glass-card">
          <X className="alert-close" onClick={() => setError(null)} size={16} />
          <span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="alert alert-success glass-card">
          <span>{successMsg}</span>
        </div>
      )}

      {/* Workspace Sub-Header */}
      <div className="workspace-detail-header glass-card">
        <button className="btn btn-secondary btn-icon" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Workspaces</span>
        </button>

        <div className="workspace-meta-actions">
          {isOwner && (
            <button className="btn btn-danger btn-icon" onClick={handleDeleteWorkspace} disabled={actionLoading}>
              <Trash2 size={16} />
              <span>Delete Workspace</span>
            </button>
          )}
          {!isOwner && (
            <button className="btn btn-secondary btn-icon text-red-400" onClick={() => handleRemoveMember(user!.id)} disabled={actionLoading}>
              <LogOut size={16} />
              <span>Leave Workspace</span>
            </button>
          )}
        </div>
      </div>

      <div className="workspace-detail-layout">
        {/* Left Side: Detail & Workspace Info */}
        <section className="workspace-info-card glass-card">
          {isEditing ? (
            <form onSubmit={handleSaveSettings} className="edit-workspace-form">
              <div className="form-group">
                <label htmlFor="editName">Workspace Name</label>
                <input 
                  id="editName"
                  type="text" 
                  value={editName} 
                  onChange={e => setEditName(e.target.value)} 
                  required 
                />
              </div>
              <div className="form-group">
                <label htmlFor="editDesc">Description</label>
                <textarea 
                  id="editDesc"
                  value={editDesc} 
                  onChange={e => setEditDesc(e.target.value)} 
                  rows={4}
                />
              </div>
              <div className="form-actions-inline">
                <button type="submit" className="btn btn-primary btn-icon" disabled={actionLoading}>
                  <Check size={16} />
                  <span>Save</span>
                </button>
                <button type="button" className="btn btn-secondary btn-icon" onClick={() => setIsEditing(false)}>
                  <X size={16} />
                  <span>Cancel</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="workspace-view-content">
              <div className="title-area">
                <h1 className="workspace-title gradient-text">{workspace.name}</h1>
                {canModifySettings && (
                  <button className="edit-btn" onClick={() => setIsEditing(true)}>
                    <Edit2 size={16} />
                  </button>
                )}
              </div>
              <p className="workspace-desc">
                {workspace.description || 'No description provided for this collaborative workspace.'}
              </p>
              
              <div className="metadata-list">
                <div className="meta-item">
                  <Calendar size={16} />
                  <span>Created: {new Date(workspace.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="meta-item">
                  <ShieldCheck size={16} />
                  <span>Your Access: <strong className="role-label">{workspace.currentUserRole}</strong></span>
                </div>
              </div>

              {/* Placeholder Editor/Files Card */}
              <div className="files-editor-preview">
                <div className="coming-soon-badge">Phase 4 Ready</div>
                <h3>Workspace Code Editor</h3>
                <p>File system explorer and real-time Monaco editor integrations will render in this area during the next milestones.</p>
              </div>
            </div>
          )}
        </section>

        {/* Right Side: Members & Access controls */}
        <section className="workspace-members-card glass-card">
          <div className="panel-title-area">
            <Users size={20} className="card-icon" />
            <h2>Collaborators ({workspace.members.length})</h2>
          </div>

          {/* Invite form (only for OWNER/EDITOR) */}
          {canModifySettings && (
            <form onSubmit={handleInviteMember} className="invite-member-form">
              <h3>Invite Member</h3>
              <div className="invite-input-row">
                <div className="input-with-icon flex-1">
                  <Mail size={16} className="input-icon" />
                  <input 
                    type="email" 
                    placeholder="User email address" 
                    value={inviteEmail} 
                    onChange={e => setInviteEmail(e.target.value)} 
                    required 
                  />
                </div>
                <select 
                  value={inviteRole} 
                  onChange={e => setInviteRole(e.target.value as any)}
                  className="role-select-invite"
                >
                  <option value="EDITOR">Editor</option>
                  <option value="VIEWER">Viewer</option>
                </select>
                <button type="submit" className="btn btn-primary btn-icon" disabled={actionLoading}>
                  <UserPlus size={16} />
                  <span>Invite</span>
                </button>
              </div>
            </form>
          )}

          {/* Members list */}
          <div className="members-list">
            {workspace.members.map((member) => {
              const isTargetSelf = member.userId === user?.id;
              const isTargetOwner = member.role === 'OWNER';

              return (
                <div key={member.userId} className={`member-row ${isTargetSelf ? 'self-member' : ''}`}>
                  <div className="member-avatar">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  
                  <div className="member-info">
                    <div className="name-row">
                      <span className="member-name">{member.name}</span>
                      {isTargetSelf && <span className="self-badge">You</span>}
                    </div>
                    <span className="member-email">{member.email}</span>
                  </div>

                  <div className="member-role-area">
                    {/* Only OWNER can change roles, and OWNER's role cannot be edited */}
                    {isOwner && !isTargetOwner && !isTargetSelf ? (
                      <select 
                        value={member.role}
                        onChange={(e) => handleRoleChange(member.userId, e.target.value as any)}
                        disabled={actionLoading}
                        className="role-dropdown"
                      >
                        <option value="EDITOR">Editor</option>
                        <option value="VIEWER">Viewer</option>
                      </select>
                    ) : (
                      <div className="member-role-badge">
                        {getRoleIcon(member.role)}
                        <span>{member.role}</span>
                      </div>
                    )}

                    {/* OWNER can remove anyone (except self). Anyone can leave (self remove) */}
                    {((isOwner && !isTargetOwner) || isTargetSelf) && (
                      <button 
                        className="remove-member-btn" 
                        onClick={() => handleRemoveMember(member.userId)}
                        disabled={actionLoading}
                        title={isTargetSelf ? "Leave Workspace" : "Remove member"}
                      >
                        {isTargetSelf ? <LogOut size={14} /> : <Trash2 size={14} />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};
