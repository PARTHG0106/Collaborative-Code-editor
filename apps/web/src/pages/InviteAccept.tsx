import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth, apiClient } from '../context/AuthContext.js';
import { useWorkspaces } from '../context/WorkspaceContext.js';
import { Loader2, ShieldCheck, Check, X, ShieldAlert } from 'lucide-react';

export default function InviteAccept() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { fetchWorkspaces } = useWorkspaces();

  const [checking, setChecking] = useState(true);
  const [invitation, setInvitation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Check token details
  useEffect(() => {
    if (authLoading) return;

    if (!token) {
      setError('Invalid invitation link: Missing token.');
      setChecking(false);
      return;
    }

    if (!user) {
      // Redirect to login, maintaining redirection context
      const redirectPath = encodeURIComponent(`/invite/accept?token=${token}`);
      navigate(`/login?redirect=${redirectPath}`);
      return;
    }

    const checkInvite = async () => {
      try {
        const response = await apiClient.get(`/workspaces/invitations/check/${token}`);
        if (response.data && response.data.success) {
          setInvitation(response.data.data);
        } else {
          setError('Invitation could not be resolved.');
        }
      } catch (err: any) {
        setError(err.response?.data?.error?.message || 'This invitation is invalid, expired, or has already been accepted.');
      } finally {
        setChecking(false);
      }
    };

    checkInvite();
  }, [token, user, authLoading, navigate]);

  const handleAccept = async () => {
    if (!token) return;
    setActionLoading(true);
    setError(null);
    try {
      const response = await apiClient.post(`/workspaces/invitations/check/${token}/accept`);
      if (response.data && response.data.success) {
        // Refetch workspaces list to include the newly joined workspace
        await fetchWorkspaces();
        // Redirect to dashboard
        navigate('/dashboard');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to accept invitation.');
      setActionLoading(false);
    }
  };

  const handleDecline = async () => {
    if (!token) return;
    setActionLoading(true);
    setError(null);
    try {
      await apiClient.post(`/workspaces/invitations/check/${token}/decline`);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to decline invitation.');
      setActionLoading(false);
    }
  };

  if (authLoading || checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={32} className="animate-spin text-zinc-400" />
          <p className="text-sm text-zinc-400 font-medium">Validating invitation...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-12 text-zinc-100">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl animate-in fade-in-50 zoom-in-95 duration-200 text-center">
        {error ? (
          <div className="space-y-4">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20 text-red-500">
              <ShieldAlert size={24} />
            </div>
            <h2 className="text-xl font-bold text-zinc-200">Unable to Join Workspace</h2>
            <p className="text-sm text-zinc-400">{error}</p>
            <button
              onClick={() => navigate('/dashboard')}
              className="mt-4 w-full rounded-lg bg-zinc-100 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-zinc-200 transition-colors"
            >
              Go to Dashboard
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-zinc-900 border border-zinc-800 text-zinc-200">
              <ShieldCheck size={28} />
            </div>

            <div className="space-y-2">
              <h2 className="text-2xl font-bold tracking-tight text-zinc-100">Workspace Invitation</h2>
              <p className="text-sm text-zinc-400">
                You have been invited to join <span className="font-semibold text-zinc-200">{invitation?.workspaceName}</span> as an{' '}
                <span className="font-semibold text-zinc-200 capitalize">{invitation?.role.toLowerCase()}</span>.
              </p>
            </div>

            <div className="rounded-lg bg-zinc-900/40 border border-zinc-900 p-4 text-left text-xs space-y-1.5 text-zinc-400">
              <p>• Account: <span className="text-zinc-300 font-medium">{user?.email}</span></p>
              <p>• Invited by: <span className="text-zinc-300 font-medium">{invitation?.invitedBy.name}</span></p>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={handleDecline}
                disabled={actionLoading}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 hover:bg-zinc-900 py-2.5 text-sm font-semibold text-zinc-300 transition-colors disabled:opacity-50"
              >
                <X size={16} />
                Decline
              </button>
              <button
                onClick={handleAccept}
                disabled={actionLoading}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 py-2.5 text-sm font-semibold text-zinc-900 transition-colors disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Check size={16} />
                )}
                Accept & Join
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
