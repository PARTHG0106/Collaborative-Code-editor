import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

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

function App() {
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
        <div className="status-badge-container">
          <span className={`status-dot ${health?.status === 'healthy' ? 'online' : 'offline'}`} />
          <span className="status-text">
            {loading
              ? 'Checking...'
              : health?.status === 'healthy'
                ? 'Server Online'
                : 'Server Offline'}
          </span>
        </div>
      </header>

      <main className="app-main">
        <section className="hero-section">
          <h1 className="hero-title">
            Collaborative Coding, <br />
            <span className="gradient-text">Perfected in Real-Time.</span>
          </h1>
          <p className="hero-subtitle">
            Experience lightning-fast code synchronization, workspaces, live chat, version history,
            and seamless team collaboration in a unified environment.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary" onClick={fetchHealth}>
              Check System Status
            </button>
            <a
              href="https://github.com/PARTHG0106/Collaborative-Code-editor"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
            >
              View Repository
            </a>
          </div>
        </section>

        <section className="status-dashboard">
          <div className="card glass-card">
            <h2 className="card-title">Monorepo System Status</h2>
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
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <p>&copy; {new Date().getFullYear()} SyncScript. Made for developers, by developers.</p>
      </footer>
    </div>
  );
}

export default App;
