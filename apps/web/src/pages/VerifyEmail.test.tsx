import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { VerifyEmail } from './VerifyEmail';
import { useAuth } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';

// Mock AuthContext
vi.mock('../context/AuthContext', () => {
  const mockVerifyEmail = vi.fn();
  const mockResendVerification = vi.fn();
  const mockClearError = vi.fn();

  return {
    useAuth: vi.fn(() => ({
      user: null,
      error: null,
      verifyEmail: mockVerifyEmail,
      resendVerification: mockResendVerification,
      clearError: mockClearError,
    })),
  };
});

describe('VerifyEmail Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, 'Test Page', '/verify-email?email=test@example.com');
  });

  const renderWithRouter = () => {
    return render(
      <ThemeProvider>
        <BrowserRouter>
          <VerifyEmail />
        </BrowserRouter>
      </ThemeProvider>
    );
  };

  it('renders verify email form elements', () => {
    renderWithRouter();
    expect(screen.getByText('Verify Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verify & Continue/i })).toBeInTheDocument();
  });

  it('validates input format before submitting', async () => {
    renderWithRouter();
    const input = screen.getByLabelText('Verification Code');
    const submitBtn = screen.getByRole('button', { name: /Verify & Continue/i });

    // Enter less than 6 digits
    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.click(submitBtn);

    expect(await screen.findByText('Please enter a valid 6-digit numeric verification code')).toBeInTheDocument();
  });

  it('calls verifyEmail on valid submit', async () => {
    const { verifyEmail } = useAuth();
    renderWithRouter();

    const input = screen.getByLabelText('Verification Code');
    const submitBtn = screen.getByRole('button', { name: /Verify & Continue/i });

    // Enter exactly 6 digits
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(verifyEmail).toHaveBeenCalled();
    });
  });

  it('calls resendVerification on clicking resend button', async () => {
    const { resendVerification } = useAuth();
    renderWithRouter();

    const resendBtn = screen.getByRole('button', { name: /Resend Verification Code/i });
    fireEvent.click(resendBtn);

    await waitFor(() => {
      expect(resendVerification).toHaveBeenCalled();
    });

    // Check that cooldown timer text is displayed
    expect(screen.getByText(/Resend Code in 30s/i)).toBeInTheDocument();
  });

  it('distinguishes sending a new code from verifying and prevents concurrent requests', async () => {
    const { resendVerification, verifyEmail } = useAuth();
    let finish!: () => void;
    vi.mocked(resendVerification).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = renderWithRouter();
    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resend Verification Code' }));
    expect(screen.getByRole('button', { name: 'Sending Code...' })).toBeDisabled();
    expect(screen.queryByText('Verifying...')).not.toBeInTheDocument();
    fireEvent.submit(container.querySelector('form')!);
    expect(verifyEmail).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(screen.getByRole('status')).toHaveTextContent('A fresh 6-digit code has been sent');
    expect(screen.getByRole('button', { name: 'Resend Code in 30s' })).toBeDisabled();
    expect(screen.getByLabelText('Verification Code')).toBeEnabled();
  });

  it('explains how to recover when the verification link is missing an email', () => {
    window.history.pushState({}, '', '/verify-email');
    renderWithRouter();
    expect(screen.getByRole('alert')).toHaveTextContent('No email address provided');
    expect(screen.getByLabelText('Verification Code')).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Sign In' })).toHaveAttribute('href', '/login');
  });
});
