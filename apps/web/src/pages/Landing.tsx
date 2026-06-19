import React, { useRef, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import axios from "axios";
import { useAuth } from "../context/AuthContext";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
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
  AlertCircle
} from "lucide-react";

interface HealthData {
  status: string;
  timestamp: string;
  uptime: number;
  environment: string;
  version: string;
  services: {
    database: {
      status: string;
      latency: string;
    };
  };
}

function FloatingPaths({ position }: { position: number }) {
  const paths = Array.from({ length: 36 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position} -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${152 - i * 5 * position} ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${684 - i * 5 * position} ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    width: 0.5 + i * 0.03,
  }));

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <svg className="w-full h-full text-slate-950 dark:text-white" viewBox="0 0 696 316" fill="none">
        <title>Background Paths</title>
        {paths.map((path) => (
          <motion.path
            key={path.id}
            d={path.d}
            stroke="currentColor"
            strokeWidth={path.width}
            strokeOpacity={0.1 + path.id * 0.03}
            initial={{ pathLength: 0.3, opacity: 0.6 }}
            animate={{
              pathLength: 1,
              opacity: [0.3, 0.6, 0.3],
              pathOffset: [0, 1, 0],
            }}
            transition={{
              duration: 20 + Math.random() * 10,
              repeat: Infinity,
              ease: "linear",
            }}
          />
        ))}
      </svg>
    </div>
  );
}

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  delay: number;
}

function FeatureCard({ icon, title, description, delay }: FeatureCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6, delay }}
    >
      <Card className="bg-background/50 backdrop-blur-lg border-border/50 hover:border-primary/50 transition-all duration-300 hover:shadow-lg hover:shadow-primary/10 group">
        <CardHeader>
          <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
            {icon}
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription className="text-base">{description}</CardDescription>
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface TestimonialCardProps {
  name: string;
  role: string;
  content: string;
  avatar: string;
  delay: number;
}

