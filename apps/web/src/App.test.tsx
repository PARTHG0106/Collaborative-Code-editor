import { describe, it, expect, vi, beforeEach, Mocked } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import App from './App';
import axios from 'axios';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as Mocked<typeof axios>;

describe('Frontend App Component', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders landing page with title and loader initially', async () => {
    // Return a pending promise to keep it in loading state
    mockedAxios.get.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(screen.getByText('SyncScript')).toBeInTheDocument();
    expect(screen.getByText('Collaborative Coding,')).toBeInTheDocument();
    expect(screen.getByText('Querying API status...')).toBeInTheDocument();
  });

  it('displays API data once fetched successfully', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          status: 'healthy',
          timestamp: '2026-06-19T09:00:00.000Z',
          uptime: 120,
          environment: 'development',
          version: '0.1.0',
          services: {
            database: {
              status: 'connected',
              latency: '14ms',
            },
          },
        },
      },
    });

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

  it('displays error UI when API request fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('Network Error'));

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('Querying API status...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Network Error')).toBeInTheDocument();
    expect(screen.getByText('Error connecting to the backend services:')).toBeInTheDocument();
  });

  it('refetches status when the check button is clicked', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          status: 'healthy',
          timestamp: '2026-06-19T09:00:00.000Z',
          uptime: 120,
          environment: 'development',
          version: '0.1.0',
          services: {
            database: {
              status: 'connected',
              latency: '14ms',
            },
          },
        },
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('Querying API status...')).not.toBeInTheDocument();
    });

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);

    // Click check button
    const button = screen.getByRole('button', { name: /Check System Status/i });
    fireEvent.click(button);

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });
});
