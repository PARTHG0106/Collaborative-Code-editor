import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Code2, FileCode2, Folder, GitBranch, Terminal } from 'lucide-react';
import { useAuth, apiClient } from '../context/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';

export const Landing: React.FC = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const healthRequestRef = useRef<AbortController | null>(null);

  const fetchHealth = useCallback(async () => {
    if (healthRequestRef.current) return;
    const controller = new AbortController();
    healthRequestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get('/health', { signal: controller.signal, timeout: 20000 });
      if (controller.signal.aborted) return;
      if (!response.data?.success || response.data.data?.status !== 'healthy' || response.data.data.services?.database?.status !== 'connected') {
        throw new Error('Service unavailable');
      }
    } catch {
      if (controller.signal.aborted) return;
      setError('We couldn’t connect to SyncScript. The server may be starting; try again in a moment.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (healthRequestRef.current === controller) healthRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
    return () => {
      healthRequestRef.current?.abort();
      healthRequestRef.current = null;
    };
  }, [fetchHealth]);

  return (
    <div className="landing-page">
      <a href="#main-content" className="site-skip-link">Skip to content</a>
      <header className="site-header">
        <div className="site-container landing-header-inner">
          <Link to="/" className="site-brand" aria-label="SyncScript home"><Code2 size={21} strokeWidth={1.7} aria-hidden="true" /><span>syncscript</span></Link>
          <nav className="landing-nav" aria-label="Account">
            <a href="#workflow" className="landing-product-link">How it works</a>
            <ThemeToggle />
            {user ? <Link className="site-button site-button-primary" to="/dashboard">Dashboard <ArrowRight size={14} aria-hidden="true" /></Link> : <>
              <Link to="/login">Sign In</Link>
              <Link className="site-button site-button-primary" to="/register">Sign Up <ArrowRight size={14} aria-hidden="true" /></Link>
            </>}
          </nav>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="site-container landing-main">
        <section className="landing-intro" aria-labelledby="landing-heading">
          <div className="landing-intro-copy">
            <p className="site-eyebrow">A collaborative code editor</p>
            <h1 id="landing-heading">Your code.<br />Room to work.</h1>
            <p className="landing-description">Write, run, and share code in one workspace. Start on your own. Bring a teammate when you need another pair of eyes.</p>
            <div className="landing-actions">
              <Link to={user ? '/dashboard' : '/register'} className="site-button site-button-primary">{user ? 'Open your workspaces' : 'Create a workspace'}<ArrowRight size={15} aria-hidden="true" /></Link>
              {!user && <Link to="/login" className="landing-text-link">Already have an account?</Link>}
            </div>
            <p className="landing-platform-note">In your browser. Ready when you are.</p>
          </div>

          <figure className="landing-demo" aria-label="Example collaborative coding workspace">
            <figcaption className="landing-demo-caption"><span><Folder size={13} aria-hidden="true" />hello-world</span><span>Example workspace</span></figcaption>
            <div className="landing-demo-body">
              <div className="landing-demo-explorer" aria-hidden="true"><span>FILES</span><div className="selected"><FileCode2 size={13} />hello.py</div><div><FileCode2 size={13} />README.md</div></div>
              <div className="landing-demo-editor">
                <div className="landing-demo-tab"><FileCode2 size={13} aria-hidden="true" />hello.py</div>
                <div className="landing-code" aria-label="Python example that prints Hello, team!">
                  <div><span className="line-number">1</span><code><span className="code-keyword">def</span> <span className="code-function">greet</span>(name):</code></div>
                  <div><span className="line-number">2</span><code>{'    '}<span className="code-keyword">return</span> <span className="code-string">{'f"Hello, {name}!"'}</span></code></div>
                  <div><span className="line-number">3</span><code>{' '}</code></div>
                  <div><span className="line-number">4</span><code><span className="code-comment"># A little better, together.</span></code></div>
                  <div><span className="line-number">5</span><code>print(greet(<span className="code-string">{'"team"'}</span>))<span className="landing-demo-caret" /></code></div>
                  <div><span className="line-number">6</span><code>{' '}</code></div>
                </div>
                <div className="landing-demo-terminal"><span><Terminal size={12} aria-hidden="true" />Output</span><code>Hello, team!</code></div>
              </div>
            </div>
            <div className="landing-demo-status"><span><GitBranch size={12} aria-hidden="true" />Python</span><span><i />All changes saved</span></div>
          </figure>
        </section>

        <section id="workflow" className="landing-workflow" aria-label="How SyncScript works">
          <article><span className="site-eyebrow">01 / Write</span><h2>A familiar place to code.</h2><p>Organize files, search your workspace, and make the editor your own.</p></article>
          <article><span className="site-eyebrow">02 / Collaborate</span><h2>Work in the same file.</h2><p>See edits as they happen. Keep the conversation beside your code, with access you control.</p></article>
          <article><span className="site-eyebrow">03 / Run & revisit</span><h2>Try it. Keep what works.</h2><p>Run code from your workspace and save snapshots to return to an earlier version.</p></article>
        </section>
      </main>

      <footer className="site-container landing-footer">
        <p>© {new Date().getFullYear()} SyncScript</p>
        <div className="landing-service" aria-label="Service status">
          <span role="status"><i className={loading ? 'pending' : error ? 'unavailable' : ''} aria-hidden="true" />{loading ? 'Checking connection…' : error ? 'Connection unavailable' : 'Service available'}{error && <span className="landing-service-error">{error}</span>}</span>
          <button type="button" onClick={() => void fetchHealth()} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</button>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
