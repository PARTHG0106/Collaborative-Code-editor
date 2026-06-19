import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, ShieldAlert, ArrowRight } from 'lucide-react';

interface LocationState {
  from?: {
    pathname: string;
  };
}

export const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { login, user, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Route to redirect to after successful login
  const redirectParam = searchParams.get('redirect');
  const state = location.state as LocationState | null;
  const from = state?.from?.pathname || redirectParam || '/dashboard';

  // Clear errors when the component mounts or values change
  useEffect(() => {
    clearError();
    setLocalError(null);
  }, [email, password, clearError]);

  // If already logged in, redirect straight to dashboard or redirect param
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      setLocalError('Please fill in all fields');
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);

    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err: unknown) {
      // Error is set in AuthContext and synced, but we can also display localError
      const errMsg = err instanceof Error ? err.message : 'Invalid credentials';
      setLocalError(errMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="glow-orb orb-1"></div>
      <div className="glow-orb orb-2"></div>

      <div className="auth-card glass-card">
        <div className="auth-header-content">
          <div className="auth-brand">
            <div className="brand-logo">&lt;/&gt;</div>
            <span className="brand-name font-sans">SyncScript</span>
          </div>
          <h2 className="auth-title">Welcome Back</h2>
          <p className="auth-subtitle">Sign in to resume collaborating on code</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {(localError || error) && (
            <div className="auth-error-alert">
              <ShieldAlert className="alert-icon" size={18} />
              <span>{localError || error}</span>
            </div>
          )}

          <div className="input-group">
            <label htmlFor="email">Email Address</label>
            <div className="input-wrapper">
              <Mail className="input-icon" size={18} />
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="password">Password</label>
            <div className="input-wrapper">
              <Lock className="input-icon" size={18} />
              <input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-block btn-auth" disabled={isSubmitting}>
            {isSubmitting ? (
              <span className="button-loading">
                <span className="btn-spinner"></span> Signing In...
              </span>
            ) : (
              <>
                Sign In <ArrowRight size={16} style={{ marginLeft: '8px' }} />
              </>
            )}
          </button>
        </form>

        <div className="auth-footer">
          <p>
            {"Don't have an account? "}{' '}
            <Link to="/register" className="auth-link">
              Sign Up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
