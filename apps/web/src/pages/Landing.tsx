import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { 
  Shield, 
  Sparkles, 
  Activity, 
  CheckCircle, 
  ArrowRight, 
  Zap, 
  Cpu, 
  Lock, 
  MessagesSquare, 
  History, 
  FolderTree, 
  Code 
} from 'lucide-react';

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

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    card.style.setProperty('--x', `${x}px`);
    card.style.setProperty('--y', `${y}px`);
  };

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

          {/* Premium IDE Visual Mockup */}
          <div className="ide-mockup-frame">
            <div className="ide-mockup-header">
              <div className="window-dots">
                <span className="dot red"></span>
                <span className="dot yellow"></span>
                <span className="dot green"></span>
              </div>
              <div className="window-title">workspace / collab-project / index.js</div>
            </div>
            <div className="ide-mockup-body">
              <div className="ide-mockup-sidebar">
                <div className="sidebar-item active">index.js</div>
                <div className="sidebar-item">styles.css</div>
                <div className="sidebar-item">utils.js</div>
                <div className="sidebar-item">package.json</div>
              </div>
              <div className="ide-mockup-editor">
                <pre>
                  <code>
                    <span className="code-keyword">import</span> React, &#123; useState, useEffect &#125; <span className="code-keyword">from</span> <span className="code-string">'react'</span>;<br />
                    <span className="code-keyword">import</span> &#123; Y &#125; <span className="code-keyword">from</span> <span className="code-string">'yjs'</span>;<br />
                    <br />
                    <span className="code-keyword">const</span> SyncScript = () =&gt; &#123;<br />
                    &nbsp;&nbsp;<span className="code-keyword">const</span> [code, setCode] = useState(<span className="code-string">"// Collaborate in real-time"</span>);<br />
                    &nbsp;&nbsp;<span className="code-comment">// Active developers connected: Parth Goyal, Team</span><br />
                    &nbsp;&nbsp;return &lt;<span className="code-tag">div</span> className=<span className="code-string">"editor"</span>&gt;&#123;code&#125;&lt;/<span className="code-tag">div</span>&gt;;<br />
                    &#125;;<br />
                    <br />
                    <span className="code-keyword">export default</span> SyncScript;
                  </code>
                </pre>
              </div>
              <div className="ide-mockup-chat">
                <div className="chat-header">Workspace Chat</div>
                <div className="chat-messages">
                  <div className="chat-msg">
                    <span className="chat-sender purple">Parth:</span> Hey team, I'm editing index.js!
                  </div>
                  <div className="chat-msg">
                    <span className="chat-sender blue">Devbot:</span> Looks clean! Real-time sync is active.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Core Product Features Section inspired by 21st.dev */}
        <section className="features-section">
          <div className="features-header">
            <h2>Built for modern development teams</h2>
            <p>SyncScript brings you the power of a fully loaded collaborative IDE right inside your browser window.</p>
          </div>
          <div className="features-grid">
            <div className="feature-card" onMouseMove={handleMouseMove}>
              <div className="feature-icon-wrapper">
                <Zap size={22} />
              </div>
              <h3>Real-Time Code Sync</h3>
              <p>Type together concurrently with conflict-free editing, cursor tracking, and zero synchronization delay.</p>
            </div>
            
            <div className="feature-card" onMouseMove={handleMouseMove}>
              <div className="feature-icon-wrapper">
                <FolderTree size={22} />
              </div>
              <h3>Workspace isolation</h3>
              <p>Isolate your repositories, customize directory layouts, and invite team members via direct emails.</p>
            </div>

            <div className="feature-card" onMouseMove={handleMouseMove}>
              <div className="feature-icon-wrapper">
                <MessagesSquare size={22} />
              </div>
              <h3>Live Workspace Discussion</h3>
              <p>Keep your conversations close. Discuss changes and pair program without jumping back and forth to Slack.</p>
            </div>

            <div className="feature-card" onMouseMove={handleMouseMove}>
              <div className="feature-icon-wrapper">
                <History size={22} />
              </div>
              <h3>File Version Revisions</h3>
              <p>Rollback code at any point. View incremental checkpoints, snapshot histories, and easily revert code.</p>
            </div>

            <div className="feature-card" onMouseMove={handleMouseMove}>
              <div className="feature-icon-wrapper">
                <Lock size={22} />
              </div>
              <h3>Secure Code Execution</h3>
              <p>All updates are run through secure channels, ensuring only verified developers can read and modify files.</p>
            </div>

            <div className="feature-card" onMouseMove={handleMouseMove}>
              <div className="feature-icon-wrapper">
                <Cpu size={22} />
              </div>
              <h3>State-of-the-Art Core</h3>
              <p>Engineered using robust monorepo structures, fast REST/Socket endpoints, and automatic caching systems.</p>
            </div>
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
