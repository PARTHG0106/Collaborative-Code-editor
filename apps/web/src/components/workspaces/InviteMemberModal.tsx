import React, { useState } from 'react';
import { useWorkspaces } from '../../context/WorkspaceContext.js';
import { Mail, Shield, X, Loader2, Check, Copy } from 'lucide-react';

interface InviteMemberModalProps {
  workspaceId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const InviteMemberModal: React.FC<InviteMemberModalProps> = ({
  workspaceId,
  isOpen,
  onClose,
}) => {
  const { inviteMember } = useWorkspaces();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'EDITOR' | 'VIEWER'>('EDITOR');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError(null);
    setInviteLink(null);

    try {
      const invite = await inviteMember(workspaceId, email.trim(), role);
      // Construct local invitation link for developer testing convenience
      const host = window.location.origin;
      const link = `${host}/invite/accept?token=${invite.token}`;
      setInviteLink(link);
      setEmail('');
    } catch (err: any) {
      setError(err.message || 'Failed to send invitation');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl animate-in fade-in-50 zoom-in-95 duration-150">
        <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
          <h3 className="text-lg font-semibold text-zinc-100">Invite Team Member</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {inviteLink ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4 text-sm text-emerald-400">
              Invitation generated successfully! Since mock email sending is active, copy the registration/acceptance link below.
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Invitation Link
              </label>
              <div className="relative flex items-center">
                <input
                  type="text"
                  readOnly
                  value={inviteLink}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pl-3 pr-10 text-sm text-zinc-300 focus:outline-hidden"
                />
                <button
                  onClick={handleCopy}
                  className="absolute right-2 text-zinc-400 hover:text-zinc-200 p-1 rounded-md transition-colors"
                  title="Copy link"
                >
                  {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setInviteLink(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium bg-zinc-900 text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                Invite Another
              </button>
              <button
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium bg-zinc-100 text-zinc-900 hover:bg-zinc-200 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {error && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="invite-email" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Email Address
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                  <Mail size={16} />
                </div>
                <input
                  id="invite-email"
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pl-10 pr-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-700 focus:outline-hidden focus:ring-1 focus:ring-zinc-700 transition-all"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="invite-role" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Access Role
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                  <Shield size={16} />
                </div>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'EDITOR' | 'VIEWER')}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pl-10 pr-3 text-sm text-zinc-100 focus:border-zinc-700 focus:outline-hidden focus:ring-1 focus:ring-zinc-700 transition-all appearance-none"
                >
                  <option value="EDITOR" className="bg-zinc-950">Editor (Write Access)</option>
                  <option value="VIEWER" className="bg-zinc-950">Viewer (Read Only)</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-zinc-900 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium border border-zinc-800 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !email.trim()}
                className="flex items-center justify-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading && <Loader2 size={16} className="animate-spin" />}
                Send Invite
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
