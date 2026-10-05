import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './GoogleSignIn.css';

interface GoogleCredential {
  credential?: string;
}

interface GoogleIdentity {
  initialize: (options: {
    client_id: string;
    nonce: string;
    callback: (response: GoogleCredential) => void;
    auto_select: false;
    ux_mode: 'popup';
  }) => void;
  renderButton: (element: HTMLElement, options: {
    type: 'standard';
    theme: 'outline' | 'filled_black';
    size: 'large';
    text: 'continue_with';
    shape: 'rectangular';
    width: number;
    logo_alignment: 'left';
  }) => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdentity } };
  }
}

let identityScript: Promise<GoogleIdentity> | null = null;
// A response sets the nonce cookie. Keep requests in order even when an auth
// page is replaced while its request is pending, including React Strict Mode.
let challengeQueue: Promise<unknown> = Promise.resolve();

function loadGoogleIdentity(): Promise<GoogleIdentity> {
  if (window.google?.accounts.id) return Promise.resolve(window.google.accounts.id);
  if (identityScript) return identityScript;

  const pending = new Promise<GoogleIdentity>((resolve, reject) => {
    const existing = document.getElementById('syncscript-google-identity') as HTMLScriptElement | null;
    const script = existing || document.createElement('script');
    const cleanup = () => {
      window.clearTimeout(timeout);
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
    };
    const failed = () => {
      cleanup();
      script.remove();
      reject(new Error('Google sign-in could not load. You can try again or use email.'));
    };
    const loaded = () => {
      if (!window.google?.accounts.id) return failed();
      cleanup();
      resolve(window.google.accounts.id);
    };
    const timeout = window.setTimeout(failed, 12000);
    script.addEventListener('load', loaded);
    script.addEventListener('error', failed);
    if (!existing) {
      script.id = 'syncscript-google-identity';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      document.head.appendChild(script);
    }
  });
  identityScript = pending;
  const clearPending = () => { if (identityScript === pending) identityScript = null; };
  void pending.then(clearPending, clearPending);
  return pending;
}

interface GoogleSignInProps {
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onStart: () => void;
  onError: (message: string) => void;
  onSuccess: () => void;
}

export function GoogleSignIn(props: GoogleSignInProps) {
  const { apiClient, googleLogin } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'hidden' | 'ready' | 'pending' | 'failed'>('loading');
  const [setupError, setSetupError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false);
  const latest = useRef({ ...props, googleLogin });
  latest.current = { ...props, googleLogin };

  useEffect(() => {
    let active = true;
    let credentialReceived = false;
    let resizeObserver: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    const controller = new AbortController();
    const host = hostRef.current;
    setStatus('loading');
    setSetupError(null);

    const prepare = async () => {
      try {
        const config = await apiClient.get('/auth/google/config', { signal: controller.signal, timeout: 15000 });
        if (!active) return;
        const clientId: unknown = config.data?.data?.clientId;
        if (config.data?.success !== true || (clientId !== null && (typeof clientId !== 'string' || !clientId))) {
          throw new Error('Google sign-in is unavailable. You can try again or use email.');
        }
        if (clientId === null) {
          setStatus('hidden');
          return;
        }
        const identity = await loadGoogleIdentity();
        if (!active) return;
        const challenge = challengeQueue.then(async () => {
          if (!active) return null;
          // Do not abort this POST: its response sets a cookie. The next page
          // waits for it before issuing a challenge of its own.
          return apiClient.post('/auth/google/challenge', {}, { timeout: 15000 });
        });
        challengeQueue = challenge.catch(() => undefined);
        const response = await challenge;
        if (!active || !host) return;
        const nonce: unknown = response?.data?.data?.nonce;
        if (response?.data?.success !== true || typeof nonce !== 'string' || !nonce) {
          throw new Error('Google sign-in is unavailable. You can try again or use email.');
        }
        identity.initialize({
          client_id: clientId as string,
          nonce,
          auto_select: false,
          ux_mode: 'popup',
          callback: (result) => {
            if (!active || latest.current.disabled || pendingRef.current || credentialReceived) return;
            credentialReceived = true;
            if (!result.credential) {
              latest.current.onError('Google did not return a sign-in credential. Please try again.');
              setStatus('failed');
              return;
            }
            pendingRef.current = true;
            setStatus('pending');
            latest.current.onStart();
            latest.current.onPendingChange(true);
            const exchange = latest.current.googleLogin(result.credential);
            // The exchange clears the challenge cookie. A newly mounted auth
            // page must wait for it before asking for its own nonce cookie.
            challengeQueue = exchange.catch(() => undefined);
            void exchange.then(() => {
              if (active) latest.current.onSuccess();
            }).catch((error: unknown) => {
              if (!active) return;
              latest.current.onError(error instanceof Error ? error.message : 'Google sign-in failed. Please try again.');
              setStatus('failed');
            }).finally(() => {
              pendingRef.current = false;
              if (active) latest.current.onPendingChange(false);
            });
          },
        });
        let renderedAppearance = '';
        const renderButton = () => {
          if (!active) return;
          const theme = document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline';
          const width = Math.min(400, Math.max(200, Math.floor(host.getBoundingClientRect().width || 380)));
          const appearance = `${theme}:${width}`;
          if (appearance === renderedAppearance) return;
          renderedAppearance = appearance;
          host.replaceChildren();
          identity.renderButton(host, {
            type: 'standard', theme, size: 'large', text: 'continue_with',
            shape: 'rectangular', width, logo_alignment: 'left',
          });
        };
        renderButton();
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(renderButton);
          resizeObserver.observe(host);
        }
        themeObserver = new MutationObserver(renderButton);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        setStatus('ready');
      } catch (error: unknown) {
        if (!active) return;
        setSetupError(error instanceof Error && !('isAxiosError' in error)
          ? error.message
          : 'Google sign-in is unavailable. You can try again or use email.');
        setStatus('failed');
      }
    };
    void prepare();
    return () => {
      active = false;
      controller.abort();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      host?.replaceChildren();
    };
  }, [apiClient, attempt]);

  useEffect(() => {
    if (hostRef.current) hostRef.current.inert = props.disabled || status !== 'ready';
  }, [props.disabled, status]);

  // Keep the SDK host mounted during preparation so it has the final width.
  return (
    <div className="google-sign-in" hidden={status === 'hidden'}>
      <div className="google-sign-in-button" ref={hostRef} hidden={status === 'failed'} aria-disabled={props.disabled || status !== 'ready'} />
      {status === 'loading' && <p className="google-sign-in-status" role="status">Loading Google sign-in…</p>}
      {status === 'pending' && <p className="google-sign-in-status" role="status">Signing in with Google…</p>}
      {setupError && <p className="google-sign-in-error" role="alert">{setupError}</p>}
      {status === 'failed' && (
        <button type="button" className="site-button google-sign-in-retry" disabled={props.disabled} onClick={() => { latest.current.onStart(); setAttempt(value => value + 1); }}>
          Retry Google sign-in
        </button>
      )}
      <div className="google-sign-in-divider" aria-hidden="true"><span>or</span></div>
    </div>
  );
}
