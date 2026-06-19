import React, { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, User as UserIcon, ShieldAlert, ArrowRight } from 'lucide-react';

export const Register: React.FC = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { register, user, error, clearError } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectParam = searchParams.get('redirect');
  const from = redirectParam || '/dashboard';

  // Clear errors when the component mounts or values change
  useEffect(() => {
    clearError();
    setLocalError(null);
  }, [name, email, password, clearError]);

  // If already logged in, redirect straight to dashboard or redirect param
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name || !email || !password) {
      setLocalError('Please fill in all fields');
      return;
    }

    if (name.length < 2) {
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
      await register(email, password, name);
      navigate(from, { replace: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Registration failed';
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
          <h2 className="auth-title">Create Account</h2>
          <p className="auth-subtitle">Get started with real-time collaborative editing</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {(localError || error) && (
            <div className="auth-error-alert">
              <ShieldAlert className="alert-icon" size={18} />
              <span>{localError || error}</span>
            </div>
          )}

          <div className="input-group">
            <label htmlFor="name">Full Name</label>
            <div className="input-wrapper">
              <UserIcon className="input-icon" size={18} />
              <input
                id="name"
                type="text"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSubmitting}
                required
              />
            </div>
          </div>

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
                placeholder="Min. 6 characters"
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
                <span className="btn-spinner"></span> Creating Account...
              </span>
            ) : (
              <>
                Sign Up <ArrowRight size={16} style={{ marginLeft: '8px' }} />
              </>
            )}
          </button>
        </form>

        <div className="auth-footer">
          <p>
            Already have an account?{' '}
            <Link to="/login" className="auth-link">
              Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Register;
