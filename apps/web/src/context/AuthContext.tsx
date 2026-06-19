import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios, { AxiosInstance } from 'axios';

export interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  apiClient: AxiosInstance;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create custom Axios client for authenticated API requests
const VITE_API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000/api';

export const apiClient = axios.create({
  baseURL: VITE_API_URL,
  withCredentials: true, // Crucial for sending/receiving HTTP-only cookies
  headers: {
    'Content-Type': 'application/json',
  },
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // Sync token to Axios headers
  useEffect(() => {
    const requestInterceptor = apiClient.interceptors.request.use(
      (config) => {
        if (accessToken) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }
        return config;
      },
      (err) => Promise.reject(err)
    );

    return () => {
      apiClient.interceptors.request.eject(requestInterceptor);
    };
  }, [accessToken]);

  // Handle transparent token refreshing on 401 expiry
  useEffect(() => {
    const responseInterceptor = apiClient.interceptors.response.use(
      (response) => response,
      async (err) => {
        const originalRequest = err.config;

        // If error is 401 (Unauthorized) and not already retried
        if (err.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          try {
            // Attempt to refresh the access token using the HTTP-only refresh cookie
            const response = await axios.post(
              `${VITE_API_URL}/auth/refresh`,
              {},
              { withCredentials: true }
            );

            if (response.data && response.data.success) {
              const newAccessToken = response.data.data.accessToken;
              setAccessToken(newAccessToken);

              // Retry the original request with the new access token
              originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
              return apiClient(originalRequest);
            }
          } catch (refreshErr) {
            // Refresh token is expired or invalid -> log out
            setUser(null);
            setAccessToken(null);
            return Promise.reject(refreshErr);
          }
        }
        return Promise.reject(err);
      }
    );

    return () => {
      apiClient.interceptors.response.eject(responseInterceptor);
    };
  }, []);

  // Initial session restoration: check if user is already logged in
  const restoreSession = useCallback(async () => {
    try {
      // Try to get a fresh access token using the HTTP-only cookie
      const refreshRes = await axios.post(
        `${VITE_API_URL}/auth/refresh`,
        {},
        { withCredentials: true }
      );

      if (refreshRes.data && refreshRes.data.success) {
        const token = refreshRes.data.data.accessToken;
        setAccessToken(token);

        // Fetch user profile using the new access token
        const profileRes = await axios.get(`${VITE_API_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (profileRes.data && profileRes.data.success) {
          setUser(profileRes.data.data.user);
        }
      }
    } catch {
      // No active session or refresh expired: fail silently, user starts unauthenticated
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  const login = async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    try {
      const response = await apiClient.post('/auth/login', { email, password });
      if (response.data && response.data.success) {
        const { accessToken: token, user: userData } = response.data.data;
        setAccessToken(token);
        setUser(userData);
      }
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || 'Login failed';
      const errCode = err.response?.data?.error?.code;
      setError(errMsg);
      if (errCode === 'EMAIL_NOT_VERIFIED') {
        const customErr = new Error(errMsg);
        (customErr as any).code = 'EMAIL_NOT_VERIFIED';
        throw customErr;
      }
      throw new Error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, password: string, name: string) => {
    setError(null);
    setLoading(true);
    try {
      await apiClient.post('/auth/register', { email, password, name });
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || 'Registration failed';
      setError(errMsg);
      throw new Error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const verifyEmail = async (email: string, code: string) => {
    setError(null);
    setLoading(true);
    try {
      const response = await apiClient.post('/auth/verify', { email, code });
      if (response.data && response.data.success) {
        const { accessToken: token, user: userData } = response.data.data;
        setAccessToken(token);
        setUser(userData);
      }
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || 'Verification failed';
      setError(errMsg);
      throw new Error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async (email: string) => {
    setError(null);
    setLoading(true);
    try {
      await apiClient.post('/auth/resend-verification', { email });
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || 'Resending code failed';
      setError(errMsg);
      throw new Error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    try {
      // Best-effort backend logout (clears cookie & DB token)
      await apiClient.post('/auth/logout');
    } catch {
      // Suppress backend logout errors
    } finally {
      setAccessToken(null);
      setUser(null);
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        loading,
        error,
        login,
        register,
        verifyEmail,
        resendVerification,
        logout,
        clearError,
        apiClient,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
