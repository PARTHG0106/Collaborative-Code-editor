import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Landing from './pages/Landing';
import Login from './pages/Login';
import { SpeedInsights } from '@vercel/speed-insights/react';
import './App.css';
import './site.css';

// Landing and Login stay in the entry chunk: they are the first paint for a
// cold visitor, so a second network round trip there would be a regression.
//
// Everything below is behind a click or behind auth. The IDE in particular
// pulls in Monaco and xterm, which dominated the entry bundle even though the
// landing page never renders them.
const Register = lazy(() => import('./pages/Register'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const IDELayout = lazy(() =>
  import('./components/ide/IDELayout').then((m) => ({ default: m.IDELayout })),
);

/** Shown while a lazy route chunk is in flight. */
const RouteFallback: React.FC = () => (
  <div className="min-h-screen w-full flex items-center justify-center">
    <div className="site-muted text-sm" role="status">Loading…</div>
  </div>
);

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
                <Suspense fallback={<RouteFallback />}>
                  <WorkspacePage />
                </Suspense>
              </ProtectedRoute>
            }
          />

          {/* Public pages and workspace management share a restrained site theme. */}
          <Route
            path="*"
            element={
              <div className="site-shell">
                  <Suspense fallback={<RouteFallback />}>
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
                  </Suspense>
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
