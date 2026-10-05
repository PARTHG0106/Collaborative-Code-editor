import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Code2, Eye, EyeOff } from 'lucide-react';
import { getAuthDestination } from './authNavigation';
import { GoogleSignIn } from '../components/GoogleSignIn';
import './AuthPages.css';

export const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGooglePending, setIsGooglePending] = useState(false);
  const isBusy = isSubmitting || isGooglePending;

  const { login, user, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Route to redirect to after successful login
  const from = getAuthDestination(location.state);

  // Clear errors when the component mounts or values change
  useEffect(() => {
    clearError();
    setLocalError(null);
  }, [email, password, clearError]);

  // Use the same destination for restored sessions and submitted credentials.
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setLocalError('Please fill in all fields');
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);

    try {
      await login(trimmedEmail, password);
      navigate(from, { replace: true });
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'EMAIL_NOT_VERIFIED') {
        navigate(`/verify-email?email=${encodeURIComponent(trimmedEmail)}`, { replace: true, state: location.state });
        return;
      }
      const errMsg = err instanceof Error ? err.message : 'Invalid credentials';
      setLocalError(errMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-page-content">
        <Link to="/" aria-label="SyncScript home" className="site-brand auth-page-brand">
          <Code2 size={20} aria-hidden="true" />
          <span>syncscript</span>
        </Link>
        <header className="auth-page-heading">
          <h1>Welcome back</h1>
          <p>Sign in to open your workspaces.</p>
        </header>

        <GoogleSignIn
          disabled={isSubmitting}
          onPendingChange={setIsGooglePending}
          onStart={() => { clearError(); setLocalError(null); }}
          onError={setLocalError}
          onSuccess={() => navigate(from, { replace: true })}
        />

        <form onSubmit={handleSubmit} aria-busy={isBusy} aria-describedby={localError || error ? 'login-error' : undefined} className="auth-page-form">
          {(localError || error) && (
            <div id="login-error" role="alert" className="auth-page-message auth-page-error">
              {localError || error}
            </div>
          )}

          <div className="auth-page-field">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isBusy}
              className="site-input"
              required
            />
          </div>

          <div className="auth-page-field">
            <label htmlFor="password">Password</label>
            <div className="auth-page-password">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isBusy}
                className="site-input"
                required
              />
              <button type="button" className="auth-page-password-toggle" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-controls="password" disabled={isBusy}>
                {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </div>
          </div>

          <button type="submit" className="site-button site-button-primary auth-page-submit" disabled={isBusy}>
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <footer className="auth-page-footer">
          <p>
            {"Don't have an account? "}
            <Link to="/register" state={location.state}>
              Sign Up
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
};

export default Login;

