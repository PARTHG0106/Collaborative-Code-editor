import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { KeyRound, ShieldAlert, ArrowRight, CheckCircle2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const VerifyEmail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email') || '';
  
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

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

  // Track mouse coordinates for background lighting glow
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

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
    <div className="min-h-screen w-full flex items-center justify-center p-6 relative">
      {/* Mouse gradient effect */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(var(--accent-primary-rgb), 0.08), transparent 40%)`,
        }}
      />

      <div className="auth-card glass-card relative z-10 max-w-[440px] w-full p-6 sm:p-10 bg-background/50 backdrop-blur-lg border border-[var(--border)] shadow-glow rounded-2xl flex flex-col gap-6">
        <div className="auth-header-content text-center flex flex-col items-center gap-3">
          <div className="auth-brand inline-flex items-center gap-2">
            <div className="text-xl font-bold bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] bg-clip-text text-transparent brand-logo">&lt;/&gt;</div>
            <span className="text-xl font-bold text-[var(--text-primary)] brand-name font-sans">SyncScript</span>
          </div>
          <h2 className="text-3xl font-extrabold tracking-tight text-[var(--text-primary)] mt-2">Verify Email</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Enter the 6-digit code sent to <strong style={{ color: 'var(--primary)' }}>{email || 'your email'}</strong>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form flex flex-col gap-4">
          {(localError || error) && (
            <div className="auth-error-alert flex items-center gap-3 bg-red-500/10 border border-red-500/30 text-red-400 p-3.5 rounded-lg text-sm">
              <ShieldAlert className="alert-icon flex-shrink-0" size={18} />
              <span>{localError || error}</span>
            </div>
          )}

          {successMessage && (
            <div className="auth-success-alert flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 p-3.5 rounded-lg text-sm">
              <CheckCircle2 size={18} style={{ flexShrink: 0 }} />
              <span>{successMessage}</span>
            </div>
          )}

          <div className="input-group flex flex-col gap-2">
            <label htmlFor="code" className="text-xs font-semibold text-[var(--text-secondary)] tracking-wider">Verification Code</label>
            <div className="input-wrapper relative flex items-center">
              <KeyRound className="input-icon absolute left-3.5 text-gray-500 pointer-events-none" size={18} />
              <input
                id="code"
                type="text"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                disabled={isSubmitting || !email}
                className="w-full pl-11 pr-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-gray-500 focus:outline-none focus:border-primary/50 focus:bg-white transition-all duration-200"
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

          <Button type="submit" className="w-full mt-4 py-6 text-base font-semibold group rounded-lg" disabled={isSubmitting || !email}>
            {isSubmitting ? (
              <span className="button-loading flex items-center justify-center gap-2">
                <span className="btn-spinner"></span> Verifying...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                Verify &amp; Continue <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
              </span>
            )}
          </Button>
        </form>

        <div className="auth-footer text-center mt-2 flex flex-col gap-4 text-sm text-[var(--text-secondary)]">
          <button
            type="button"
            className="hover:text-[var(--text-primary)] transition-colors"
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
              color: resendCooldown > 0 ? 'var(--text-muted)' : 'var(--primary)',
              opacity: resendCooldown > 0 ? 0.6 : 1,
            }}
          >
            <RotateCw size={14} className={isSubmitting ? 'animate-spin' : ''} />
            {resendCooldown > 0 ? `Resend Code in ${resendCooldown}s` : 'Resend Verification Code'}
          </button>

          <p style={{ margin: 0 }}>
            Back to{' '}
            <Link to="/login" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default VerifyEmail;
