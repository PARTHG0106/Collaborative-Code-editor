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

  it('does not restore a token when a pending refresh finishes after logout', async () => {
    await restoreSession();
    const pendingRefresh = deferred();
    adapter.mockImplementation(async config => config.url === '/auth/refresh'
      ? pendingRefresh.promise
      : response(config, { success: true }));
    let renewal!: Promise<string>;
    await act(async () => { renewal = auth.refreshAccessToken(); });
    // Attach the rejection handler before the deferred request settles.
    const settled = renewal.catch(() => null);
    await act(async () => { await auth.logout(); });
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'late-token' } }));
      await settled;
    });
    expect(auth.user).toBeNull();
    expect(auth.accessToken).toBeNull();
  });

  it('does not replace or log out a new account when an old request finishes refreshing', async () => {
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
    await act(async () => { await auth.login('next@example.com', 'password'); });
    await act(async () => {
      pendingRefresh.resolve(response({}, { success: true, data: { accessToken: 'old-account-token' } }));
      await request;
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
});
