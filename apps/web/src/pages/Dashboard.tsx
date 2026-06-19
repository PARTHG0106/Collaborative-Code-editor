import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, User, FolderGit2, Calendar, Mail, KeyRound, Sparkles } from 'lucide-react';

export const Dashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

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

      <header className="dashboard-header glass-card">
        <div className="brand">
          <div className="brand-logo">&lt;/&gt;</div>
          <span className="brand-name">SyncScript</span>
          <span className="badge-phase">Phase 2: Auth Active</span>
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
              You are securely authenticated. Let's create something incredible together.
            </p>
          </div>
          <div className="banner-icon">
            <Sparkles size={48} className="sparkle-icon" />
          </div>
        </section>

        <div className="dashboard-grid">
          {/* User Profile Card */}
          <section className="dashboard-card glass-card">
            <h2 className="card-title-dashboard">
              <User size={20} className="card-icon" />
              <span>Authentication Profile</span>
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

          {/* Workspaces Preview Card (Phase 3 Hook) */}
          <section className="dashboard-card glass-card coming-soon-card">
            <div className="card-content-overlay">
              <FolderGit2 size={48} className="coming-soon-icon" />
              <h2 className="card-title-dashboard-center">Workspaces & Projects</h2>
              <p className="card-subtitle-dashboard-center">
                Create, share, and manage collaborative work environments.
              </p>
              <div className="badge-coming-soon">Coming in Phase 3</div>
            </div>
          </section>
        </div>
      </main>

      <footer className="dashboard-footer">
        <p>&copy; {new Date().getFullYear()} SyncScript. Secured with JSON Web Token Rotation.</p>
      </footer>
    </div>
  );
};

export default Dashboard;
