import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { KeyRound, ShieldAlert, ArrowRight, CheckCircle2, RotateCw } from 'lucide-react';

export const VerifyEmail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email') || '';
  
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const { verifyEmail, resendVerification, user, error, clearError } = useAuth();
  const navigate = useNavigate();
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

  // If already authenticated and verified, redirect to dashboard
  useEffect(() => {
    if (user) {
      navigate('/dashboard', { replace: true });
    }
  }, [user, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) {
      setLocalError('No email address provided. Please return to register or login.');
      return;
    }

    if (code.length !== 6 || !/^\d+$/.test(code)) {
      setLocalError('Please enter a valid 6-digit numeric verification code');
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    setSuccessMessage(null);

    try {
      await verifyEmail(email, code);
      // Auth state changes which triggers redirect to dashboard via user state hook
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Verification failed';
      setLocalError(errMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || !email) return;

    setLocalError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      await resendVerification(email);
      setSuccessMessage('A fresh 6-digit code has been sent to your email.');
      setResendCooldown(30); // 30-second cooldown
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Failed to resend code';
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
          <h2 className="auth-title">Verify Email</h2>
          <p className="auth-subtitle">
            Enter the 6-digit code sent to <strong style={{ color: 'var(--primary-light)' }}>{email || 'your email'}</strong>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {(localError || error) && (
            <div className="auth-error-alert">
              <ShieldAlert className="alert-icon" size={18} />
              <span>{localError || error}</span>
            </div>
          )}

          {successMessage && (
            <div className="auth-success-alert" style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.2)',
              color: '#34d399',
              padding: '10px 14px',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '0.875rem'
            }}>
              <CheckCircle2 size={18} style={{ flexShrink: 0 }} />
              <span>{successMessage}</span>
            </div>
          )}

          <div className="input-group">
            <label htmlFor="code">Verification Code</label>
            <div className="input-wrapper">
              <KeyRound className="input-icon" size={18} />
              <input
                id="code"
                type="text"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                disabled={isSubmitting || !email}
                required
                style={{
                  letterSpacing: code ? '0.4em' : 'normal',
                  textAlign: code ? 'center' : 'left',
                  fontSize: code ? '1.25rem' : '1rem',
                  fontWeight: code ? 'bold' : 'normal',
                }}
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-block btn-auth" disabled={isSubmitting || !email}>
            {isSubmitting ? (
              <span className="button-loading">
                <span className="btn-spinner"></span> Verifying...
              </span>
            ) : (
              <>
                Verify &amp; Continue <ArrowRight size={16} style={{ marginLeft: '8px' }} />
              </>
            )}
          </button>
        </form>

        <div className="auth-footer" style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <button
            type="button"
            className="auth-link"
            onClick={handleResend}
            disabled={resendCooldown > 0 || isSubmitting || !email}
            style={{
              background: 'none',
              border: 'none',
              font: 'inherit',
              cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              color: resendCooldown > 0 ? 'var(--text-muted)' : 'var(--primary-color)',
              opacity: resendCooldown > 0 ? 0.6 : 1,
            }}
          >
            <RotateCw size={14} className={isSubmitting ? 'animate-spin' : ''} />
            {resendCooldown > 0 ? `Resend Code in ${resendCooldown}s` : 'Resend Verification Code'}
          </button>

          <p style={{ margin: 0 }}>
            Back to{' '}
            <Link to="/login" className="auth-link">
              Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default VerifyEmail;
