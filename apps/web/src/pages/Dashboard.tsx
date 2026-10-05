import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { Link, useNavigate } from 'react-router-dom';
import './Dashboard.css';
import { 
  LogOut, FolderGit2, Code2,
  Plus, Users, ArrowRight,
  X, Loader2, Search, RefreshCw
} from 'lucide-react';

interface Workspace {
  id: string;
  name: string;
  description: string | null;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  memberCount: number;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
}

export const Dashboard: React.FC = () => {
  const { user, logout, apiClient } = useAuth();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Workspaces state
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [workspaceSearch, setWorkspaceSearch] = useState('');
  const [workspaceRole, setWorkspaceRole] = useState<'ALL' | Workspace['role']>('ALL');
  const [workspaceSort, setWorkspaceSort] = useState<'joined' | 'name' | 'created'>('joined');

  // Workspace creation modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceDesc, setNewWorkspaceDesc] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPendingRef = useRef(false);
  const createDialogRef = useRef<HTMLDivElement>(null);
  const createNameRef = useRef<HTMLInputElement>(null);
  const createTriggerRef = useRef<HTMLElement | null>(null);

  const visibleWorkspaces = useMemo(() => {
    const query = workspaceSearch.trim().toLocaleLowerCase();
    return workspaces.filter((workspace) => (
      (workspaceRole === 'ALL' || workspace.role === workspaceRole)
      && (!query || `${workspace.name} ${workspace.description || ''}`.toLocaleLowerCase().includes(query))
    )).sort((a, b) => {
      if (workspaceSort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
      const dateKey = workspaceSort === 'created' ? 'createdAt' : 'joinedAt';
      return (Date.parse(b[dateKey]) || 0) - (Date.parse(a[dateKey]) || 0);
    });
  }, [workspaces, workspaceSearch, workspaceRole, workspaceSort]);

  const openCreateModal = (event: React.MouseEvent<HTMLButtonElement>) => {
    createTriggerRef.current = event.currentTarget;
    setCreateError(null);
    setIsCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (!createPendingRef.current) setIsCreateModalOpen(false);
  };

  useEffect(() => {
    if (!isCreateModalOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    createNameRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!createPendingRef.current) setIsCreateModalOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = createDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
      );
      if (!focusable?.length) {
        event.preventDefault();
        createDialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === createDialogRef.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const keepFocusInDialog = (event: FocusEvent) => {
      if (!createDialogRef.current?.contains(event.target as Node)) {
        createDialogRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', keepFocusInDialog);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', keepFocusInDialog);
      if (createTriggerRef.current?.isConnected) createTriggerRef.current.focus();
    };
  }, [isCreateModalOpen]);

  // Fetch workspaces
  const fetchWorkspaces = useCallback(async () => {
    if (!user) return;
    try {
      setLoadingWorkspaces(true);
      setDashboardError(null);
      const res = await apiClient.get('/workspaces');
      if (!res?.data?.success || !Array.isArray(res.data.data)) throw new Error('Failed to fetch workspaces');
      setWorkspaces(res.data.data);
    } catch (err: any) {
      setDashboardError(err.response?.data?.error?.message || 'Failed to fetch workspaces');
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [user, apiClient]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
    } catch (err) {
      console.error('Logout failed:', err);
    } finally {
      setIsLoggingOut(false);
    }
  };

  // Create Workspace handler
  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWorkspaceName.trim() || createPendingRef.current) return;

    createPendingRef.current = true;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const res = await apiClient.post('/workspaces', {
        name: newWorkspaceName.trim(),
        description: newWorkspaceDesc.trim() || null,
      });

      if (res.data?.success && res.data.data?.id) {
        setWorkspaces((prev) => [res.data.data, ...prev]);
        setIsCreateModalOpen(false);
        setNewWorkspaceName('');
        setNewWorkspaceDesc('');
        // Navigate to the new workspace IDE
        navigate(`/workspace/${res.data.data.id}`);
      } else {
        setCreateError(res.data?.error?.message || 'Failed to create workspace. Please try again.');
      }
    } catch (err: any) {
      setCreateError(err.response?.data?.error?.message || 'Failed to create workspace. Please try again.');
    } finally {
      createPendingRef.current = false;
      setCreateLoading(false);
    }
  };

  if (!user) return null;

  return (
    <div className="workspace-page">
      <header className="site-header" aria-hidden={isCreateModalOpen || undefined}>
        <div className="site-container workspace-header-inner">
          <div className="workspace-header-location">
            <div className="site-brand"><Code2 size={21} aria-hidden="true" /><span>syncscript</span></div>
            <span className="workspace-breadcrumb-divider" aria-hidden="true">/</span>
            <span className="workspace-breadcrumb">Workspaces</span>
          </div>
          <div className="workspace-account">
            <div className="workspace-account-details">
              <span className="workspace-account-name">{user.name}</span>
              <span className="workspace-account-email">{user.email}</span>
            </div>
            <button className="site-button workspace-signout" onClick={handleLogout} disabled={isLoggingOut} aria-label={isLoggingOut ? 'Logging out' : 'Sign Out'}>
              <LogOut size={15} aria-hidden="true" />
              <span>{isLoggingOut ? 'Logging out...' : 'Sign Out'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="site-container workspace-main" aria-hidden={isCreateModalOpen || undefined}>
        <section aria-labelledby="workspaces-heading">
          <div className="workspace-heading-row">
            <div>
              <h1 id="workspaces-heading">Workspaces</h1>
              <p className="site-muted">Create a workspace or pick up where you left off.</p>
            </div>
            <button className="site-button site-button-primary workspace-create-button" onClick={openCreateModal}>
              <Plus size={16} aria-hidden="true" />
              <span>New Workspace</span>
            </button>
          </div>

          <div className="workspace-toolbar">
            <div className="workspace-search-field">
              <label htmlFor="workspace-search" className="workspace-sr-only">Search workspaces</label>
              <Search size={16} aria-hidden="true" />
              <input
                id="workspace-search"
                type="search"
                placeholder="Search workspaces..."
                value={workspaceSearch}
                onChange={(event) => setWorkspaceSearch(event.target.value)}
                className="site-input"
              />
            </div>
            <div className="workspace-select-field">
              <label htmlFor="workspace-role" className="workspace-sr-only">Your role</label>
              <select id="workspace-role" value={workspaceRole} onChange={(event) => setWorkspaceRole(event.target.value as typeof workspaceRole)} className="site-input">
                <option value="ALL">All roles</option>
                <option value="OWNER">Owner</option>
                <option value="EDITOR">Editor</option>
                <option value="VIEWER">Viewer</option>
              </select>
            </div>
            <div className="workspace-select-field workspace-sort-field">
              <label htmlFor="workspace-sort" className="workspace-sr-only">Sort by</label>
              <select id="workspace-sort" value={workspaceSort} onChange={(event) => setWorkspaceSort(event.target.value as typeof workspaceSort)} className="site-input">
                <option value="joined">Recently joined</option>
                <option value="name">Name A–Z</option>
                <option value="created">Newest created</option>
              </select>
            </div>
            <button type="button" className="site-button workspace-refresh" onClick={fetchWorkspaces} disabled={loadingWorkspaces} aria-label="Refresh workspaces" title="Refresh workspaces to see new invitations">
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>

          {dashboardError && (
            <div className="workspace-notice" role="alert">
              <span>{dashboardError}</span>
              <button type="button" className="site-button" onClick={fetchWorkspaces} disabled={loadingWorkspaces}>Try again</button>
            </div>
          )}

          {!loadingWorkspaces && !dashboardError && workspaces.length > 0 && (
            <p className="workspace-result-count" role="status">
              {visibleWorkspaces.length} of {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'}
            </p>
          )}
          {loadingWorkspaces && workspaces.length > 0 && <p className="workspace-result-count" role="status">Refreshing workspaces...</p>}

          {loadingWorkspaces && workspaces.length === 0 ? (
            <div className="workspace-empty" role="status">
              <Loader2 size={22} aria-hidden="true" />
              <p>Loading workspaces...</p>
            </div>
          ) : dashboardError && workspaces.length === 0 ? null : workspaces.length === 0 ? (
            <div className="workspace-empty">
              <FolderGit2 size={24} aria-hidden="true" />
              <h2>No Workspaces Yet</h2>
              <p>Create a workspace to begin coding, or have a teammate invite you by email.</p>
              <button className="site-button" onClick={openCreateModal}>
                <Plus size={16} aria-hidden="true" />
                <span>Create Workspace</span>
              </button>
            </div>
          ) : visibleWorkspaces.length === 0 ? (
            <div className="workspace-empty">
              <Search size={24} aria-hidden="true" />
              <h2>No matching workspaces</h2>
              <p>Try a different search or show all roles.</p>
              <button type="button" className="site-button" onClick={() => { setWorkspaceSearch(''); setWorkspaceRole('ALL'); }}>Clear filters</button>
            </div>
          ) : (
            <div className="workspace-list" aria-busy={loadingWorkspaces}>
              <div className="workspace-list-labels" aria-hidden="true">
                <span>Workspace</span><span>Your role</span><span>Members</span><span>Joined</span><span />
              </div>
              <ul>
                {visibleWorkspaces.map((ws) => {
                  const joinedDate = new Date(ws.joinedAt);
                  const hasJoinedDate = !Number.isNaN(joinedDate.getTime());
                  return (
                    <li key={ws.id}>
                      <Link
                        className="workspace-list-row"
                        to={`/workspace/${ws.id}`}
                        aria-labelledby={`workspace-name-${ws.id}`}
                        aria-describedby={`workspace-access-${ws.id}`}
                      >
                        <div className="workspace-list-project">
                          <span className="workspace-folder-icon"><FolderGit2 size={20} aria-hidden="true" /></span>
                          <div className="workspace-list-project-text">
                            <h2 id={`workspace-name-${ws.id}`}>{ws.name}</h2>
                            <p>{ws.description || 'No description provided.'}</p>
                          </div>
                        </div>
                        <span className="workspace-list-role"><span className="workspace-role-badge">{ws.role}</span></span>
                        <span className="workspace-list-members" title={`${ws.memberCount} ${ws.memberCount === 1 ? 'member' : 'members'}`}>
                          <Users size={14} aria-hidden="true" />
                          <span>{ws.memberCount}<span className="workspace-sr-only"> {ws.memberCount === 1 ? 'member' : 'members'}</span></span>
                        </span>
                        <span className="workspace-list-date">
                          {hasJoinedDate ? <time dateTime={ws.joinedAt}>{joinedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time> : '—'}
                        </span>
                        <span className="workspace-list-open" aria-hidden="true"><span>Open</span><ArrowRight size={15} /></span>
                        <span id={`workspace-access-${ws.id}`} className="workspace-sr-only">
                          {ws.role === 'OWNER' ? 'Manage workspace and members' : ws.role === 'EDITOR' ? 'Edit files and collaborate' : 'Read-only access'}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </main>

      {isCreateModalOpen && (
        <div className="workspace-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeCreateModal(); }}>
          <div ref={createDialogRef} className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title" aria-describedby="create-workspace-description" aria-busy={createLoading} tabIndex={-1}>
            <div className="workspace-dialog-header">
              <h2 id="create-workspace-title">New Workspace</h2>
              <button type="button" className="site-button workspace-dialog-close" onClick={closeCreateModal} disabled={createLoading} aria-label="Close create workspace dialog">
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <form onSubmit={handleCreateWorkspace} className="modal-form workspace-modal-form">
              <p id="create-workspace-description" className="site-muted">Start coding on your own, then invite teammates from the workspace whenever you’re ready.</p>
              {createError && <div className="workspace-notice" role="alert">{createError}</div>}
              <div className="workspace-form-field">
                <label htmlFor="wsName">Workspace Name</label>
                <input
                  id="wsName"
                  ref={createNameRef}
                  className="site-input"
                  type="text"
                  placeholder="e.g. frontend-app"
                  value={newWorkspaceName}
                  onChange={e => setNewWorkspaceName(e.target.value)}
                  required
                  maxLength={100}
                  disabled={createLoading}
                />
              </div>
              <div className="workspace-form-field">
                <label htmlFor="wsDesc">Description (Optional)</label>
                <textarea
                  id="wsDesc"
                  className="site-input"
                  placeholder="What are you working on?"
                  value={newWorkspaceDesc}
                  onChange={e => setNewWorkspaceDesc(e.target.value)}
                  rows={3}
                  maxLength={500}
                  disabled={createLoading}
                  aria-describedby="workspace-description-limit"
                />
                <span id="workspace-description-limit" className="workspace-field-hint">{newWorkspaceDesc.length}/500 characters</span>
              </div>
              <div className="workspace-form-actions">
                <button type="submit" className="site-button site-button-primary" disabled={createLoading || !newWorkspaceName.trim()}>
                  {createLoading ? 'Creating...' : 'Create Workspace'}
                </button>
                <button type="button" className="site-button" onClick={closeCreateModal} disabled={createLoading}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <footer className="site-container workspace-footer" aria-hidden={isCreateModalOpen || undefined}>
        <span>&copy; {new Date().getFullYear()} SyncScript</span>
        <span>Collaborative code editor</span>
      </footer>
    </div>
  );
};

export default Dashboard;
