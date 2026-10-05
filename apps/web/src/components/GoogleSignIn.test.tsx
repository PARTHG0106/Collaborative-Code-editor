import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleSignIn } from './GoogleSignIn';

const auth = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
  googleLogin: vi.fn(),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

type Identity = NonNullable<Window['google']>['accounts']['id'];
type InitializeOptions = Parameters<Identity['initialize']>[0];
const envelope = (data: unknown) => ({ data: { success: true, data } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let initialized: InitializeOptions;
const initialize = vi.fn((options: InitializeOptions) => { initialized = options; });
const renderButton = vi.fn((host: HTMLElement) => {
  const button = document.createElement('button');
  button.textContent = 'Continue with Google';
  host.appendChild(button);
});
const props = {
  disabled: false,
  onPendingChange: vi.fn(),
  onStart: vi.fn(),
  onError: vi.fn(),
  onSuccess: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  document.documentElement.classList.remove('dark');
  delete window.google;
  initialize.mockImplementation(options => { initialized = options; });
  renderButton.mockImplementation(host => {
    const button = document.createElement('button');
    button.textContent = 'Continue with Google';
    host.appendChild(button);
  });
  auth.apiClient.get.mockResolvedValue(envelope({ clientId: 'test.apps.googleusercontent.com' }));
  auth.apiClient.post.mockResolvedValue(envelope({ nonce: 'first-nonce' }));
  auth.googleLogin.mockResolvedValue(undefined);
});

afterEach(async () => {
  cleanup();
  const script = document.getElementById('syncscript-google-identity');
  if (script) fireEvent.error(script);
  script?.remove();
  delete window.google;
  document.documentElement.classList.remove('dark');
  await Promise.resolve();
});

function installSDK() { window.google = { accounts: { id: { initialize, renderButton } } }; }

async function renderReady(overrides: Partial<typeof props> = {}) {
  installSDK();
  const rendered = render(<GoogleSignIn {...props} {...overrides} />);
  await screen.findByRole('button', { name: 'Continue with Google' });
  return rendered;
}

describe('GoogleSignIn', () => {
  it('does not load Google or show an unavailable button when the server is unconfigured', async () => {
    auth.apiClient.get.mockResolvedValue(envelope({ clientId: null }));
    const { container } = render(<GoogleSignIn {...props} />);
    await waitFor(() => expect(container.firstElementChild).not.toBeVisible());
    expect(document.querySelector('script[src="https://accounts.google.com/gsi/client"]')).toBeNull();
    expect(auth.apiClient.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('uses the official button and server nonce, and exchanges each credential only once', async () => {
    document.documentElement.classList.add('dark');
    await renderReady();
    expect(initialized).toMatchObject({ client_id: 'test.apps.googleusercontent.com', nonce: 'first-nonce', auto_select: false, ux_mode: 'popup' });
    expect(renderButton).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ theme: 'filled_black', text: 'continue_with', type: 'standard' }));
    expect(auth.apiClient.post).toHaveBeenCalledWith('/auth/google/challenge', {}, expect.objectContaining({ timeout: 15000 }));
    await act(async () => {
      initialized.callback({ credential: 'signed-google-credential' });
      initialized.callback({ credential: 'signed-google-credential' });
    });
    expect(auth.googleLogin).toHaveBeenCalledTimes(1);
    expect(auth.googleLogin).toHaveBeenCalledWith('signed-google-credential');
    expect(props.onPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('loads the SDK only after configuration is available and recovers after a script failure', async () => {
    render(<GoogleSignIn {...props} />);
    await waitFor(() => expect(document.getElementById('syncscript-google-identity')).not.toBeNull());
    const script = document.getElementById('syncscript-google-identity')!;
    expect(script).toHaveAttribute('src', 'https://accounts.google.com/gsi/client');
    fireEvent.error(script);
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in could not load');
    expect(auth.apiClient.post).not.toHaveBeenCalled();
    expect(script).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Google sign-in' }));
    await waitFor(() => expect(document.getElementById('syncscript-google-identity')).not.toBeNull());
    installSDK();
    fireEvent.load(document.getElementById('syncscript-google-identity')!);
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers retry when the config request fails', async () => {
    auth.apiClient.get.mockRejectedValueOnce({ isAxiosError: true });
    installSDK();
    render(<GoogleSignIn {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in is unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Google sign-in' }));
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeVisible();
  });

  it('rejects an incomplete challenge response before enabling the SDK', async () => {
    auth.apiClient.post.mockResolvedValue(envelope({}));
    installSDK();
    render(<GoogleSignIn {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in is unavailable');
    expect(initialize).not.toHaveBeenCalled();
  });

  it('prevents Google exchange while password submission is in progress', async () => {
    const { rerender, container } = await renderReady({ disabled: true });
    expect(container.querySelector<HTMLElement>('.google-sign-in-button')?.inert).toBe(true);
    await act(async () => initialized.callback({ credential: 'ignored' }));
    expect(auth.googleLogin).not.toHaveBeenCalled();
    rerender(<GoogleSignIn {...props} disabled={false} />);
    expect(container.querySelector<HTMLElement>('.google-sign-in-button')?.inert).toBe(false);
    await act(async () => initialized.callback({ credential: 'accepted' }));
    expect(auth.googleLogin).toHaveBeenCalledTimes(1);
    expect(auth.googleLogin).toHaveBeenCalledWith('accepted');
  });

  it('starts a fresh challenge after a rejected credential and ignores the old callback', async () => {
    auth.googleLogin.mockRejectedValueOnce(new Error('The sign-in request expired. Please try again.'));
    await renderReady();
    const oldCallback = initialized.callback;
    await act(async () => oldCallback({ credential: 'expired' }));
    expect(props.onError).toHaveBeenCalledWith('The sign-in request expired. Please try again.');
    expect(props.onPendingChange).toHaveBeenLastCalledWith(false);
    await act(async () => oldCallback({ credential: 'expired-again' }));
    expect(auth.googleLogin).toHaveBeenCalledTimes(1);
    auth.apiClient.post.mockResolvedValueOnce(envelope({ nonce: 'fresh-nonce' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry Google sign-in' }));
    await waitFor(() => expect(initialized.nonce).toBe('fresh-nonce'));
    await act(async () => oldCallback({ credential: 'old-callback' }));
    expect(auth.googleLogin).toHaveBeenCalledTimes(1);
    await act(async () => initialized.callback({ credential: 'fresh' }));
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('ignores config responses after navigation without loading a script', async () => {
    const pending = deferred<ReturnType<typeof envelope>>();
    auth.apiClient.get.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<GoogleSignIn {...props} />);
    unmount();
    await act(async () => pending.resolve(envelope({ clientId: 'test.apps.googleusercontent.com' })));
    expect(document.getElementById('syncscript-google-identity')).toBeNull();
    expect(auth.apiClient.post).not.toHaveBeenCalled();
  });

  it('waits for a previous page challenge before requesting the next nonce cookie', async () => {
    const previous = deferred<ReturnType<typeof envelope>>();
    auth.apiClient.post.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(envelope({ nonce: 'next-page-nonce' }));
    installSDK();
    const first = render(<GoogleSignIn {...props} />);
    await waitFor(() => expect(auth.apiClient.post).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<GoogleSignIn {...props} />);
    await waitFor(() => expect(auth.apiClient.get).toHaveBeenCalledTimes(2));
    expect(auth.apiClient.post).toHaveBeenCalledTimes(1);
    await act(async () => previous.resolve(envelope({ nonce: 'previous-page-nonce' })));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialized.nonce).toBe('next-page-nonce');
  });

  it('removes the SDK button and ignores its callback after unmount', async () => {
    const { unmount, container } = await renderReady();
    const host = container.querySelector('.google-sign-in-button')!;
    unmount();
    expect(host).toBeEmptyDOMElement();
    await act(async () => initialized.callback({ credential: 'late-credential' }));
    expect(auth.googleLogin).not.toHaveBeenCalled();
  });

  it('waits for a previous page Google exchange before setting a fresh nonce cookie', async () => {
    const previousExchange = deferred<void>();
    auth.googleLogin.mockReturnValueOnce(previousExchange.promise);
    const first = await renderReady();
    await act(async () => initialized.callback({ credential: 'credential' }));
    first.unmount();
    render(<GoogleSignIn {...props} />);
    await waitFor(() => expect(auth.apiClient.get).toHaveBeenCalledTimes(2));
    expect(auth.apiClient.post).toHaveBeenCalledTimes(1);
    await act(async () => previousExchange.resolve());
    await waitFor(() => expect(auth.apiClient.post).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it('does not navigate or update page state when an exchange finishes after unmount', async () => {
    const pending = deferred<void>();
    auth.googleLogin.mockReturnValueOnce(pending.promise);
    const { unmount } = await renderReady();
    act(() => initialized.callback({ credential: 'credential' }));
    unmount();
    await act(async () => pending.resolve());
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(props.onPendingChange.mock.calls).toEqual([[true]]);
  });
});
