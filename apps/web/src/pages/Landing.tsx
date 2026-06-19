import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { Shield, Sparkles, Activity, CheckCircle, ArrowRight } from 'lucide-react';

interface HealthData {
  status: string;
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
  services: {
    database: {
      status: string;
      latency: string;
    };
  };
}

export const Landing: React.FC = () => {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get('/api/health');
      if (response.data && response.data.success) {
        setHealth(response.data.data);
      } else {
        throw new Error('Invalid health check response');
      }
    } catch (err) {
      const errorMsg = axios.isAxiosError(err)
        ? err.response?.data?.error?.message
        : err instanceof Error
          ? err.message
          : 'Failed to fetch server health';
      setError(errorMsg || 'Failed to fetch server health');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  return (
    <div className="app-container">
      {/* Background decorative elements */}
      <div className="glow-orb orb-1"></div>
      <div className="glow-orb orb-2"></div>

      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">&lt;/&gt;</div>
          <span className="brand-name">SyncScript</span>
        </div>
        
        <nav className="header-nav">
          {user ? (
            <Link to="/dashboard" className="btn btn-secondary btn-sm">
              Dashboard
            </Link>
          ) : (
            <div className="nav-buttons">
              <Link to="/login" className="nav-link-btn">
                Sign In
              </Link>
              <Link to="/register" className="btn btn-primary btn-sm">
                Sign Up
              </Link>
            </div>
          )}
        </nav>
      </header>

      <main className="app-main">
        <section className="hero-section">
          <div className="badge-announcement">
            <Sparkles size={14} className="badge-icon" />
            <span>Production Ready: Real-time collaborative workspace environment active!</span>
          </div>
          
          <h1 className="hero-title">
            Collaborative Coding, <br />
            <span className="gradient-text">Perfected in Real-Time.</span>
          </h1>
          <p className="hero-subtitle">
            Experience lightning-fast code synchronization, workspaces, live chat, version history,
            and seamless team collaboration in a unified secure environment.
          </p>
          <div className="hero-actions">
            {user ? (
              <Link to="/dashboard" className="btn btn-primary">
                Go to Dashboard <ArrowRight size={16} style={{ marginLeft: '8px' }} />
              </Link>
            ) : (
              <>
                <Link to="/register" className="btn btn-primary">
                  Start Coding Free <ArrowRight size={16} style={{ marginLeft: '8px' }} />
                </Link>
                <Link to="/login" className="btn btn-secondary">
                  Sign In
                </Link>
              </>
            )}
          </div>
        </section>

        <section className="status-dashboard">
          <div className="card glass-card">
            <div className="card-header-status">
              <Activity size={20} className="status-icon-header" />
              <h2 className="card-title">Monorepo System Status</h2>
            </div>
            {loading ? (
              <div className="loading-spinner">
                <div className="spinner"></div>
                <p>Querying API status...</p>
              </div>
            ) : error ? (
              <div className="status-error">
                <p className="error-message">Error connecting to the backend services:</p>
                <code className="error-code">{error}</code>
                <p className="error-hint">
                  Make sure the backend server is running and the database is configured.
                </p>
              </div>
            ) : (
              <div className="status-grid">
                <div className="status-item">
                  <span className="label">Status:</span>
                  <span className="value status-badge positive">{health?.status}</span>
                </div>
                <div className="status-item">
                  <span className="label">Version:</span>
                  <span className="value">{health?.version}</span>
                </div>
                <div className="status-item">
                  <span className="label">Environment:</span>
                  <span className="value capitalize">{health?.environment}</span>
                </div>
                <div className="status-item">
                  <span className="label">Database:</span>
                  <span
                    className={`value status-badge ${health?.services.database.status === 'connected' ? 'positive' : 'negative'}`}
                  >
                    {health?.services.database.status} ({health?.services.database.latency})
                  </span>
                </div>
                <div className="status-item full-width">
                  <span className="label">Last Checked:</span>
                  <span className="value code-text">
                    {health ? new Date(health.timestamp).toLocaleString() : ''}
                  </span>
                </div>
              </div>
            )}
            <div className="card-footer-actions">
              <button className="btn btn-secondary btn-sm" onClick={fetchHealth}>
                Refresh Health
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <p>&copy; {new Date().getFullYear()} SyncScript. Made for developers, by developers.</p>
      </footer>
    </div>
  );
};

export default Landing;
