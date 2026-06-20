import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { WorkspaceDetail } from '../components/WorkspaceDetail';
import { 
  LogOut, User, FolderGit2, Mail, KeyRound, Sparkles, 
  Plus, Users, ArrowRight, ShieldCheck, Shield, ShieldAlert,
  X, Loader2
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
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  // Workspaces state
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  // Workspace creation modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceDesc, setNewWorkspaceDesc] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  // Fetch workspaces
  const fetchWorkspaces = useCallback(async () => {
    if (!user) return;
    try {
      setLoadingWorkspaces(true);
      setDashboardError(null);
      const res = await apiClient.get('/workspaces');
      if (res && res.data && res.data.success) {
        setWorkspaces(res.data.data);
      }
    } catch (err: any) {
      setDashboardError(err.response?.data?.error?.message || 'Failed to fetch workspaces');
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [user, apiClient]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  // Track mouse coordinates for background lighting glow
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

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
    if (!newWorkspaceName.trim()) return;

    setCreateLoading(true);
    setDashboardError(null);
    try {
      const res = await apiClient.post('/workspaces', {
        name: newWorkspaceName,
        description: newWorkspaceDesc || null,
      });

      if (res.data && res.data.success) {
        setWorkspaces((prev) => [res.data.data, ...prev]);
        setIsCreateModalOpen(false);
        setNewWorkspaceName('');
        setNewWorkspaceDesc('');
        // Instantly focus the newly created workspace
        setActiveWorkspaceId(res.data.data.id);
      }
    } catch (err: any) {
      setDashboardError(err.response?.data?.error?.message || 'Failed to create workspace');
    } finally {
      setCreateLoading(false);
    }
  };

  const getRoleIcon = (role: 'OWNER' | 'EDITOR' | 'VIEWER') => {
    switch (role) {
      case 'OWNER': return <ShieldCheck className="text-purple-400" size={14} />;
      case 'EDITOR': return <Shield className="text-blue-400" size={14} />;
      case 'VIEWER': return <ShieldAlert className="text-gray-400" size={14} />;
    }
  };

  if (!user) return null;

  return (
    <div className="min-h-screen w-full flex flex-col relative">
      {/* Mouse gradient effect */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `radial-gradient(800px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(99, 102, 241, 0.05), transparent 40%)`,
        }}
      />

      <header className="dashboard-header glass-card relative z-10">
        <div className="brand">
          <div className="brand-logo">&lt;/&gt;</div>
          <span className="brand-name">SyncScript</span>
        </div>
        <div className="header-actions">
          <div className="user-profile-summary">
            <div className="avatar">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="user-details-text">
              <span className="user-name">{user.name}</span>
              <span className="user-email">{user.email}</span>
            </div>
          </div>
          <button className="btn btn-secondary btn-icon" onClick={handleLogout} disabled={isLoggingOut}>
            <LogOut size={16} />
            <span>{isLoggingOut ? 'Logging out...' : 'Sign Out'}</span>
          </button>
        </div>
      </header>

      <main className="dashboard-main relative z-10">
        {/* Error notification */}
        {dashboardError && (
          <div className="alert alert-danger glass-card">
            <X className="alert-close" onClick={() => setDashboardError(null)} size={16} />
            <span>{dashboardError}</span>
          </div>
        )}


        {activeWorkspaceId ? (
          /* Render Workspace Details View */
          <WorkspaceDetail 
            workspaceId={activeWorkspaceId} 
            onBack={() => {
              setActiveWorkspaceId(null);
              fetchWorkspaces();
            }}
            onWorkspaceDeleted={() => {
              setActiveWorkspaceId(null);
              fetchWorkspaces();
            }}
          />
        ) : (
          /* Render General Dashboard and Grid View */
          <>
            <section className="welcome-banner glass-card">
              <div className="banner-content">
                <h1 className="banner-title">
                  Welcome back, <span className="gradient-text">{user.name}</span>!
                </h1>
                <p className="banner-subtitle">
                  Secure real-time collaborative development. Select a workspace or create a new one to get started.
                </p>
              </div>
              <div className="banner-icon">
                <Sparkles size={48} className="sparkle-icon" />
              </div>
            </section>

            <div className="dashboard-sections-layout">
              {/* Left Column: Workspaces List */}
              <section className="workspaces-section glass-card">
                <div className="section-header-dashboard">
                  <div className="title-with-icon">
                    <FolderGit2 className="card-icon" size={22} />
                    <h2>Your Workspaces</h2>
                  </div>
                  <button 
                    className="btn btn-primary btn-icon btn-sm" 
                    onClick={() => setIsCreateModalOpen(true)}
                  >
                    <Plus size={16} />
                    <span>New Workspace</span>
                  </button>
                </div>

                {loadingWorkspaces ? (
                  <div className="workspaces-loading-state">
                    <Loader2 className="animate-spin text-purple-500" size={24} />
                    <p>Loading workspaces...</p>
                  </div>
                ) : workspaces.length === 0 ? (
                  <div className="empty-workspaces-state">
                    <FolderGit2 size={40} className="empty-icon" />
                    <h3>No Workspaces Yet</h3>
                    <p>Create a workspace to begin coding, or have a teammate invite you by email.</p>
                    <button className="btn btn-secondary btn-icon mt-4" onClick={() => setIsCreateModalOpen(true)}>
                      <Plus size={16} />
                      <span>Create Workspace</span>
                    </button>
                  </div>
                ) : (
                  <div className="workspaces-grid">
                    {workspaces.map((ws) => (
                      <div 
                        key={ws.id} 
                        className="workspace-item-card"
                        onClick={() => setActiveWorkspaceId(ws.id)}
                      >
                        <div className="card-meta">
                          <span className="role-badge">
                            {getRoleIcon(ws.role)}
                            <span>{ws.role}</span>
                          </span>
                          <span className="member-count-badge">
                            <Users size={12} />
                            <span>{ws.memberCount}</span>
                          </span>
                        </div>
                        <h3 className="workspace-name-card">{ws.name}</h3>
                        <p className="workspace-desc-card">
                          {ws.description || 'No description provided.'}
                        </p>
                        <div className="card-arrow-action">
                          <span>Open Environment</span>
                          <ArrowRight size={14} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Right Column: User Profile details */}
              <section className="dashboard-card glass-card">
                <h2 className="card-title-dashboard">
                  <User size={20} className="card-icon" />
                  <span>Profile Overview</span>
                </h2>
                <div className="profile-details">
                  <div className="profile-item">
                    <span className="label">
                      <KeyRound size={16} /> User ID
                    </span>
                    <span className="value code-text">{user.id}</span>
                  </div>
                  <div className="profile-item">
                    <span className="label">
                      <Mail size={16} /> Email
                    </span>
                    <span className="value">{user.email}</span>
                  </div>
                  <div className="profile-item">
                    <span className="label">
                      <User size={16} /> Full Name
                    </span>
                    <span className="value">{user.name}</span>
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </main>

      {/* Create Workspace Modal */}
      {isCreateModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-content glass-card">
            <div className="modal-header">
              <h2>New Workspace Environment</h2>
              <button className="close-btn" onClick={() => setIsCreateModalOpen(false)}>
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleCreateWorkspace} className="modal-form">
              <div className="form-group">
                <label htmlFor="wsName">Workspace Name</label>
                <input 
                  id="wsName"
                  type="text" 
                  placeholder="e.g. Main Editor Project" 
                  value={newWorkspaceName} 
                  onChange={e => setNewWorkspaceName(e.target.value)} 
                  required 
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="wsDesc">Description (Optional)</label>
                <textarea 
                  id="wsDesc"
                  placeholder="Briefly describe this project..." 
                  value={newWorkspaceDesc} 
                  onChange={e => setNewWorkspaceDesc(e.target.value)} 
                  rows={4}
                />
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={createLoading}>
                  {createLoading ? 'Creating...' : 'Create Workspace'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setIsCreateModalOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <footer className="dashboard-footer relative z-10">
        <p>&copy; {new Date().getFullYear()} SyncScript. Secured with JSON Web Token Rotation.</p>
      </footer>
    </div>
  );
};

export default Dashboard;
