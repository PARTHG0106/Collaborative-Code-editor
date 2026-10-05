import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, apiClient, useAuth } from './AuthContext';

const { adapter } = vi.hoisted(() => ({ adapter: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: (config: any) => actual.default.create({ ...config, adapter }),
    },
  };
});

let auth: ReturnType<typeof useAuth>;
function Probe() { auth = useAuth(); return null; }
const response = (config: any, data: unknown) => ({ data, config, status: 200, statusText: 'OK', headers: new AxiosHeaders() });
const user = { id: 'self', name: 'Self', email: 'self@example.com' };
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  adapter.mockReset();
  adapter.mockImplementation(async config => {
    if (config.url === '/auth/refresh') return response(config, { success: true, data: { accessToken: 'initial-token' } });
    if (config.url === '/auth/me') return response(config, { success: true, data: { user } });
    return response(config, { success: true });
  });
});

async function restoreSession() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => { expect(auth.loading).toBe(false); });
  expect(auth.accessToken).toBe('initial-token');
}

describe('AuthContext refresh', () => {
  it('shares the initial cookie restoration across Strict Mode effect replays', async () => {
    const pendingRefresh = deferred();
    adapter.mockImplementation(async config => config.url === '/auth/refresh'
      ? pendingRefresh.promise
      : response(config, { success: true, data: { user } }));
    render(<React.StrictMode><AuthProvider><Probe /></AuthProvider></React.StrictMode>);
    await waitFor(() => expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/refresh')).toHaveLength(1));
    expect(auth.loading).toBe(true);
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'restored-token' } }));
    });
    await waitFor(() => expect(auth.loading).toBe(false));
    expect(auth.user).toEqual(user);
    expect(auth.accessToken).toBe('restored-token');
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/auth/refresh', '/auth/me']);
  });

  it('uses the refreshed token for a 401 retry before React effects commit', async () => {
    await restoreSession();
    const sentTokens: string[] = [];
    adapter.mockImplementation(async config => {
      if (config.url === '/auth/refresh') return response(config, { success: true, data: { accessToken: 'renewed-token' } });
      sentTokens.push(config.headers.Authorization);
      if (config.headers.Authorization !== 'Bearer renewed-token') {
        throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
          ...response(config, {}), status: 401,
        });
      }
      return response(config, { success: true });
    });

    await act(async () => { await apiClient.get('/protected'); });

    expect(sentTokens).toEqual(['Bearer initial-token', 'Bearer renewed-token']);
    expect(auth.accessToken).toBe('renewed-token');
  });

  it('waits for a pending refresh cookie before clearing the session on logout', async () => {
    await restoreSession();
    const pendingRefresh = deferred();
    adapter.mockImplementation(async config => config.url === '/auth/refresh'
      ? pendingRefresh.promise
      : response(config, { success: true }));
    let renewal!: Promise<string>;
    await act(async () => { renewal = auth.refreshAccessToken(); });
    // Attach the rejection handler before the deferred request settles.
    const settled = renewal.catch(() => null);
    let logout!: Promise<void>;
    await act(async () => { logout = auth.logout(); });
    expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/logout')).toHaveLength(0);
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'late-token' } }));
      await settled;
      await logout;
    });
    expect(auth.user).toBeNull();
    expect(auth.accessToken).toBeNull();
  });

  it('finishes an old refresh before a different account can set its session cookie', async () => {
    await restoreSession();
    adapter.mockClear();
    const pendingRefresh = deferred();
    const nextUser = { id: 'next-user', name: 'Next', email: 'next@example.com' };
    adapter.mockImplementation(async config => {
      if (config.url === '/auth/refresh') return pendingRefresh.promise;
      if (config.url === '/auth/login') return response(config, { success: true, data: { user: nextUser, accessToken: 'next-user-token' } });
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, {}), status: 401 });
    });
    let request!: Promise<unknown>;
    await act(async () => { request = apiClient.get('/protected').catch(error => error); });
    await waitFor(() => { expect(adapter.mock.calls.some(([config]) => config.url === '/auth/refresh')).toBe(true); });
    let login!: Promise<void>;
    await act(async () => { login = auth.login('next@example.com', 'password'); });
    expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/login')).toHaveLength(0);
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'old-account-token' } }));
      await request;
      await login;
    });
    expect(auth.user).toEqual(nextUser);
    expect(auth.accessToken).toBe('next-user-token');
  });

  it('shares one refresh between concurrent HTTP failures and the socket', async () => {
    await restoreSession();
    adapter.mockClear();
    const pendingRefresh = deferred();
    adapter.mockImplementation(async config => {
      if (config.url === '/auth/refresh') return pendingRefresh.promise;
      if (config.headers.Authorization === 'Bearer shared-token') return response(config, { success: true });
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, {}), status: 401 });
    });
    let requests!: Promise<unknown[]>;
    await act(async () => {
      requests = Promise.all([apiClient.get('/protected-a'), apiClient.get('/protected-b'), auth.refreshAccessToken()]);
    });
    await waitFor(() => { expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/refresh')).toHaveLength(1); });
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'shared-token' } }));
      await requests;
    });
    expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/refresh')).toHaveLength(1);
    expect(auth.accessToken).toBe('shared-token');
  });

  it('does not retry an old account request when its 401 arrives after a different account signs in', async () => {
    await restoreSession();
    adapter.mockClear();
    const oldResponse = deferred();
    const sentTokens: string[] = [];
    const nextUser = { id: 'next-user', name: 'Next', email: 'next@example.com' };
    adapter.mockImplementation(async config => {
      if (config.url === '/auth/login') return response(config, { success: true, data: { user: nextUser, accessToken: 'next-user-token' } });
      if (config.url === '/auth/refresh') return response(config, { success: true, data: { accessToken: 'next-user-token' } });
      sentTokens.push(config.headers.Authorization);
      if (config.headers.Authorization === 'Bearer initial-token') {
        await oldResponse.promise;
        throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, {}), status: 401 });
      }
      return response(config, { success: true });
    });
    let request!: Promise<unknown>;
    await act(async () => { request = apiClient.post('/protected-action').catch(error => error); });
    await act(async () => { await auth.login('next@example.com', 'password'); });
    await act(async () => { oldResponse.resolve(undefined); await request; });

    expect(sentTokens).toEqual(['Bearer initial-token']);
    expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/refresh')).toHaveLength(0);
    expect(auth.user).toEqual(nextUser);
    expect(auth.accessToken).toBe('next-user-token');
  });

  it('clears local state after a rejected logout without refreshing the session', async () => {
    await restoreSession();
    adapter.mockClear();
    adapter.mockImplementation(async config => {
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { ...response(config, {}), status: 401 });
    });
    await act(async () => { await auth.logout(); });
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/auth/logout']);
    expect(auth.user).toBeNull();
    expect(auth.accessToken).toBeNull();
  });
});

