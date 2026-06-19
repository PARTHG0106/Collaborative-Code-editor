import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Code2,
  Users,
  History,
  MessageSquare,
  Zap,
  Shield,
  GitBranch,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Activity,
  RefreshCw,
} from 'lucide-react';

/* ────────────────────────────────────────────────────────── */
/*  Types                                                     */
/* ────────────────────────────────────────────────────────── */
interface HealthData {
  status: string;
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
  services: {
    database: { status: string; latency: string };
  };
}

/* ────────────────────────────────────────────────────────── */
/*  FloatingPaths – animated SVG background                   */
/* ────────────────────────────────────────────────────────── */
function FloatingPaths({ position }: { position: number }) {
  const paths = Array.from({ length: 28 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position} -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${152 - i * 5 * position} ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${684 - i * 5 * position} ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    width: 0.5 + i * 0.03,
  }));

  return (
    <div className="absolute inset-0 pointer-events-none">
      <svg
        className="w-full h-full"
        viewBox="0 0 696 316"
        fill="none"
        aria-hidden="true"
      >
        {paths.map((path) => (
          <motion.path
            key={path.id}
            d={path.d}
            stroke="rgb(99,102,241)"
            strokeWidth={path.width}
            strokeOpacity={0.06 + path.id * 0.01}
            initial={{ pathLength: 0.3, opacity: 0.6 }}
            animate={{
              pathLength: 1,
              opacity: [0.3, 0.6, 0.3],
              pathOffset: [0, 1, 0],
            }}
            transition={{
              duration: 20 + Math.random() * 10,
              repeat: Infinity,
              ease: 'linear',
            }}
          />
        ))}
      </svg>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */
/*  FeatureCard                                               */
/* ────────────────────────────────────────────────────────── */
interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  delay: number;
}

function FeatureCard({ icon, title, description, delay }: FeatureCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.55, delay }}
    >
      <Card className="bg-background/50 backdrop-blur-lg border-border/50 hover:border-primary/50 transition-all duration-300 hover:shadow-lg group h-full"
        style={{ backgroundColor: 'rgba(18,19,26,0.6)' }}
      >
        <CardHeader>
          <div className="w-12 h-12 rounded-lg flex items-center justify-center mb-3 group-hover:scale-110 transition-transform duration-300"
            style={{ background: 'linear-gradient(135deg,rgba(99,102,241,0.25) 0%,rgba(168,85,247,0.1) 100%)' }}>
            {icon}
          </div>
          <CardTitle className="text-lg text-white">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription className="text-base leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {description}
          </CardDescription>
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ────────────────────────────────────────────────────────── */
/*  TestimonialCard                                           */
/* ────────────────────────────────────────────────────────── */
interface TestimonialCardProps {
  name: string;
  role: string;
  content: string;
  initials: string;
  delay: number;
}

