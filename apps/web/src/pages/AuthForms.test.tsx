import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Login from './Login';
import Register from './Register';
import VerifyEmail from './VerifyEmail';

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  error: null,
  login: vi.fn(),
  googleLogin: vi.fn(),
  apiClient: { get: vi.fn(), post: vi.fn() },
  register: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
  clearError: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));

const destination = { pathname: '/workspace/project', search: '?file=main.ts', hash: '#line-12' };
function Destination() {
  const location = useLocation();
  return <p>Opened {location.pathname}{location.search}{location.hash}</p>;
}

function renderAuth(pathname = '/login') {
  return render(
    <MemoryRouter initialEntries={[{ pathname, state: { from: destination } }]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="*" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Authentication forms', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.user = null;
    auth.apiClient.get.mockResolvedValue({ data: { success: true, data: { clientId: null } } });
  });

  afterEach(() => { delete window.google; });

  it.each(['/login', '/register'])('opens the originally requested workspace after Google sign-in on %s', async pathname => {
    let onCredential!: (response: { credential: string }) => void;
    const initialize = vi.fn(options => { onCredential = options.callback; });
    window.google = { accounts: { id: {
      initialize,
      renderButton: host => {
        const button = document.createElement('button');
        button.textContent = 'Continue with Google';
        host.appendChild(button);
      },
    } } };
    auth.apiClient.get.mockResolvedValue({ data: { success: true, data: { clientId: 'test.apps.googleusercontent.com' } } });
    auth.apiClient.post.mockResolvedValue({ data: { success: true, data: { nonce: 'nonce' } } });
    let finish!: () => void;
    auth.googleLogin.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const { container } = renderAuth(pathname);
    await waitFor(() => expect(initialize).toHaveBeenCalled());
    act(() => onCredential({ credential: 'credential' }));
    expect(screen.getByLabelText('Email Address')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByRole('button', { name: pathname === '/login' ? 'Sign In' : 'Sign Up' })).toBeDisabled();
    fireEvent.submit(container.querySelector('form')!);
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.register).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(await screen.findByText('Opened /workspace/project?file=main.ts#line-12')).toBeInTheDocument();
    expect(auth.googleLogin).toHaveBeenCalledWith('credential');
  });

  it('reveals passwords without changing them and returns to the complete requested location', async () => {
    auth.login.mockImplementation(async () => { auth.user = { id: 'user' }; });
    renderAuth();
    const email = screen.getByLabelText('Email Address');
    const password = screen.getByLabelText('Password');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    fireEvent.change(email, { target: { value: 'person@example.com' } });
    fireEvent.change(password, { target: { value: ' my password ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue(' my password ');
    expect(auth.login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(await screen.findByText('Opened /workspace/project?file=main.ts#line-12')).toBeInTheDocument();
    expect(auth.login).toHaveBeenCalledWith('person@example.com', ' my password ');
  });

  it('prevents duplicate submissions and announces sign-in failures without discarding input', async () => {
    let fail!: (error: Error) => void;
    auth.login.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const { container } = renderAuth();
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'person@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(auth.login).toHaveBeenCalledTimes(1);
    expect(form).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /Signing In/ })).toBeDisabled();
    await act(async () => fail(new Error('Unable to sign in. Try again.')));
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to sign in. Try again.');
    expect(screen.getByLabelText('Password')).toHaveValue('password');
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();
  });

  it('keeps the requested workspace when sign-in requires email verification', async () => {
    auth.login.mockRejectedValueOnce(Object.assign(new Error('Verify your email'), { code: 'EMAIL_NOT_VERIFIED' }));
    auth.verifyEmail.mockImplementation(async () => { auth.user = { id: 'user' }; });
    renderAuth();
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'person@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    const code = await screen.findByLabelText('Verification Code');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Continue' }));
    expect(await screen.findByText('Opened /workspace/project?file=main.ts#line-12')).toBeInTheDocument();
  });

  it('validates trimmed names and preserves the workspace through registration and pasted verification', async () => {
    auth.verifyEmail.mockImplementation(async () => { auth.user = { id: 'user' }; });
    const { container } = renderAuth();
    fireEvent.click(screen.getByRole('link', { name: 'Sign Up' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'person@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Please fill in all fields');
    expect(auth.register).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: '  Person  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    const code = await screen.findByLabelText('Verification Code');
    expect(auth.register).toHaveBeenCalledWith('person@example.com', 'password', 'Person');
    fireEvent.paste(code, { clipboardData: { getData: () => '123 456' } });
    expect(code).toHaveValue('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Continue' }));
    await waitFor(() => expect(auth.verifyEmail).toHaveBeenCalledWith('person@example.com', '123456'));
    expect(await screen.findByText('Opened /workspace/project?file=main.ts#line-12')).toBeInTheDocument();
  });
});