function TestimonialCard({ name, role, content, avatar, delay }: TestimonialCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay }}
    >
      <Card className="bg-background/50 backdrop-blur-lg border-border/50 h-full">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4 mb-4">
            <Avatar>
              <AvatarImage src={avatar} alt={name} />
              <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-semibold">{name}</p>
              <p className="text-sm text-muted-foreground">{role}</p>
            </div>
          </div>
          <p className="text-muted-foreground italic">"{content}"</p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export const Landing: React.FC = () => {
  const { user } = useAuth();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get('/api/health');
      if (response.data && response.data.success) {
        setHealth(response.data.data);
      } else {
        throw new Error('Invalid health check response');
      }
    } catch (err) {
      const errorMsg = axios.isAxiosError(err)
        ? err.response?.data?.error?.message
        : err instanceof Error
          ? err.message
          : 'Failed to fetch server health';
      setError(errorMsg || 'Failed to fetch server health');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  const features = [
    {
      icon: <Code2 className="w-6 h-6 text-primary" />,
      title: "Real-Time Sync",
      description: "Code together in real-time with zero latency. See changes instantly as your team collaborates.",
    },
    {
      icon: <Users className="w-6 h-6 text-primary" />,
      title: "Team Workspaces",
      description: "Organize projects into workspaces with role-based access control and team management.",
    },
    {
      icon: <History className="w-6 h-6 text-primary" />,
      title: "Version History",
      description: "Never lose work with automatic version control. Restore any previous state with one click.",
    },
    {
      icon: <MessageSquare className="w-6 h-6 text-primary" />,
      title: "Live Chat",
      description: "Built-in chat and comments keep conversations in context, right next to your code.",
    },
    {
      icon: <Zap className="w-6 h-6 text-primary" />,
      title: "Lightning Fast",
      description: "Optimized for performance with instant loading and smooth editing experience.",
    },
    {
      icon: <Shield className="w-6 h-6 text-primary" />,
      title: "Secure & Private",
      description: "Enterprise-grade security with end-to-end encryption and SOC 2 compliance.",
    },
  ];

  const testimonials = [
    {
      name: "Sarah Chen",
      role: "Lead Developer at TechCorp",
      content: "SyncScript transformed how our team collaborates. The real-time sync is flawless!",
      avatar: "/avatars/sarah.jpg",
    },
    {
      name: "Marcus Johnson",
      role: "CTO at StartupXYZ",
      content: "Best collaborative coding tool we've used. The version history saved us countless times.",
      avatar: "/avatars/marcus.jpg",
    },
    {
      name: "Emily Rodriguez",
      role: "Senior Engineer at DevHub",
      content: "The live chat feature keeps our team connected. No more context switching!",
      avatar: "/avatars/emily.jpg",
    },
  ];

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-[#0a0b10] via-[#0a0b10] to-[#6366f1]/10 overflow-hidden relative">
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(99, 102, 241, 0.1), transparent 40%)`,
        }}
      />

      <div className="absolute inset-0">
        <FloatingPaths position={1} />
        <FloatingPaths position={-1} />
      </div>

      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Navigation Header */}
        <header className="flex justify-between items-center px-8 py-5 border-b border-white/5 backdrop-blur-md bg-[#0a0b10]/60 sticky top-0 z-50">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold bg-gradient-to-r from-[#6366f1] to-[#a855f7] bg-clip-text text-transparent brand-logo">&lt;/&gt;</div>
            <span className="text-xl font-bold text-white brand-name">SyncScript</span>
          </div>
          <nav className="header-nav">
            {user ? (
              <Link to="/dashboard">
                <Button variant="secondary" size="sm">
                  Dashboard
                </Button>
              </Link>
            ) : (
              <div className="flex gap-4 items-center">
                <Link to="/login" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">
                  Sign In
                </Link>
                <Link to="/register">
                  <Button size="sm">Sign Up</Button>
                </Link>
              </div>
            )}
          </nav>
        </header>

        {/* Hero Section */}
        <main className="flex-grow">
          <section className="pt-20 pb-16 px-4 md:px-6">
            <div className="container mx-auto max-w-7xl">
              <div className="text-center space-y-8">
                <motion.div
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6 }}
                >
                  <Badge variant="outline" className="mb-6 px-4 py-1.5 text-sm backdrop-blur-sm bg-black/40 border-[#6366f1]/30">
                    <Activity className="w-4 h-4 mr-2 inline-block text-green-500 animate-pulse" />
                    Production Ready: Real-time collaborative workspace environment active!
                  </Badge>
                </motion.div>

                <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter text-white">
                  <span className="block mb-4">
                    {"Collaborative Coding,".split("").map((char, i) => (
                      <motion.span
                        key={i}
                        initial={{ y: 100, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{
                          delay: i * 0.03,
                          type: "spring",
                          stiffness: 150,
                          damping: 25,
                        }}
                        className="inline-block"
                      >
                        {char === " " ? "\u00A0" : char}
                      </motion.span>
                    ))}
                  </span>
                  <span className="block bg-gradient-to-r from-[#6366f1] via-[#a855f7] to-[#6366f1] bg-clip-text text-transparent">
                    {"Perfected in Real-Time".split("").map((char, i) => (
                      <motion.span
                        key={i}
                        initial={{ y: 100, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{
                          delay: 0.5 + i * 0.03,
                          type: "spring",
                          stiffness: 150,
                          damping: 25,
                        }}
                        className="inline-block"
                      >
                        {char === " " ? "\u00A0" : char}
                      </motion.span>
                    ))}
                  </span>
                </h1>

                <motion.p
                  className="text-xl md:text-2xl text-gray-400 max-w-3xl mx-auto leading-relaxed"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 1 }}
                >
                  The most powerful collaborative code editor for modern teams. Write, review, and ship code together in real-time.
                </motion.p>

                <motion.div
                  className="flex flex-col sm:flex-row gap-4 justify-center items-center pt-4"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 1.2 }}
                >
                  {user ? (
                    <Link to="/dashboard">
                      <Button size="lg" className="text-lg px-8 py-6 rounded-full group">
                        Go to Dashboard
                        <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                      </Button>
                    </Link>
                  ) : (
                    <>
                      <Link to="/register">
                        <Button size="lg" className="text-lg px-8 py-6 rounded-full group">
                          <Sparkles className="w-5 h-5 mr-2" />
                          Start Coding Free
                          <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                        </Button>
                      </Link>
                      <Link to="/login">
                        <Button size="lg" variant="outline" className="text-lg px-8 py-6 rounded-full backdrop-blur-sm bg-black/40 border-white/10 hover:bg-white/5 text-white">
                          Sign In
                        </Button>
                      </Link>
                    </>
                  )}
                </motion.div>

                {/* API System Status Box */}
                <motion.div
                  className="pt-8 flex justify-center"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.6, delay: 1.4 }}
                >
                  <Card className="bg-black/40 backdrop-blur-lg border-white/10 max-w-lg w-full text-left">
                    <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-white/5 px-6 pt-5">
                      <div className="flex items-center gap-2">
                        <Activity size={18} className="text-[#6366f1]" />
                        <CardTitle className="text-sm font-semibold text-white">Monorepo System Status</CardTitle>
                      </div>
                      <Button variant="ghost" size="sm" className="h-8 text-xs text-gray-400 hover:text-white" onClick={fetchHealth}>
                        Refresh Health
                      </Button>
                    </CardHeader>
                    <CardContent className="px-6 py-4">
                      {loading ? (
                        <div className="flex flex-col items-center justify-center py-6 gap-2">
                          <div className="w-6 h-6 border-2 border-t-transparent border-[#6366f1] rounded-full animate-spin"></div>
                          <p className="text-xs text-gray-400">Querying API status...</p>
                        </div>
                      ) : error ? (
                        <div className="text-xs space-y-2 py-2">
                          <div className="flex items-center gap-2 text-red-400">
                            <AlertCircle size={14} />
                            <span>Error connecting to the backend services:</span>
                          </div>
                          <code className="block bg-red-950/40 text-red-300 p-2.5 rounded border border-red-900/30 overflow-x-auto font-mono">{error}</code>
                          <p className="text-gray-500">Make sure the backend server is running and the database is configured.</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-y-3 gap-x-6 text-xs text-gray-300">
                          <div>
                            <span className="text-gray-500 block mb-0.5">Status:</span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-green-950/50 border border-green-800/30 text-green-400 capitalize">{health?.status}</span>
                          </div>
                          <div>
                            <span className="text-gray-500 block mb-0.5">Database:</span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded ${health?.services.database.status === 'connected' ? 'bg-green-950/50 border border-green-800/30 text-green-400' : 'bg-red-950/50 border border-red-800/30 text-red-400'}`}>
                              {health?.services.database.status} ({health?.services.database.latency})
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-500 block mb-0.5">Environment:</span>
                            <span className="capitalize text-white font-medium">{health?.environment}</span>
                          </div>
                          <div>
                            <span className="text-gray-500 block mb-0.5">Version:</span>
                            <span className="text-white font-medium">{health?.version}</span>
                          </div>
                          <div className="col-span-2 pt-1 border-t border-white/5">
                            <span className="text-gray-500 mr-2">Last Checked:</span>
                            <span className="font-mono text-gray-400">{health ? new Date(health.timestamp).toLocaleString() : ''}</span>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              </div>
            </div>
          </section>

          {/* Features Grid */}
          <section className="py-24 px-4 md:px-6">
            <div className="container mx-auto max-w-7xl">
              <motion.div
                className="text-center mb-16"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="text-4xl md:text-5xl font-bold mb-4 text-white">
                  Everything You Need to
                  <span className="block bg-gradient-to-r from-[#6366f1] to-[#a855f7] bg-clip-text text-transparent">
                    Code Together
                  </span>
                </h2>
                <p className="text-xl text-gray-400 max-w-2xl mx-auto">
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

          {/* Testimonials */}
          <section className="py-24 px-4 md:px-6 bg-gradient-to-b from-transparent via-[#6366f1]/5 to-transparent">
            <div className="container mx-auto max-w-7xl">
              <motion.div
                className="text-center mb-16"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="text-4xl md:text-5xl font-bold mb-4 text-white">
                  Loved by Developers
                  <span className="block bg-gradient-to-r from-[#6366f1] to-[#a855f7] bg-clip-text text-transparent">
                    Worldwide
                  </span>
                </h2>
                <p className="text-xl text-gray-400 max-w-2xl mx-auto">
                  Join thousands of teams already coding better together.
                </p>
              </motion.div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {testimonials.map((testimonial, index) => (
                  <TestimonialCard key={index} {...testimonial} delay={index * 0.1} />
                ))}
              </div>
            </div>
          </section>

          {/* CTA Banner */}
          <section className="py-24 px-4 md:px-6">
            <div className="container mx-auto max-w-5xl">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <Card className="bg-gradient-to-br from-[#6366f1]/10 via-[#6366f1]/5 to-transparent backdrop-blur-lg border-[#6366f1]/20 overflow-hidden relative">
                  <div className="absolute inset-0 bg-grid-white/5 pointer-events-none" />
                  <CardContent className="p-12 text-center relative z-10">
                    <GitBranch className="w-16 h-16 mx-auto mb-6 text-[#6366f1]" />
                    <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white">
                      Ready to Transform Your Workflow?
                    </h2>
                    <p className="text-xl text-gray-400 mb-8 max-w-2xl mx-auto">
                      Start coding collaboratively today. No credit card required.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-4 justify-center">
                      <Link to="/register">
                        <Button size="lg" className="text-lg px-8 py-6 rounded-full group">
                          Get Started Free
                          <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                        </Button>
                      </Link>
                      <Button size="lg" variant="outline" className="text-lg px-8 py-6 rounded-full backdrop-blur-sm border-white/10 text-white hover:bg-white/5">
                        Schedule Demo
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            </div>
          </section>
        </main>

        <footer className="py-12 px-4 md:px-6 border-t border-white/5">
          <div className="container mx-auto max-w-7xl">
            <div className="flex flex-col md:flex-row justify-between items-center gap-4">
              <div className="flex items-center gap-2">
                <Code2 className="w-6 h-6 text-[#6366f1]" />
                <span className="text-xl font-bold text-white">SyncScript Platform</span>
              </div>
              <p className="text-sm text-gray-400">
                &copy; {new Date().getFullYear()} SyncScript. Made for developers, by developers.
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default Landing;
