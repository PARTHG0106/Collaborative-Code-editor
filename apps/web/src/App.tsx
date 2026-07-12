import React from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import VerifyEmail from './pages/VerifyEmail';
import Dashboard from './pages/Dashboard';
import { IDELayout } from './components/ide/IDELayout';
import { FloatingPaths } from './components/ui/FloatingPaths';
import { SpeedInsights } from '@vercel/speed-insights/react';
import './App.css';

// Wrapper to extract route params and pass to IDELayout
const WorkspacePage: React.FC = () => {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  if (!workspaceId) return null;
  return <IDELayout workspaceId={workspaceId} onBack={() => navigate('/dashboard')} />;
};

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* IDE Route - full screen, no floating paths */}
          <Route
            path="/workspace/:workspaceId"
            element={
              <ProtectedRoute>
                <WorkspacePage />
              </ProtectedRoute>
            }
          />

          {/* Standard routes with floating paths background */}
          <Route
            path="*"
            element={
              <div className="min-h-screen w-full bg-[var(--bg-primary)] overflow-hidden relative">
                <div className="absolute inset-0 z-0 pointer-events-none">
                  <FloatingPaths position={1} />
                  <FloatingPaths position={-1} />
                </div>
                <div className="relative z-10 w-full min-h-screen flex flex-col">
                  <Routes>
                    <Route path="/" element={<Landing />} />
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    <Route
                      path="/dashboard"
                      element={
                        <ProtectedRoute>
                          <Dashboard />
                        </ProtectedRoute>
                      }
                    />
                  </Routes>
                </div>
              </div>
            }
          />
        </Routes>
        <SpeedInsights />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

