import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Code2 } from 'lucide-react';
import { ThemeToggle } from '../components/ThemeToggle';
import { getAuthDestination } from './authNavigation';
import './AuthPages.css';

export const VerifyEmail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const email = (searchParams.get('email') || '').trim();
  
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const { verifyEmail, resendVerification, user, error, clearError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = getAuthDestination(location.state);
  const isBusy = isSubmitting || isResending;
  const errorMessage = localError || error || (!email ? 'No email address provided. Please return to register or login.' : null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clear errors on load/change
  useEffect(() => {
    clearError();
    setLocalError(null);
    setSuccessMessage(null);
  }, [code, clearError]);

  // Cooldown countdown for resending verification code
  useEffect(() => {
    if (resendCooldown > 0) {
      cooldownTimerRef.current = setTimeout(() => {
        setResendCooldown((prev) => prev - 1);
      }, 1000);
    }
    return () => {
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    };
  }, [resendCooldown]);

  // Continue to the originally requested destination after verification.
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;

    if (!email) {
      setLocalError('No email address provided. Please return to register or login.');
      return;
    }

    if (code.length !== 6 || !/^\d+$/.test(code)) {
      setLocalError('Please enter a valid 6-digit numeric verification code');
      codeInputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    setSuccessMessage(null);

    try {
      await verifyEmail(email, code);
      // The updated session returns to the originally requested workspace.
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Verification failed';
      setLocalError(errMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || isBusy || !email) return;

    setLocalError(null);
    setSuccessMessage(null);
    setIsResending(true);

    try {
      await resendVerification(email);
      setSuccessMessage('A fresh 6-digit code has been sent to your email.');
      setResendCooldown(30); // 30-second cooldown
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Failed to resend code';
      setLocalError(errMsg);
    } finally {
      setIsResending(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-page-content">
        <div className="auth-page-topline">
          <Link to="/" aria-label="SyncScript home" className="site-brand auth-page-brand">
            <Code2 size={20} aria-hidden="true" />
            <span>syncscript</span>
          </Link>
          <ThemeToggle />
        </div>
        <header className="auth-page-heading">
          <h1>Verify Email</h1>
          <p>
            Enter the 6-digit code sent to <strong>{email || 'your email'}</strong>.
          </p>
        </header>

        <form onSubmit={handleSubmit} aria-busy={isBusy} className="auth-page-form">
          {errorMessage && (
            <div id="verify-error" role="alert" className="auth-page-message auth-page-error">
              {errorMessage}
            </div>
          )}

          {successMessage && (
            <div role="status" className="auth-page-message">
              {successMessage}
            </div>
          )}

          <div className="auth-page-field">
            <label htmlFor="code">Verification Code</label>
            <input
              id="code"
              ref={codeInputRef}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-describedby={errorMessage ? 'verify-error code-hint' : 'code-hint'}
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onPaste={(event) => {
                const pastedCode = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
                if (pastedCode) {
                  event.preventDefault();
                  setCode(pastedCode);
                }
              }}
              disabled={isBusy || !email}
              className="site-input auth-page-code"
              required
            />
            <p id="code-hint" className="auth-page-hint">You can paste the entire code. Check your spam folder if it hasn’t arrived.</p>
          </div>

          <button type="submit" className="site-button site-button-primary auth-page-submit" disabled={isBusy || !email}>
            {isSubmitting ? 'Verifying...' : 'Verify & Continue'}
          </button>
        </form>

        <footer className="auth-page-footer">
          <button
            type="button"
            className="auth-page-text-button"
            onClick={handleResend}
            disabled={resendCooldown > 0 || isBusy || !email}
          >
            {isResending ? 'Sending Code...' : resendCooldown > 0 ? `Resend Code in ${resendCooldown}s` : 'Resend Verification Code'}
          </button>

          <p>
            Back to{' '}
            <Link to="/login" state={location.state}>
              Sign In
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
};

export default VerifyEmail;