function TestimonialCard({ name, role, content, initials, delay }: TestimonialCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay }}
    >
      <Card className="h-full backdrop-blur-lg"
        style={{ backgroundColor: 'rgba(18,19,26,0.6)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <CardContent className="pt-6">
          <div className="flex items-start gap-4 mb-4">
            <Avatar className="size-11">
              <AvatarImage src="" alt={name} />
              <AvatarFallback style={{ background: 'var(--accent-gradient)', color: '#fff' }}>
                {initials}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="font-semibold text-white">{name}</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{role}</p>
            </div>
          </div>
          <p className="italic leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            "{content}"
          </p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ────────────────────────────────────────────────────────── */
/*  Main Landing Component                                    */
/* ────────────────────────────────────────────────────────── */
export const Landing: React.FC = () => {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  /* Mouse spotlight */
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) =>
      setMousePosition({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  /* Health check */
  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get('/api/health');
      if (response.data?.success) {
        setHealth(response.data.data);
      } else {
        throw new Error('Invalid health check response');
      }
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? err.response?.data?.error?.message
        : err instanceof Error
        ? err.message
        : 'Failed to fetch server health';
      setError(msg || 'Failed to fetch server health');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHealth(); }, []);

  /* Data */
  const features = [
    { icon: <Code2 className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />, title: 'Real-Time Sync', description: 'Code together in real-time with zero latency. See changes instantly as your team collaborates.' },
    { icon: <Users className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />, title: 'Team Workspaces', description: 'Organize projects into workspaces with role-based access control and team management.' },
    { icon: <History className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />, title: 'Version History', description: 'Never lose work with automatic version control. Restore any previous state with one click.' },
    { icon: <MessageSquare className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />, title: 'Live Chat', description: 'Built-in chat keeps conversations in context, right next to your code.' },
    { icon: <Zap className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />, title: 'Lightning Fast', description: 'Optimized for performance with instant loading and a smooth editing experience.' },
    { icon: <Shield className="w-6 h-6" style={{ color: 'var(--accent-primary)' }} />, title: 'Secure & Private', description: 'Enterprise-grade security with JWT rotation, bcrypt hashing, and environment isolation.' },
  ];

  const testimonials = [
    { name: 'Sarah Chen', role: 'Lead Developer at TechCorp', content: 'SyncScript transformed how our team collaborates. The real-time sync is flawless!', initials: 'SC', delay: 0 },
    { name: 'Marcus Johnson', role: 'CTO at StartupXYZ', content: 'Best collaborative coding tool we\'ve used. The version history saved us countless times.', initials: 'MJ', delay: 0.1 },
    { name: 'Emily Rodriguez', role: 'Senior Engineer at DevHub', content: 'The live chat feature keeps our team connected. No more context switching!', initials: 'ER', delay: 0.2 },
  ];

  return (
    <div className="min-h-screen w-full overflow-x-hidden"
      style={{ background: 'linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 50%, var(--bg-primary) 100%)' }}>

      {/* Mouse spotlight */}
      <div
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-300"
        style={{
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(99,102,241,0.07), transparent 40%)`,
        }}
      />

      {/* Animated SVG paths */}
      <div className="absolute inset-0 z-0">
        <FloatingPaths position={1} />
        <FloatingPaths position={-1} />
      </div>

      {/* ── Navbar ──────────────────────────────────────────── */}
      <header className="relative z-20 flex items-center justify-between px-6 md:px-12 py-5 border-b"
        style={{ borderColor: 'var(--border-glass)', backgroundColor: 'rgba(10,11,16,0.7)', backdropFilter: 'blur(12px)' }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm text-white"
            style={{ background: 'var(--accent-gradient)' }}>
            {'</>'}
          </div>
          <span className="text-xl font-bold text-white">SyncScript</span>
        </div>

        <nav className="flex items-center gap-3">
          {user ? (
            <Button asChild size="sm" className="rounded-full">
              <Link to="/dashboard">Dashboard <ArrowRight className="ml-1 w-4 h-4" /></Link>
            </Button>
          ) : (
            <div className="flex items-center gap-3">
              <Button asChild variant="ghost" size="sm">
                <Link to="/login">Sign In</Link>
              </Button>
              <Button asChild size="sm" className="rounded-full">
                <Link to="/register">Sign Up <ArrowRight className="ml-1 w-4 h-4" /></Link>
              </Button>
            </div>
          )}
        </nav>
      </header>

      <div className="relative z-10">

        {/* ── Hero ──────────────────────────────────────────── */}
        <section className="min-h-[90vh] flex items-center justify-center px-6 md:px-12 py-24">
          <div className="max-w-5xl mx-auto text-center space-y-8">

            <motion.div
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <Badge variant="outline" className="px-4 py-2 text-sm rounded-full"
                style={{ borderColor: 'rgba(99,102,241,0.4)', color: 'var(--text-secondary)', background: 'rgba(99,102,241,0.08)' }}>
                <Activity className="w-3.5 h-3.5 mr-1.5 inline-block" style={{ color: '#10b981' }} />
                Production Ready · All Systems Operational
              </Badge>
            </motion.div>

            {/* Animated headline */}
            <motion.h1
              className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight leading-tight"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8 }}
            >
              <span className="block mb-2">
                {'Collaborative Coding,'.split('').map((char, i) => (
                  <motion.span
                    key={i}
                    initial={{ y: 80, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: i * 0.025, type: 'spring', stiffness: 160, damping: 25 }}
                    className="inline-block text-white"
                  >
                    {char === ' ' ? '\u00A0' : char}
                  </motion.span>
                ))}
              </span>
              <span className="block" style={{ background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                {'Perfected in Real-Time.'.split('').map((char, i) => (
                  <motion.span
                    key={i}
                    initial={{ y: 80, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.5 + i * 0.025, type: 'spring', stiffness: 160, damping: 25 }}
                    className="inline-block"
                  >
                    {char === ' ' ? '\u00A0' : char}
                  </motion.span>
                ))}
              </span>
            </motion.h1>

            <motion.p
              className="text-xl md:text-2xl max-w-3xl mx-auto leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 1.0 }}
            >
              Experience lightning-fast code synchronization, workspaces, live chat, version history,
              and seamless team collaboration in a unified secure environment.
            </motion.p>

            {/* CTA buttons */}
            <motion.div
              className="flex flex-col sm:flex-row gap-4 justify-center items-center pt-2"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 1.2 }}
            >
              {user ? (
                <Button asChild size="xl" className="rounded-full group"
                  style={{ background: 'var(--accent-gradient)' }}>
                  <Link to="/dashboard">
                    <Sparkles className="w-5 h-5 mr-2" />
                    Go to Dashboard
                    <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
              ) : (
                <>
                  <Button asChild size="xl" className="rounded-full group"
                    style={{ background: 'var(--accent-gradient)' }}>
                    <Link to="/register">
                      <Sparkles className="w-5 h-5 mr-2" />
                      Start Coding Free
                      <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="xl" className="rounded-full">
                    <Link to="/login">Sign In</Link>
                  </Button>
                </>
              )}
            </motion.div>

            {/* Status card */}
            <motion.div
              className="pt-6 flex justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 1.4 }}
            >
              <Card className="inline-block backdrop-blur-lg"
                style={{ background: 'rgba(18,19,26,0.7)', border: '1px solid rgba(255,255,255,0.06)', padding: 0 }}>
                <CardContent className="flex flex-wrap items-center gap-4 sm:gap-6 px-6 py-4">
                  {loading ? (
                    <div className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                      <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent-warning)' }} />
                      <span className="text-sm">Querying API…</span>
                    </div>
                  ) : error ? (
                    <div className="flex items-center gap-2" style={{ color: 'var(--accent-danger)' }}>
                      <span className="text-sm">Backend unavailable · </span>
                      <button onClick={fetchHealth} className="text-sm underline flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" /> Retry
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#10b981' }} />
                        <span className="text-sm font-medium text-white">System Status</span>
                      </div>
                      <div className="h-5 w-px" style={{ background: 'var(--border-glass)' }} />
                      <div className="flex flex-wrap items-center gap-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" style={{ color: '#10b981' }} />
                          <span>API: {health?.status}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4" style={{ color: '#10b981' }} />
                          <span>DB: {health?.services.database.status} ({health?.services.database.latency})</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span>v{health?.version}</span>
                        </div>
                      </div>
                      <button onClick={fetchHealth} className="text-xs flex items-center gap-1 opacity-50 hover:opacity-100 transition-opacity"
                        style={{ color: 'var(--text-muted)' }}>
                        <RefreshCw className="w-3 h-3" /> Refresh
                      </button>
                    </>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* ── Features ──────────────────────────────────────── */}
        <section className="py-24 px-6 md:px-12">
          <div className="max-w-7xl mx-auto">
            <motion.div
              className="text-center mb-16"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <h2 className="text-4xl md:text-5xl font-bold mb-4 text-white">
                Everything You Need to{' '}
                <span className="block" style={{ background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Code Together
                </span>
              </h2>
              <p className="text-xl max-w-2xl mx-auto" style={{ color: 'var(--text-muted)' }}>
                Built for teams who demand the best. Every feature designed for seamless collaboration.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {features.map((feature, index) => (
                <FeatureCard key={index} {...feature} delay={index * 0.1} />
              ))}
            </div>
          </div>
        </section>

        {/* ── Testimonials ──────────────────────────────────── */}
        <section className="py-24 px-6 md:px-12" style={{ background: 'linear-gradient(180deg, transparent, rgba(99,102,241,0.04), transparent)' }}>
          <div className="max-w-7xl mx-auto">
            <motion.div
              className="text-center mb-16"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <h2 className="text-4xl md:text-5xl font-bold mb-4 text-white">
                Loved by Developers{' '}
                <span className="block" style={{ background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Worldwide
                </span>
              </h2>
              <p className="text-xl max-w-2xl mx-auto" style={{ color: 'var(--text-muted)' }}>
                Join teams already coding better together.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {testimonials.map((t, i) => (
                <TestimonialCard key={i} {...t} />
              ))}
            </div>
          </div>
        </section>

        {/* ── CTA banner ────────────────────────────────────── */}
        <section className="py-24 px-6 md:px-12">
          <div className="max-w-4xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <Card className="overflow-hidden relative"
                style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(168,85,247,0.06) 100%)', border: '1px solid rgba(99,102,241,0.25)' }}>
                <CardContent className="p-10 sm:p-14 text-center relative z-10">
                  <GitBranch className="w-14 h-14 mx-auto mb-6" style={{ color: 'var(--accent-primary)' }} />
                  <h2 className="text-3xl md:text-5xl font-bold mb-5 text-white">
                    Ready to Transform Your Workflow?
                  </h2>
                  <p className="text-xl mb-8 max-w-xl mx-auto" style={{ color: 'var(--text-secondary)' }}>
                    Start coding collaboratively today. No credit card required.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <Button asChild size="xl" className="rounded-full group"
                      style={{ background: 'var(--accent-gradient)' }}>
                      <Link to="/register">
                        Get Started Free
                        <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                      </Link>
                    </Button>
                    <Button asChild variant="outline" size="xl" className="rounded-full">
                      <Link to="/login">Sign In</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* ── Footer ────────────────────────────────────────── */}
        <footer className="py-10 px-6 md:px-12 border-t" style={{ borderColor: 'var(--border-glass)' }}>
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-3">
            <div className="flex items-center gap-3">
              <Code2 className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
              <span className="text-lg font-bold text-white">SyncScript</span>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              © {new Date().getFullYear()} SyncScript. Secured with JSON Web Token Rotation.
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default Landing;
