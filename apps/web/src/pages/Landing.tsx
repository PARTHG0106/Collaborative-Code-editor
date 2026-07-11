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
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(99, 102, 241, 0.08), transparent 40%)`,
        }}
      />

      <div className="relative z-10">
        {/* Sticky Glassmorphic Header Navigation */}
        <header className="flex justify-between items-center px-4 sm:px-8 py-4 sm:py-5 border-b border-white/5 backdrop-blur-md bg-[#0a0b10]/60 sticky top-0 z-50">
          <div className="flex items-center gap-2">
            <div className="text-xl font-bold bg-gradient-to-r from-primary to-[#a855f7] bg-clip-text text-transparent brand-logo">&lt;/&gt;</div>
            <span className="text-lg sm:text-xl font-bold text-white brand-name">SyncScript</span>
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
                <Link to="/login" className="text-xs sm:text-sm font-medium text-gray-400 hover:text-white transition-colors">
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
                <Badge variant="outline" className="mb-6 px-4 py-2 text-xs sm:text-sm backdrop-blur-sm bg-background/50 border-primary/30 text-white">
                  <Activity className="w-4 h-4 mr-2 inline-block text-green-500 animate-pulse" />
                  All Systems Operational
                </Badge>
              </motion.div>

              <motion.h1
                className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 1 }}
              >
                <span className="block mb-2 sm:mb-4">
                  {"Collaborative Coding,".split(" ").map((word, wordIndex) => (
                    <span key={wordIndex} className="inline-block whitespace-nowrap mr-2 sm:mr-4">
                      {word.split("").map((char, charIndex) => {
                        const absoluteIndex = "Collaborative Coding,".split(" ").slice(0, wordIndex).join(" ").length + charIndex + (wordIndex > 0 ? 1 : 0);
                        return (
                          <motion.span
                            key={charIndex}
                            initial={{ y: 100, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            transition={{
                              delay: absoluteIndex * 0.03,
                              type: "spring",
                              stiffness: 150,
                              damping: 25,
                            }}
                            className="inline-block text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-300"
                          >
                            {char}
                          </motion.span>
                        );
                      })}
                    </span>
                  ))}
                </span>
                <span className="block bg-gradient-to-r from-primary via-primary/80 to-primary bg-clip-text text-transparent leading-tight">
                  {"Perfected in Real-Time".split(" ").map((word, wordIndex) => (
                    <span key={wordIndex} className="inline-block whitespace-nowrap mr-2 sm:mr-4">
                      {word.split("").map((char, charIndex) => {
                        const absoluteIndex = "Perfected in Real-Time".split(" ").slice(0, wordIndex).join(" ").length + charIndex + (wordIndex > 0 ? 1 : 0);
                        return (
                          <motion.span
                            key={charIndex}
                            initial={{ y: 100, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            transition={{
                              delay: 0.5 + absoluteIndex * 0.03,
                              type: "spring",
                              stiffness: 150,
                              damping: 25,
                            }}
                            className="inline-block"
                          >
                            {char}
                          </motion.span>
                        );
                      })}
                    </span>
                  ))}
                </span>
              </motion.h1>

              <motion.p
                className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto leading-relaxed text-gray-400"
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
                      <Button size="lg" variant="outline" className="text-lg px-8 py-6 rounded-full backdrop-blur-sm bg-background/50 text-white border-white/10 hover:bg-white/5">
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
                <Card className="inline-block bg-background/50 backdrop-blur-lg border-border/50 text-left">
                  <CardContent className="flex flex-wrap items-center gap-6 p-6">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-sm font-semibold text-white">Monorepo System Status</span>
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
                          <span>Status: <span className="text-white font-medium">healthy</span></span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          <span>DB: <span className="text-white font-medium">{health?.services.database.status} ({health?.services.database.latency})</span></span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                          <span>Env: <span className="text-white font-medium">{health?.environment}</span></span>
                        </div>
                      </div>
                    )}

                    <div className="h-6 w-px bg-border hidden sm:block" />
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 px-3 text-xs text-muted-foreground hover:text-white rounded-md bg-white/5 border border-white/5 hover:bg-white/10 transition-all"
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
              <h2 className="text-4xl md:text-5xl font-bold mb-4 text-white">
                Everything You Need to
                <span className="block bg-gradient-to-r from-primary to-[#a855f7] bg-clip-text text-transparent">
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
                  <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white">
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
                <span className="text-xl font-bold text-white">SyncScript Platform</span>
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
