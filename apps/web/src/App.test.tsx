import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';
import App from './App';
import axios from 'axios';

// Mock axios
vi.mock('axios', () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn(), eject: vi.fn() },
      response: { use: vi.fn(), eject: vi.fn() },
    },
  };
  return {
    default: {
      ...mockAxiosInstance,
      create: vi.fn(() => mockAxiosInstance),
      isAxiosError: vi.fn((err) => false),
    },
    ...mockAxiosInstance,
    isAxiosError: vi.fn((err) => false),
  };
});

const mockedAxios = axios as unknown as Mocked<typeof axios> & {
  create: any;
  get: any;
  post: any;
};

describe('Frontend App Component & Auth Flows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState({}, '', '/');

    // Default implementations to prevent unhandled rejections during restoreSession
    mockedAxios.post.mockImplementation((url: string) => {
      if (url.includes('/auth/refresh')) {
        return Promise.resolve({
          data: {
            success: false,
            error: { message: 'No active session' },
          },
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              status: 'healthy',
              timestamp: '2026-06-19T09:00:00.000Z',
              uptime: 120,
              environment: 'development',
              version: '0.1.0',
              services: {
                database: { status: 'connected', latency: '14ms' },
              },
            },
          },
        });
      }
      return Promise.resolve({ data: { success: true } });
    });
  });

  it('renders landing page with title and loader initially', async () => {
    // Return a pending promise for health check to keep it in loading state
    mockedAxios.get.mockImplementationOnce((url: string) => {
      if (url.includes('/health')) {
        return new Promise(() => {});
      }
      return Promise.resolve({ data: { success: true } });
    });

    await act(async () => { render(<App />); });

    expect(screen.getByRole('link', { name: 'SyncScript home' })).toHaveTextContent('syncscript');
    expect(screen.getByRole('heading', { name: /Your code\.\s*Room to work\./, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking connection…');
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(screen.queryByText('Service available')).not.toBeInTheDocument();
  });

  it('displays API health status once fetched successfully', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Service available');
    });

    expect(screen.getByLabelText('Service status')).toBeInTheDocument();
    expect(screen.getByText('Service available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  it('displays error UI when health check fails', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.reject(new Error('Network Error'));
      }
      return Promise.resolve({ data: { success: true } });
    });

    render(<App />);

    expect(await screen.findByText('Connection unavailable')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('We couldn’t connect to SyncScript.');
    expect(screen.getByRole('status')).toHaveTextContent('try again in a moment');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(screen.queryByText('Service available')).not.toBeInTheDocument();
  });

  it('refetches health status when the refresh button is clicked', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Service available');
    });

    expect(mockedAxios.get).toHaveBeenCalled();

    // Click refresh button
    const button = screen.getByRole('button', { name: 'Check again' });
    fireEvent.click(button);

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Service available');
    });
  });

  it('navigates to Login page and handles registration toggle', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Service available');
    });

    // Click Sign In link in header
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Account' })).getByRole('link', { name: 'Sign In' }));

    // Verify Login page is rendered
    expect(screen.getByRole('heading', { name: 'Welcome back', level: 1 })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();

    // Click Sign Up footer redirect
    const signUpLink = screen.getByRole('link', { name: 'Sign Up' });
    fireEvent.click(signUpLink);

    // Register is lazy-loaded (React.lazy + Suspense), so the chunk resolves
    // asynchronously — await the heading rather than asserting synchronously.
    // Generous timeout: under full-suite parallelism the dynamic import can be
    // slow, which is what made this test flaky before.
    expect(await screen.findByRole('heading', { name: 'Create an account', level: 1 }, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Full Name' })).toBeInTheDocument();
  });
});
