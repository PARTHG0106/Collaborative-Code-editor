import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

    render(<App />);

    expect(screen.getByText('SyncScript')).toBeInTheDocument();
    expect(screen.getByText(/Collaborative Coding/i)).toBeInTheDocument();
    expect(screen.getByText('Querying API status...')).toBeInTheDocument();
  });

  it('displays API health status once fetched successfully', async () => {
    render(<App />);

    // Wait for the loader to disappear and status dashboard to render
    await waitFor(() => {
      expect(screen.queryByText('Querying API status...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Monorepo System Status')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('connected (14ms)')).toBeInTheDocument();
    expect(screen.getByText('development')).toBeInTheDocument();
  });

  it('displays error UI when health check fails', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.reject(new Error('Network Error'));
      }
      return Promise.resolve({ data: { success: true } });
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('Querying API status...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Network Error')).toBeInTheDocument();
    expect(screen.getByText('Error connecting to the backend services:')).toBeInTheDocument();
  });

  it('refetches health status when the refresh button is clicked', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('Querying API status...')).not.toBeInTheDocument();
    });

    expect(mockedAxios.get).toHaveBeenCalled();

    // Click refresh button
    const button = screen.getByRole('button', { name: /Refresh Health/i });
    fireEvent.click(button);

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('navigates to Login page and handles registration toggle', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('Querying API status...')).not.toBeInTheDocument();
    });

    // Click Sign In link in header
    const signInLinks = screen.getAllByText('Sign In');
    fireEvent.click(signInLinks[0]);

    // Verify Login page is rendered
    expect(screen.getByText('Welcome Back')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();

    // Click Sign Up footer redirect
    const signUpLink = screen.getByText('Sign Up');
    fireEvent.click(signUpLink);

    // Verify Register page is rendered
    expect(screen.getByText('Create Account')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('John Doe')).toBeInTheDocument();
  });

  it('renders dashboard with workspaces when session is restored', async () => {
    // 1. Mock refresh token route to succeed
    mockedAxios.post.mockImplementation((url: string) => {
      if (url.includes('/auth/refresh')) {
        return Promise.resolve({
          data: {
            success: true,
            data: { accessToken: 'mock-access-token' },
          },
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    // 2. Mock auth/me and workspaces routes
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({
          data: { success: true, data: { status: 'healthy' } },
        });
      }
      if (url.includes('/auth/me')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
            },
          },
        });
      }
      if (url.includes('/workspaces')) {
        if (url.endsWith('/workspaces/ws-123') || url.includes('/workspaces/ws-')) {
          return Promise.resolve({
            data: {
              success: true,
              data: {
                id: 'ws-123',
                name: 'Workspace Alpha',
                description: 'Test workspace description',
                role: 'OWNER',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                members: [
                  {
                    id: 'm-1',
                    userId: 'user-123',
                    name: 'Test User',
                    email: 'test@example.com',
                    role: 'OWNER',
                    joinedAt: new Date().toISOString(),
                  },
                ],
                invitations: [],
              },
            },
          });
        }
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                id: 'ws-123',
                name: 'Workspace Alpha',
                description: 'Test workspace description',
                role: 'OWNER',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    render(<App />);

    // 3. Wait for the dashboard/welcome message to render
    await waitFor(() => {
      expect(screen.getByText(/Welcome back,/i)).toBeInTheDocument();
    });

    // 4. Verify workspace selector and workspace detail card render
    expect(screen.getAllByText('Workspace Alpha').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('OWNER')).toBeInTheDocument();
    expect(screen.getByText('Phase 3: Workspaces Active')).toBeInTheDocument();
  });
});
