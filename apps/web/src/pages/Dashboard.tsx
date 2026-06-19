import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { useWorkspaces } from '../context/WorkspaceContext.js';
import { WorkspaceSelector } from '../components/workspaces/WorkspaceSelector.js';
import { WorkspaceSettingsModal } from '../components/workspaces/WorkspaceSettingsModal.js';
import { LogOut, User, FolderGit2, Mail, KeyRound, Sparkles, Settings, Users, Shield, ArrowRight } from 'lucide-react';

export const Dashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const { currentWorkspace, loading } = useWorkspaces();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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

  if (!user) return null;

  return (
    <div className="dashboard-container">
      {/* Background decorative elements */}
      <div className="glow-orb orb-1"></div>
      <div className="glow-orb orb-2"></div>

      <header className="dashboard-header glass-card flex items-center justify-between">
        <div className="brand flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="brand-logo">&lt;/&gt;</div>
            <span className="brand-name font-sans">SyncScript</span>
          </div>
          <span className="badge-phase">Phase 3: Workspaces Active</span>
          
          {/* Workspace dropdown selector */}
          <WorkspaceSelector onOpenSettings={() => setIsSettingsOpen(true)} />
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

      <main className="dashboard-main">
        <section className="welcome-banner glass-card">
          <div className="banner-content">
            <h1 className="banner-title">
              Welcome back, <span className="gradient-text">{user.name}</span>!
            </h1>
            <p className="banner-subtitle">
              Manage your workspaces, invite collaborators, and prepare your coding environments.
            </p>
          </div>
          <div className="banner-icon">
            <Sparkles size={48} className="sparkle-icon" />
          </div>
        </section>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-zinc-200"></div>
          </div>
        ) : currentWorkspace ? (
          <div className="dashboard-grid">
            {/* Active Workspace Info Panel */}
            <section className="dashboard-card glass-card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="card-title-dashboard flex items-center gap-2">
                  <FolderGit2 size={20} className="card-icon text-zinc-400" />
                  <span>Workspace Details</span>
                </h2>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100 transition-colors"
                  title="Workspace Settings"
                >
                  <Settings size={18} />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-bold text-zinc-100">{currentWorkspace.name}</h3>
                  <p className="text-sm text-zinc-400 mt-1">
                    {currentWorkspace.description || 'No description provided.'}
                  </p>
                </div>

                <div className="border-t border-zinc-900 pt-4 space-y-2 text-sm text-zinc-300">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Your Access Role:</span>
                    <span className="font-semibold flex items-center gap-1">
                      <Shield size={14} className="text-zinc-400" />
                      {currentWorkspace.role}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Total Members:</span>
                    <span className="font-semibold flex items-center gap-1">
                      <Users size={14} className="text-zinc-400" />
                      {currentWorkspace.members?.length || 1}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Project / Files (Coming Soon Placeholder) */}
            <section className="dashboard-card glass-card coming-soon-card">
              <div className="card-content-overlay">
                <FolderGit2 size={48} className="coming-soon-icon text-zinc-650" />
                <h2 className="card-title-dashboard-center">Files & Live Editor</h2>
                <p className="card-subtitle-dashboard-center">
                  Create code files, organize directories, and start coding in real-time.
                </p>
                <div className="badge-coming-soon">Coming in Phase 4</div>
              </div>
            </section>
          </div>
        ) : (
          /* Empty State: Create or Select Workspace */
          <section className="glass-card flex flex-col items-center justify-center p-12 text-center max-w-xl mx-auto mt-6 border border-dashed border-zinc-800 bg-zinc-950/20">
            <FolderGit2 size={48} className="text-zinc-600 mb-4" />
            <h2 className="text-xl font-bold text-zinc-200">No Workspace Selected</h2>
            <p className="text-sm text-zinc-400 max-w-sm mt-2">
              Select an existing workspace from the dropdown above or create a new workspace to start editing code with your team.
            </p>
            <div className="mt-6 flex items-center gap-2 text-xs text-zinc-500">
              <span>Use the selector at the top left</span>
              <ArrowRight size={12} className="animate-pulse" />
            </div>
          </section>
        )}
      </main>

      <footer className="dashboard-footer">
        <p>&copy; {new Date().getFullYear()} SyncScript. Real-Time Collaborative Workspace Engine.</p>
      </footer>

      {/* Settings Modal */}
      <WorkspaceSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
};

export default Dashboard;
