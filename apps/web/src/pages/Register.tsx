import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, User as UserIcon, ShieldAlert, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const Register: React.FC = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  const { register, user, error, clearError } = useAuth();
  const navigate = useNavigate();

  // Clear errors when the component mounts or values change
  useEffect(() => {
    clearError();
    setLocalError(null);
  }, [name, email, password, clearError]);

  // If already logged in, redirect straight to dashboard
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
      navigate(`/verify-email?email=${encodeURIComponent(email)}`, { replace: true });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Registration failed';
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
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(99, 102, 241, 0.08), transparent 40%)`,
        }}
      />

      <div className="auth-card glass-card relative z-10 max-w-[440px] w-full p-10 bg-background/50 backdrop-blur-lg border border-border/50 shadow-glow rounded-2xl flex flex-col gap-6">
        <div className="auth-header-content text-center flex flex-col items-center gap-3">
          <div className="auth-brand inline-flex items-center gap-2">
            <div className="text-xl font-bold bg-gradient-to-r from-primary to-[#a855f7] bg-clip-text text-transparent brand-logo">&lt;/&gt;</div>
            <span className="text-xl font-bold text-white brand-name font-sans">SyncScript</span>
          </div>
          <h2 className="text-3xl font-extrabold tracking-tight text-white mt-2">Create Account</h2>
          <p className="text-sm text-gray-400">Get started with real-time collaborative editing</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form flex flex-col gap-4">
          {(localError || error) && (
            <div className="auth-error-alert flex items-center gap-3 bg-red-500/10 border border-red-500/30 text-red-400 p-3.5 rounded-lg text-sm">
              <ShieldAlert className="alert-icon flex-shrink-0" size={18} />
              <span>{localError || error}</span>
            </div>
          )}

          <div className="input-group flex flex-col gap-2">
            <label htmlFor="name" className="text-xs font-semibold text-gray-400 tracking-wider">Full Name</label>
            <div className="input-wrapper relative flex items-center">
              <UserIcon className="input-icon absolute left-3.5 text-gray-500 pointer-events-none" size={18} />
              <input
                id="name"
                type="text"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSubmitting}
                className="w-full pl-11 pr-4 py-3 bg-[#12131a]/40 border border-border/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary/50 focus:bg-[#12131a]/60 transition-all duration-200"
                required
              />
            </div>
          </div>

          <div className="input-group flex flex-col gap-2">
            <label htmlFor="email" className="text-xs font-semibold text-gray-400 tracking-wider">Email Address</label>
            <div className="input-wrapper relative flex items-center">
              <Mail className="input-icon absolute left-3.5 text-gray-500 pointer-events-none" size={18} />
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                className="w-full pl-11 pr-4 py-3 bg-[#12131a]/40 border border-border/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary/50 focus:bg-[#12131a]/60 transition-all duration-200"
                required
              />
            </div>
          </div>

          <div className="input-group flex flex-col gap-2">
            <label htmlFor="password" className="text-xs font-semibold text-gray-400 tracking-wider">Password</label>
            <div className="input-wrapper relative flex items-center">
              <Lock className="input-icon absolute left-3.5 text-gray-500 pointer-events-none" size={18} />
              <input
                id="password"
                type="password"
                placeholder="Min. 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
                className="w-full pl-11 pr-4 py-3 bg-[#12131a]/40 border border-border/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-primary/50 focus:bg-[#12131a]/60 transition-all duration-200"
                required
              />
            </div>
          </div>

          <Button type="submit" className="w-full mt-4 py-6 text-base font-semibold group rounded-lg" disabled={isSubmitting}>
            {isSubmitting ? (
              <span className="button-loading flex items-center justify-center gap-2">
                <span className="btn-spinner"></span> Creating Account...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-2">
                Sign Up <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
              </span>
            )}
          </Button>
        </form>

        <div className="auth-footer text-center mt-2 text-sm text-gray-400">
          <p>
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:text-primary/80 font-semibold transition-colors">
              Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Register;

