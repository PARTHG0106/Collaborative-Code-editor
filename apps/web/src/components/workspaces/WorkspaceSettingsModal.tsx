import React, { useState, useEffect } from 'react';
import { useWorkspaces, WorkspaceMember, WorkspaceInvitation } from '../../context/WorkspaceContext.js';
import { useAuth } from '../../context/AuthContext.js';
import { InviteMemberModal } from './InviteMemberModal.js';
import { X, Users, Settings as SettingsIcon, Trash2, ShieldAlert, ShieldCheck, Mail, LogOut, Check, UserMinus } from 'lucide-react';

interface WorkspaceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WorkspaceSettingsModal: React.FC<WorkspaceSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { user } = useAuth();
  const {
    currentWorkspace,
    fetchWorkspaceDetails,
    updateWorkspace,
    deleteWorkspace,
    updateMemberRole,
    removeMember,
    cancelInvitation,
  } = useWorkspaces();

  const [activeTab, setActiveTab] = useState<'general' | 'members'>('members');
  const [wsName, setWsName] = useState('');
  const [wsDesc, setWsDesc] = useState('');
  const [updating, setUpdating] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [memberLoading, setMemberLoading] = useState<string | null>(null);

  // Synchronize state with current selected workspace
  useEffect(() => {
    if (currentWorkspace) {
      setWsName(currentWorkspace.name);
      setWsDesc(currentWorkspace.description || '');
      // Fetch fresh details with members & invites loaded
      fetchWorkspaceDetails(currentWorkspace.id).catch(() => {});
    }
  }, [currentWorkspace?.id]);

  if (!isOpen || !currentWorkspace) return null;

  const userRole = currentWorkspace.role;
  const isOwner = userRole === 'OWNER';
  const isEditor = userRole === 'EDITOR';
  const canManageMembers = isOwner || isEditor;

  const handleUpdateDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner) return;

    setUpdating(true);
    setSuccessMsg(null);
    setErrorMsg(null);

    try {
      await updateWorkspace(currentWorkspace.id, wsName.trim(), wsDesc.trim() || null);
      setSuccessMsg('Workspace details updated successfully!');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update workspace details');
    } finally {
      setUpdating(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!window.confirm(`Are you absolutely sure you want to delete "${currentWorkspace.name}"? This action is irreversible.`)) {
      return;
    }

    try {
      await deleteWorkspace(currentWorkspace.id);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete workspace');
    }
  };

  const handleLeaveWorkspace = async () => {
    if (!window.confirm(`Are you sure you want to leave "${currentWorkspace.name}"?`)) {
      return;
    }

    const selfMember = currentWorkspace.members?.find((m) => m.userId === user?.id);
    if (!selfMember) return;

    try {
      await removeMember(currentWorkspace.id, selfMember.id);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to leave workspace');
    }
  };

  const handleRoleChange = async (memberId: string, newRole: 'OWNER' | 'EDITOR' | 'VIEWER') => {
    setMemberLoading(memberId);
    setErrorMsg(null);
    try {
      await updateMemberRole(currentWorkspace.id, memberId, newRole);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update member role');
    } finally {
      setMemberLoading(null);
    }
  };

  const handleRemoveMember = async (memberId: string, memberName: string) => {
    if (!window.confirm(`Are you sure you want to remove ${memberName} from this workspace?`)) {
      return;
    }

    setMemberLoading(memberId);
    setErrorMsg(null);
    try {
      await removeMember(currentWorkspace.id, memberId);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to remove member');
    } finally {
      setMemberLoading(null);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    setErrorMsg(null);
    try {
      await cancelInvitation(currentWorkspace.id, inviteId);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to cancel invitation');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl animate-in fade-in-50 zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-900 px-6 py-4">
          <div className="flex items-center gap-2">
            <SettingsIcon size={18} className="text-zinc-400" />
            <h3 className="text-lg font-semibold text-zinc-100">
              Workspace Settings: <span className="text-zinc-400 font-normal">{currentWorkspace.name}</span>
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-zinc-900 px-6">
          <button
            onClick={() => setActiveTab('members')}
            className={`flex items-center gap-2 border-b-2 py-3 text-sm font-medium transition-all mr-6 ${
              activeTab === 'members'
                ? 'border-zinc-200 text-zinc-200'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Users size={16} />
            Members & Invites
          </button>
          <button
            onClick={() => setActiveTab('general')}
            className={`flex items-center gap-2 border-b-2 py-3 text-sm font-medium transition-all ${
              activeTab === 'general'
                ? 'border-zinc-200 text-zinc-200'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <SettingsIcon size={16} />
            General Settings
          </button>
        </div>

        {/* Content (Scrollable) */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {errorMsg && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-sm text-emerald-400">
              {successMsg}
            </div>
          )}

          {activeTab === 'general' ? (
            <div className="space-y-6">
              {/* Form */}
              <form onSubmit={handleUpdateDetails} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="settings-name" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Workspace Name
                  </label>
                  <input
                    id="settings-name"
                    type="text"
                    required
                    disabled={!isOwner}
                    value={wsName}
                    onChange={(e) => setWsName(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900/30 py-2 px-3 text-sm text-zinc-100 focus:border-zinc-700 focus:outline-hidden focus:ring-1 focus:ring-zinc-700 transition-all disabled:opacity-60"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="settings-desc" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Description
                  </label>
                  <textarea
                    id="settings-desc"
                    disabled={!isOwner}
                    value={wsDesc}
                    onChange={(e) => setWsDesc(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900/30 py-2 px-3 text-sm text-zinc-100 focus:border-zinc-700 focus:outline-hidden focus:ring-1 focus:ring-zinc-700 transition-all resize-none disabled:opacity-60"
                  />
                </div>

                {isOwner && (
                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      disabled={updating || !wsName.trim()}
                      className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 transition-all disabled:opacity-50"
                    >
                      {updating ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                )}
              </form>

              {/* Danger Zone */}
              <div className="border-t border-zinc-900 pt-6">
                <h4 className="text-sm font-semibold text-red-500 flex items-center gap-1.5 mb-2">
                  <ShieldAlert size={16} /> Danger Zone
                </h4>
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h5 className="text-sm font-medium text-zinc-200">
                      {isOwner ? 'Delete this workspace' : 'Leave this workspace'}
                    </h5>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {isOwner
                        ? 'Deleting a workspace removes all files, history, and users permanently.'
                        : 'You will immediately lose read/write privileges and must request a new invite to rejoin.'}
                    </p>
                  </div>
                  {isOwner ? (
                    <button
                      onClick={handleDeleteWorkspace}
                      className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors self-start sm:self-center"
                    >
                      <Trash2 size={16} />
                      Delete Workspace
                    </button>
                  ) : (
                    <button
                      onClick={handleLeaveWorkspace}
                      className="flex items-center gap-1.5 rounded-lg border border-red-650 hover:bg-red-650/10 px-4 py-2 text-sm font-medium text-red-400 transition-colors self-start sm:self-center"
                    >
                      <LogOut size={16} />
                      Leave Workspace
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            // Members and Invites Tab
            <div className="space-y-6">
              
              {/* Active Members Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Members ({currentWorkspace.members?.length || 0})
                  </h4>
                  {canManageMembers && (
                    <button
                      onClick={() => setIsInviteOpen(true)}
                      className="rounded-lg bg-zinc-100 hover:bg-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-900 transition-colors"
                    >
                      Invite Teammate
                    </button>
                  )}
                </div>

                <div className="rounded-lg border border-zinc-900 bg-zinc-950 divide-y divide-zinc-900">
                  {currentWorkspace.members?.map((member) => {
                    const isSelf = member.userId === user?.id;
                    const memberIsOwner = member.role === 'OWNER';

                    return (
                      <div key={member.id} className="flex items-center justify-between p-3.5 text-sm">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-zinc-200 truncate">
                              {member.name} {isSelf && <span className="text-zinc-500 font-normal text-xs">(you)</span>}
                            </span>
                            {memberIsOwner && (
                              <span className="flex items-center gap-0.5 rounded-sm bg-zinc-800 px-1.5 py-0.5 text-xxs font-semibold text-zinc-300">
                                <ShieldCheck size={10} /> Owner
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-zinc-400 block mt-0.5">{member.email}</span>
                        </div>

                        <div className="flex items-center gap-3">
                          {isOwner && !isSelf ? (
                            <select
                              value={member.role}
                              disabled={memberLoading === member.id}
                              onChange={(e) => handleRoleChange(member.id, e.target.value as any)}
                              className="rounded-lg border border-zinc-800 bg-zinc-900/50 py-1.5 px-2.5 text-xs text-zinc-300 focus:outline-hidden"
                            >
                              <option value="OWNER">Owner</option>
                              <option value="EDITOR">Editor</option>
                              <option value="VIEWER">Viewer</option>
                            </select>
                          ) : (
                            <span className="text-xs text-zinc-500 capitalize">{member.role.toLowerCase()}</span>
                          )}

                          {isOwner && !isSelf && (
                            <button
                              onClick={() => handleRemoveMember(member.id, member.name)}
                              disabled={memberLoading === member.id}
                              className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-900 hover:text-red-400 transition-colors"
                              title="Remove member"
                            >
                              <UserMinus size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Pending Invitations Section */}
              {currentWorkspace.invitations && currentWorkspace.invitations.length > 0 && (
                <div className="space-y-3 pt-2">
                  <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Mail size={14} /> Pending Invitations
                  </h4>

                  <div className="rounded-lg border border-zinc-900 bg-zinc-950 divide-y divide-zinc-900">
                    {currentWorkspace.invitations
                      .filter((invite) => invite.status === 'PENDING')
                      .map((invite) => (
                        <div key={invite.id} className="flex items-center justify-between p-3.5 text-sm">
                          <div className="min-w-0">
                            <span className="font-medium text-zinc-300 block truncate">{invite.email}</span>
                            <span className="text-xxs text-zinc-500 block mt-0.5">
                              Invited by {invite.invitedBy.name} • Expires {new Date(invite.expiresAt).toLocaleDateString()}
                            </span>
                          </div>

                          <div className="flex items-center gap-3">
                            <span className="text-xs text-zinc-500">As {invite.role.toLowerCase()}</span>
                            {canManageMembers && (
                              <button
                                onClick={() => handleCancelInvite(invite.id)}
                                className="rounded-lg border border-zinc-800 hover:bg-zinc-900 px-3 py-1.5 text-xs text-red-400 transition-colors"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <InviteMemberModal
        workspaceId={currentWorkspace.id}
        isOpen={isInviteOpen}
        onClose={() => {
          setIsInviteOpen(false);
          // Refetch workspace details after inviting to update panel lists
          fetchWorkspaceDetails(currentWorkspace.id).catch(() => {});
        }}
      />
    </div>
  );
};
