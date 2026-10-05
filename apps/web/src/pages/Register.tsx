import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Code2, Eye, EyeOff } from 'lucide-react';
import { getAuthDestination } from './authNavigation';
import { GoogleSignIn } from '../components/GoogleSignIn';
import './AuthPages.css';

export const Register: React.FC = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGooglePending, setIsGooglePending] = useState(false);
  const isBusy = isSubmitting || isGooglePending;

  const { register, user, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = getAuthDestination(location.state);

  // Clear errors when the component mounts or values change
  useEffect(() => {
    clearError();
    setLocalError(null);
  }, [name, email, password, clearError]);

  // Keep an existing session on the originally requested destination.
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail || !password) {
      setLocalError('Please fill in all fields');
      return;
    }

    if (trimmedName.length < 2) {
      setLocalError('Name must be at least 2 characters long');
      return;
    }

    if (password.length < 6) {
      setLocalError('Password must be at least 6 characters long');
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);

    try {
      await register(trimmedEmail, password, trimmedName);
      navigate(`/verify-email?email=${encodeURIComponent(trimmedEmail)}`, { replace: true, state: location.state });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Registration failed';
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
          <h1>Create an account</h1>
          <p>A shared place for your code.</p>
        </header>

        <GoogleSignIn
          disabled={isSubmitting}
          onPendingChange={setIsGooglePending}
          onStart={() => { clearError(); setLocalError(null); }}
          onError={setLocalError}
          onSuccess={() => navigate(from, { replace: true })}
        />

        <form onSubmit={handleSubmit} aria-busy={isBusy} aria-describedby={localError || error ? 'register-error' : undefined} className="auth-page-form">
          {(localError || error) && (
            <div id="register-error" role="alert" className="auth-page-message auth-page-error">
              {localError || error}
            </div>
          )}

          <div className="auth-page-field">
            <label htmlFor="name">Full Name</label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              minLength={2}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isBusy}
              className="site-input"
              required
            />
          </div>

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
                autoComplete="new-password"
                minLength={6}
                aria-describedby="password-hint"
                placeholder="Min. 6 characters"
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
            <p id="password-hint" className="auth-page-hint">Use at least 6 characters. A longer, unique password is best.</p>
          </div>

          <button type="submit" className="site-button site-button-primary auth-page-submit" disabled={isBusy}>
            {isSubmitting ? 'Creating Account...' : 'Sign Up'}
          </button>
        </form>

        <footer className="auth-page-footer">
          <p>
            Already have an account?{' '}
            <Link to="/login" state={location.state}>
              Sign In
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
};

export default Register;