describe('AuthContext Google sign-in', () => {
  it('waits for initial restoration without publishing the old account over a pending Google sign-in', async () => {
    const initialRefresh = deferred();
    const googleExchange = deferred();
    const googleUser = { id: 'google-user', email: 'google@example.com', name: 'Google User' };
    adapter.mockImplementation(async config => {
      if (config.url === '/auth/refresh') return initialRefresh.promise;
      if (config.url === '/auth/google') return googleExchange.promise;
      return response(config, { success: true, data: { user } });
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    let login!: Promise<void>;
    await act(async () => { login = auth.googleLogin('credential'); });
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/auth/refresh']);
    await act(async () => { initialRefresh.resolve(response({}, { success: true, data: { accessToken: 'old-token' } })); });
    await waitFor(() => expect(adapter.mock.calls.some(([config]) => config.url === '/auth/google')).toBe(true));
    expect(auth.user).toBeNull();
    expect(auth.loading).toBe(true);
    await act(async () => {
      googleExchange.resolve(response({}, { success: true, data: { accessToken: 'google-token', user: googleUser } }));
      await login;
    });
    expect(auth.user).toEqual(googleUser);
    expect(auth.accessToken).toBe('google-token');
    expect(auth.loading).toBe(false);
  });

  it('exchanges the credential with cookies and stores the validated session in memory', async () => {
    await restoreSession();
    const googleUser = { id: 'google-user', email: 'google@example.com', name: 'Google User' };
    adapter.mockResolvedValue(response({}, { success: true, data: { accessToken: 'google-access-token', user: googleUser } }));
    await act(async () => auth.googleLogin('signed-credential'));
    const request = adapter.mock.calls.find(([config]) => config.url === '/auth/google')![0];
    expect(JSON.parse(request.data)).toEqual({ credential: 'signed-credential' });
    expect(request.withCredentials).toBe(true);
    expect(auth.user).toEqual(googleUser);
    expect(auth.accessToken).toBe('google-access-token');
    expect(auth.loading).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    { success: false },
    { success: true, data: {} },
    { success: true, data: { accessToken: 'incomplete', user: { id: 'id' } } },
  ])('does not treat incomplete Google responses as a successful sign-in: %j', async data => {
    await restoreSession();
    adapter.mockResolvedValue(response({}, data));
    await act(async () => { await expect(auth.googleLogin('credential')).rejects.toThrow('incomplete response'); });
    expect(auth.user).toEqual(user);
    expect(auth.accessToken).toBe('initial-token');
    expect(auth.loading).toBe(false);
  });

  it('does not refresh or clear an existing session when Google rejects a credential', async () => {
    await restoreSession();
    adapter.mockClear();
    adapter.mockImplementation(async config => {
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
        ...response(config, { success: false, error: { message: 'Google sign-in expired. Please try again.' } }), status: 401,
      });
    });
    await act(async () => { await expect(auth.googleLogin('expired')).rejects.toThrow('Google sign-in expired'); });
    expect(auth.error).toBe('Google sign-in expired. Please try again.');
    expect(auth.user).toEqual(user);
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/auth/google']);
  });

  it('waits for an old refresh cookie before a Google account signs in', async () => {
    await restoreSession();
    const pendingRefresh = deferred();
    const googleUser = { id: 'google-user', email: 'google@example.com', name: 'Google User' };
    adapter.mockImplementation(async config => config.url === '/auth/refresh'
      ? pendingRefresh.promise
      : response(config, { success: true, data: { accessToken: 'google-token', user: googleUser } }));
    let renewal!: Promise<string | null>;
    await act(async () => { renewal = auth.refreshAccessToken().catch(() => null); });
    let login!: Promise<void>;
    await act(async () => { login = auth.googleLogin('credential'); });
    expect(adapter.mock.calls.filter(([config]) => config.url === '/auth/google')).toHaveLength(0);
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'old-token' } }));
      await renewal;
      await login;
    });
    expect(auth.user).toEqual(googleUser);
    expect(auth.accessToken).toBe('google-token');
  });

  it('holds a newly requested refresh until the Google exchange has set its cookie', async () => {
    await restoreSession();
    adapter.mockClear();
    const googleExchange = deferred();
    const googleUser = { id: 'google-user', email: 'google@example.com', name: 'Google User' };
    adapter.mockImplementation(async config => config.url === '/auth/google'
      ? googleExchange.promise
      : response(config, { success: true, data: { accessToken: 'google-renewed-token' } }));
    let login!: Promise<void>;
    let renewal!: Promise<string | null>;
    await act(async () => { login = auth.googleLogin('credential'); });
    await waitFor(() => expect(adapter.mock.calls.some(([config]) => config.url === '/auth/google')).toBe(true));
    await act(async () => { renewal = auth.refreshAccessToken().catch(() => null); });
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/auth/google']);
    await act(async () => {
      googleExchange.resolve(response({}, { success: true, data: { accessToken: 'google-token', user: googleUser } }));
      await login;
      await renewal;
    });
    expect(adapter.mock.calls.map(([config]) => config.url)).toEqual(['/auth/google', '/auth/refresh']);
    expect(auth.user).toEqual(googleUser);
    expect(auth.accessToken).toBe('google-token');
  });
});
