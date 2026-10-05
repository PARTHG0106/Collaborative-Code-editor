import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
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
  /**
   * True once the first request has been outstanding long enough that the API
   * is almost certainly cold-starting. Screens can use this to explain the
   * wait instead of showing an unexplained spinner.
   */
  serverWaking: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  googleLogin: (credential: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  refreshAccessToken: () => Promise<string>;
  apiClient: AxiosInstance;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Create custom Axios client for authenticated API requests.
// NOTE: import.meta.env is substituted at BUILD time. If VITE_API_URL is not
// set in the deploying platform's environment, this fallback is compiled into
// the bundle and every visitor's browser will try to call their own machine.
const VITE_API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000/api';

/** How long a cold start is allowed to look silent before we explain it. */
const WAKING_NOTICE_DELAY_MS = 3000;

/**
 * Converts an auth request failure into a message that identifies the class of
 * problem.
 *
 * Previously every failure collapsed into a generic fallback such as
 * 'Login failed'. That fallback can only be reached when err.response is
 * undefined, meaning the request never got a reply: the API is unreachable,
 * the origin is not in the server's CORS allowlist, the browser is offline, or
 * the bundle was built pointing somewhere else entirely. A server that
 * actually rejected the credentials always sends error.message, so the generic
 * text never once meant "wrong password" — but on screen it was
 * indistinguishable from it, which is exactly the wrong thing to be ambiguous
 * about.
 */
function describeAuthError(
  err: any,
  action: string,
): { message: string; code?: string } {
  const responseError = err?.response?.data?.error;

  if (responseError?.message) {
    return { message: responseError.message, code: responseError.code };
  }

  // A reply arrived but carried no error details. Surface the status rather
  // than swallowing it.
  if (err?.response) {
    return {
      message: `${action} failed: the server responded with status ${err.response.status} and no error details.`,
    };
  }

  // No reply at all.
  console.error(
    `${action} failed: no response from ${VITE_API_URL}.`,
    err?.code || err?.message || err,
  );

  return {
    message:
      `Could not reach the server at ${VITE_API_URL}. The request got no response at all, ` +
      `so this is a connection, CORS, or configuration problem rather than a rejected ` +
      `${action.toLowerCase()}. Check the browser console for details.`,
  };
}

/**
 * withCredentials is required: the refresh token lives only in an httpOnly
 * cookie now, so it has to be attached automatically. Nothing reads it in JS.
 */
export const apiClient = axios.create({
  baseURL: VITE_API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

/** Same credential behaviour for the bare calls made outside apiClient. */
const authAxios = axios.create({
  baseURL: VITE_API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * In-flight refresh promise shared across concurrent 401s.
 *
 * The refresh token rotates on every /auth/refresh (the server deletes the old
 * row and issues a new one), so overlapping refreshes race: the first wins and
 * the rest present an already-deleted token and fail. Collapsing all concurrent
 * callers onto a single POST guarantees exactly one refresh per expiry window.
 */
let refreshInFlight: Promise<string> | null = null;

// These responses rotate or clear the same httpOnly cookie. A stale refresh
// must finish before a sign-in or sign-out can write the next session cookie;
// ignoring its access token in React cannot stop the browser applying it.
let sessionCookieQueue: Promise<unknown> = Promise.resolve();
function updateSessionCookie<T>(request: () => Promise<T>): Promise<T> {
  const pending = sessionCookieQueue.then(request);
  sessionCookieQueue = pending.catch(() => undefined);
  return pending;
}

async function performRefresh(): Promise<string> {
  const response = await updateSessionCookie(() => authAxios.post('/auth/refresh'));
  if (response.data && response.data.success) {
    return response.data.data.accessToken as string;
  }
  throw new Error('Refresh did not return a new access token');
}

interface RestoredSession {
  token: string;
  user: User;
}

// This request owns a rotating cookie. Reuse it across effect replays or a
// provider remount, and never abort it before a subsequent sign-in exchange.
let initialRestoreInFlight: Promise<RestoredSession | null> | null = null;
function loadInitialSession(): Promise<RestoredSession | null> {
  if (initialRestoreInFlight) return initialRestoreInFlight;
  const pending = (async () => {
    try {
      const token = await performRefresh();
      const profile = await authAxios.get('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const userData = profile.data?.data?.user;
      if (profile.data?.success !== true || typeof userData?.id !== 'string' ||
        typeof userData.email !== 'string' || typeof userData.name !== 'string') return null;
      return { token, user: userData as User };
    } catch {
      // An absent or expired refresh cookie starts an unauthenticated session.
      return null;
    }
  })();
  initialRestoreInFlight = pending;
  void pending.then(() => { if (initialRestoreInFlight === pending) initialRestoreInFlight = null; });
  return pending;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, updateAccessToken] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const sessionVersionRef = useRef(0);
  const invalidatePendingRefresh = useCallback(() => {
    sessionVersionRef.current += 1;
    refreshInFlight = null;
  }, []);
  const setAccessToken = useCallback((token: string | null) => {
    // HTTP retries and socket handshakes may run before React commits effects.
    accessTokenRef.current = token;
    updateAccessToken(token);
  }, []);
  const [loading, setLoading] = useState<boolean>(true);
  const [serverWaking, setServerWaking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const initialRestorationRef = useRef<Promise<RestoredSession | null> | null>(null);
  const initialRestorationFinishedRef = useRef(false);
  const initialRestorationSupersededRef = useRef(false);
  const pendingAuthOperationsRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const waitForInitialRestoration = useCallback(() => {
    if (!initialRestorationRef.current) {
      initialRestorationRef.current = loadInitialSession().then(session => {
        initialRestorationFinishedRef.current = true;
        return session;
      });
    }
    return initialRestorationRef.current;
  }, []);

  const beginAuthOperation = (supersedesRestoration = false) => {
    pendingAuthOperationsRef.current += 1;
    if (supersedesRestoration) initialRestorationSupersededRef.current = true;
    setLoading(true);
    const wakingTimer = setTimeout(() => {
      if (mountedRef.current) setServerWaking(true);
    }, WAKING_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(wakingTimer);
      pendingAuthOperationsRef.current -= 1;
      if (mountedRef.current && pendingAuthOperationsRef.current === 0 && initialRestorationFinishedRef.current) {
        setServerWaking(false);
        setLoading(false);
      }
    };
  };

  const clearError = useCallback(() => setError(null), []);

  /**
   * Refresh the access token, de-duplicating concurrent callers onto one
   * request. Updates React state with the new token and returns it so the
   * axios interceptor can retry the original request.
   */
  const refreshAccessToken = useCallback(async (): Promise<string> => {
    const sessionVersion = sessionVersionRef.current;
    if (!refreshInFlight) {
      const pending = performRefresh().finally(() => {
        if (refreshInFlight === pending) refreshInFlight = null;
      });
      refreshInFlight = pending;
    }
    const token = await refreshInFlight;
    if (sessionVersion !== sessionVersionRef.current) {
      throw new Error('The signed-in session changed while renewing its token');
    }
    setAccessToken(token);
    return token;
  }, [setAccessToken]);

  // Sync token to Axios headers
  useEffect(() => {
    const requestInterceptor = apiClient.interceptors.request.use(
      (config) => {
        const sessionRequest = config as typeof config & { _authSessionVersion?: number };
        // A delayed retry must never send one account's action as another.
        if (sessionRequest._authSessionVersion !== undefined && sessionRequest._authSessionVersion !== sessionVersionRef.current) {
          throw new Error('The signed-in session changed before this request could be sent');
        }
        sessionRequest._authSessionVersion = sessionVersionRef.current;
        if (accessTokenRef.current) {
          config.headers.Authorization = `Bearer ${accessTokenRef.current}`;
        }
        return config;
      },
      (err) => Promise.reject(err)
    );

    return () => {
      apiClient.interceptors.request.eject(requestInterceptor);
    };
  }, []);

  // Handle transparent token refreshing on 401 expiry
  useEffect(() => {
    const responseInterceptor = apiClient.interceptors.response.use(
      (response) => response,
      async (err) => {
        const originalRequest = err.config;
        const url = originalRequest?.url || '';
        const isPublicAuthEndpoint =
          url.includes('/auth/login') ||
          url.includes('/auth/google') ||
          url.includes('/auth/register') ||
          url.includes('/auth/verify') ||
          url.includes('/auth/resend-verification') ||
          url.includes('/auth/logout') ||
          url.includes('/auth/refresh');

        // If error is 401 (Unauthorized), not already retried, and NOT a public auth endpoint
        if (err.response?.status === 401 && originalRequest && !originalRequest._retry && !isPublicAuthEndpoint) {
          if (originalRequest._authSessionVersion !== sessionVersionRef.current) return Promise.reject(err);
          originalRequest._retry = true;
          const sessionVersion = originalRequest._authSessionVersion;

          try {
            // Single-flight: the IDE fires several requests at once (workspace,
            // files, chat, versions), so an expired token produces a burst of
            // 401s. Refreshing per-request would have each one POST /auth/refresh;
            // the server rotates the refresh token in a transaction that deletes
            // the old row, so only the first succeeds and the rest get a 401 and
            // log the user out mid-session. Share one in-flight refresh promise
            // across all concurrent 401s instead.
            const newAccessToken = await refreshAccessToken();

            // Retry the original request with the new access token
            originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
            return apiClient(originalRequest);
          } catch (refreshErr) {
            // Refresh token is expired or invalid -> log out
            if (sessionVersion === sessionVersionRef.current) {
              invalidatePendingRefresh();
              setUser(null);
              setAccessToken(null);
            }
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

  // Subscribe without making the request itself depend on the effect lifetime:
  // Strict Mode must not rotate the cookie twice, and a canceled subscription
  // must not restore an old account over an explicit sign-in or sign-out.
  useEffect(() => {
    let active = true;
    const sessionVersion = sessionVersionRef.current;
    const wakingTimer = setTimeout(() => { if (active) setServerWaking(true); }, WAKING_NOTICE_DELAY_MS);
    void waitForInitialRestoration().then(session => {
      clearTimeout(wakingTimer);
      if (!active) return;
      if (sessionVersion === sessionVersionRef.current && !initialRestorationSupersededRef.current && session) {
        setAccessToken(session.token);
        setUser(session.user);
      }
      if (pendingAuthOperationsRef.current === 0) {
        setServerWaking(false);
        setLoading(false);
      }
    });
    return () => {
      active = false;
      clearTimeout(wakingTimer);
    };
  }, [waitForInitialRestoration, setAccessToken]);

  const login = async (email: string, password: string) => {
    setError(null);
    const finishOperation = beginAuthOperation(true);
    try {
      await waitForInitialRestoration();
      if (!mountedRef.current) return;
      const response = await updateSessionCookie(() => apiClient.post('/auth/login', { email, password }));
      if (response.data && response.data.success) {
        const { accessToken: token, user: userData } = response.data.data;
        invalidatePendingRefresh();
        setAccessToken(token);
        setUser(userData);
      }
    } catch (err: any) {
      const { message, code } = describeAuthError(err, 'Sign in');
      setError(message);
      if (code === 'EMAIL_NOT_VERIFIED') {
        const customErr = new Error(message);
        (customErr as any).code = 'EMAIL_NOT_VERIFIED';
        throw customErr;
      }
      throw new Error(message);
    } finally {
      finishOperation();
    }
  };

  const googleLogin = async (credential: string) => {
    setError(null);
    const finishOperation = beginAuthOperation(true);
    try {
      await waitForInitialRestoration();
      if (!mountedRef.current) return;
      const response = await updateSessionCookie(() => apiClient.post('/auth/google', { credential }));
      const data = response.data?.data;
      if (response.data?.success !== true || typeof data?.accessToken !== 'string' || !data.accessToken ||
        typeof data?.user?.id !== 'string' || typeof data.user.email !== 'string' || typeof data.user.name !== 'string') {
        throw new Error('Google sign-in returned an incomplete response. Please try again.');
      }
      invalidatePendingRefresh();
      setAccessToken(data.accessToken);
      setUser(data.user);
    } catch (err: unknown) {
      // Never log an Axios error here: its request body contains a credential.
      const message = axios.isAxiosError(err)
        ? (typeof err.response?.data?.error?.message === 'string'
          ? err.response.data.error.message
          : (err.response ? 'Google sign-in failed. Please try again.' : 'Google sign-in could not reach the server. Please try again.'))
        : (err instanceof Error ? err.message : 'Google sign-in failed. Please try again.');
      setError(message);
      throw new Error(message);
    } finally {
      finishOperation();
    }
  };

  const register = async (email: string, password: string, name: string) => {
    setError(null);
    const finishOperation = beginAuthOperation();
    try {
      await apiClient.post('/auth/register', { email, password, name });
    } catch (err: any) {
      const { message } = describeAuthError(err, 'Registration');
      setError(message);
      throw new Error(message);
    } finally {
      finishOperation();
    }
  };

  const verifyEmail = async (email: string, code: string) => {
    setError(null);
    const finishOperation = beginAuthOperation(true);
    try {
      await waitForInitialRestoration();
      if (!mountedRef.current) return;
      const response = await updateSessionCookie(() => apiClient.post('/auth/verify', { email, code }));
      if (response.data && response.data.success) {
        const { accessToken: token, user: userData } = response.data.data;
        invalidatePendingRefresh();
        setAccessToken(token);
        setUser(userData);
      }
    } catch (err: any) {
      const { message } = describeAuthError(err, 'Verification');
      setError(message);
      throw new Error(message);
    } finally {
      finishOperation();
    }
  };

  const resendVerification = async (email: string) => {
    setError(null);
    const finishOperation = beginAuthOperation();
    try {
      await apiClient.post('/auth/resend-verification', { email });
    } catch (err: any) {
      const { message } = describeAuthError(err, 'Resending the code');
      setError(message);
      throw new Error(message);
    } finally {
      finishOperation();
    }
  };

  const logout = async () => {
    const finishOperation = beginAuthOperation(true);
    try {
      await waitForInitialRestoration();
      if (!mountedRef.current) return;
      // The cookie identifies the session; the server revokes it and clears it.
      await updateSessionCookie(() => apiClient.post('/auth/logout'));
    } catch {
      // Suppress backend logout errors
    } finally {
      invalidatePendingRefresh();
      setAccessToken(null);
      setUser(null);
      finishOperation();
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        loading,
        serverWaking,
        error,
        login,
        googleLogin,
        register,
        verifyEmail,
        resendVerification,
        logout,
        clearError,
        refreshAccessToken,
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
