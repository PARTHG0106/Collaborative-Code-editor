import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import axios from "axios";
import { useAuth, apiClient } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  Code2, 
  Users, 
  History, 
  MessageSquare, 
  Zap, 
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
      className="h-full"
    >
      <Card className="bg-background/50 backdrop-blur-lg border-border/50 hover:border-primary/50 transition-all duration-300 hover:shadow-lg hover:shadow-primary/10 group h-full flex flex-col">
        <CardHeader>
          <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
            {icon}
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex-1">
          <CardDescription className="text-base">{description}</CardDescription>
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
      const response = await apiClient.get('/health');
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
      description: "Code together in real-time with low latency. See changes instantly as your team collaborates.",
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
  ];


  return (
    <div className="min-h-screen w-full relative">
      {/* Mouse gradient effect */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(var(--accent-primary-rgb), 0.08), transparent 40%)`,
        }}
      />

      <div className="relative z-10">
        {/* Sticky Glassmorphic Header Navigation */}
        <header className="flex justify-between items-center px-4 sm:px-8 py-4 sm:py-5 border-b border-[var(--border)] backdrop-blur-md bg-[var(--bg-glass)] sticky top-0 z-50">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] bg-clip-text text-transparent brand-logo">&lt;/&gt;</div>
            <span className="text-lg sm:text-xl font-bold text-[var(--text-primary)] brand-name">SyncScript</span>
          </div>
          <nav className="flex gap-3 sm:gap-4 items-center header-nav">
            {user ? (
              <Link to="/dashboard">
                <Button variant="outline" size="sm" className="backdrop-blur-sm bg-background/50 text-xs sm:text-sm px-2.5 sm:px-4">
                  Dashboard
                </Button>
              </Link>
            ) : (
              <>
                <Link to="/login" className="text-xs sm:text-sm font-medium text-gray-400 hover:text-[var(--text-primary)] transition-colors">
                  Sign In
                </Link>
                <Link to="/register">
                  <Button size="sm" className="text-xs sm:text-sm px-2.5 sm:px-4">Sign Up</Button>
                </Link>
              </>
            )}
          </nav>
        </header>

        {/* Hero Section */}
        <section className="min-h-[calc(100vh-80px)] flex items-center justify-center px-4 md:px-6 relative">
          <div className="container mx-auto max-w-7xl">
            <div className="text-center space-y-8">
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
              >
                <Badge variant="outline" className="mb-6 px-4 py-2 text-xs sm:text-sm backdrop-blur-sm bg-[var(--bg-secondary)]/50 border-[var(--accent-primary)]/30 text-[var(--text-primary)]">
                  <Activity className="w-4 h-4 mr-2 inline-block text-green-500 animate-pulse" />
                  All Systems Operational
                </Badge>
              </motion.div>

              <motion.h1
                className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight mb-6"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8 }}
              >
                <span className="block text-[var(--text-primary)] mb-2">
                  Collaborative Coding,
                </span>
                <span className="block bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] bg-clip-text text-transparent">
                  Perfected in Real-Time
                </span>
              </motion.h1>

              <motion.p
                className="text-lg sm:text-xl md:text-2xl text-[var(--text-secondary)] max-w-3xl mx-auto leading-relaxed mb-10"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.2 }}
              >
                The most powerful collaborative code editor for modern teams. Write, review, and ship code together in real-time, right from your browser.
              </motion.p>

              <motion.div
                className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.4 }}
              >
                {user ? (
                  <Link to="/dashboard">
                    <Button size="lg" className="h-14 px-8 text-base font-medium rounded-full bg-[var(--accent-primary)] hover:bg-[var(--accent-secondary)] text-[var(--bg-primary)] shadow-[var(--shadow-glow)] transition-all">
                      Go to Dashboard
                      <ArrowRight className="w-5 h-5 ml-2" />
                    </Button>
                  </Link>
                ) : (
                  <>
                    <Link to="/register">
                      <Button size="lg" className="h-14 px-8 text-base font-medium rounded-full bg-[var(--accent-primary)] hover:bg-[var(--accent-secondary)] text-[var(--bg-primary)] shadow-[var(--shadow-glow)] transition-all">
                        <Sparkles className="w-5 h-5 mr-2" />
                        Start Coding Free
                      </Button>
                    </Link>
                    <Link to="/login">
                      <Button size="lg" variant="outline" className="h-14 px-8 text-base font-medium rounded-full backdrop-blur-md bg-[var(--bg-glass)] text-[var(--text-primary)] border-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] transition-all">
                        Sign In
                      </Button>
                    </Link>
                  </>
                )}
              </motion.div>

              {/* Mockup visual */}
              <motion.div
                className="relative mx-auto max-w-5xl rounded-xl border border-[var(--border-glass)] bg-[var(--bg-secondary)] shadow-2xl overflow-hidden aspect-[16/9]"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.6 }}
              >
                <div className="flex items-center px-4 h-10 border-b border-[var(--border-glass)] bg-[var(--bg-tertiary)]">
                  <div className="flex space-x-2">
                    <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
                  </div>
                  <div className="mx-auto text-xs font-mono text-[var(--text-muted)]">main.ts - SyncScript</div>
                </div>
                <div className="flex h-[calc(100%-40px)]">
                  <div className="w-16 border-r border-[var(--border-glass)] flex flex-col items-center py-4 space-y-4 text-[var(--text-muted)]">
                    <Code2 size={20} />
                    <GitBranch size={20} />
                  </div>
                  <div className="flex-1 p-6 font-mono text-sm text-[var(--text-secondary)] text-left flex flex-col">
                    <div className="text-[var(--accent-primary)]">import <span className="text-[var(--text-primary)]">{'{'}</span> createCollaboration <span className="text-[var(--text-primary)]">{'}'}</span> from <span className="text-yellow-300/90">{"'syncscript'"}</span>;</div>
                    <br />
                    <div><span className="text-[var(--text-primary)]">const</span> workspace = <span className="text-[var(--accent-primary)]">createCollaboration</span>({'{'}</div>
                    <div className="pl-4">roomId: <span className="text-yellow-300/90">{"'cmqmhod6t000huklzwf8n0rb8'"}</span>,</div>
                    <div className="pl-4">mode: <span className="text-yellow-300/90">{"'real-time'"}</span>,</div>
                    <div className="pl-4">latency: <span className="text-blue-400">0.01</span> <span className="text-[var(--text-muted)]">{'// ultra-low latency'}</span></div>
                    <div>{'}'});</div>
                    <br />
                    <div className="flex items-center text-[var(--text-primary)]">
                      <span className="w-2 h-5 bg-[var(--accent-primary)] inline-block mr-1 animate-pulse"></span>
                      {"workspace.on('connect', () => console.log('Ready.'));"}
                    </div>
                  </div>
                </div>
              </motion.div>

              {/* API System Status Box */}
              <motion.div
                className="pt-8 flex justify-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 1.4 }}
              >
                <Card className="inline-block bg-background/50 backdrop-blur-lg border-border/50 text-left">
                  <CardContent className="flex flex-wrap items-center gap-6 p-6">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-sm font-semibold text-[var(--text-primary)]">Monorepo System Status</span>
                    </div>
                    <div className="h-6 w-px bg-border hidden sm:block" />

                    {loading ? (
                      <span className="text-sm text-muted-foreground animate-pulse">Querying API status...</span>
                    ) : error ? (
                      <div className="flex flex-col gap-1 text-xs text-left">
                        <div className="flex items-center gap-1.5 text-red-400">
                          <AlertCircle size={14} />
                          <span>Error connecting to the backend services:</span>
                        </div>
                        <code className="font-mono bg-red-950/30 text-red-300 px-2.5 py-1 rounded border border-red-900/20">{error}</code>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-5 text-sm text-gray-300">
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          <span>Status: <span className="text-[var(--text-primary)] font-medium">healthy</span></span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          <span>DB: <span className="text-[var(--text-primary)] font-medium">{health?.services.database.status} ({health?.services.database.latency})</span></span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          <span>Env: <span className="text-[var(--text-primary)] font-medium">{health?.environment}</span></span>
                        </div>
                      </div>
                    )}

                    <div className="h-6 w-px bg-border hidden sm:block" />
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 px-3 text-xs text-muted-foreground hover:text-[var(--text-primary)] rounded-md bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-all"
                      onClick={fetchHealth}
                    >
                      Refresh Health
                    </Button>
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
              <h2 className="text-4xl md:text-5xl font-bold mb-4 text-[var(--text-primary)]">
                Everything You Need to
                <span className="block bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] bg-clip-text text-transparent">
                  Code Together
                </span>
              </h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
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


        {/* CTA Section */}
        <section className="py-24 px-4 md:px-6">
          <div className="container mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <Card className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent backdrop-blur-lg border-primary/20 overflow-hidden relative">
                <div className="absolute inset-0 bg-grid-white/5 pointer-events-none" />
                <CardContent className="p-12 text-center relative z-10">
                  <GitBranch className="w-16 h-16 mx-auto mb-6 text-primary" />
                  <h2 className="text-4xl md:text-5xl font-bold mb-6 text-[var(--text-primary)]">
                    Ready to Transform Your Workflow?
                  </h2>
                  <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
                    Start coding collaboratively today. No credit card required.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-4 justify-center">
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
                            Get Started Free
                            <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                          </Button>
                        </Link>

                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-12 px-4 md:px-6 border-t border-border/50">
          <div className="container mx-auto max-w-7xl">
            <div className="flex flex-col md:flex-row justify-between items-center gap-4">
              <div className="flex items-center gap-2">
                <Code2 className="w-6 h-6 text-primary" />
                <span className="text-xl font-bold text-[var(--text-primary)]">SyncScript Platform</span>
              </div>
              <p className="text-sm text-muted-foreground">
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
