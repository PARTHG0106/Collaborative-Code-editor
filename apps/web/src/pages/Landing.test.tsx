import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Landing from './Landing';
import { ThemeProvider } from '../context/ThemeContext';

const getHealth = vi.hoisted(() => vi.fn());
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null }), apiClient: { get: getHealth } }));
const healthy = { data: { success: true, data: { status: 'healthy', services: { database: { status: 'connected' } } } } };

describe('Landing service status', () => {
  beforeEach(() => vi.resetAllMocks());

  it('waits for a successful health check before reporting service availability', async () => {
    let resolve!: (value: typeof healthy) => void;
    getHealth.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { container } = render(<ThemeProvider><MemoryRouter><Landing /></MemoryRouter></ThemeProvider>);
    expect(screen.queryByText('Service available')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Checking connection');
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(container.querySelector('a button, button a')).toBeNull();
    expect(screen.getByRole('link', { name: 'Create a workspace' })).toHaveAttribute('href', '/register');
    await act(async () => resolve(healthy));
    expect(screen.getByText('Service available')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Service available');
  });

  it('offers a retry after a connection failure and prevents overlapping retries', async () => {
    getHealth.mockRejectedValueOnce(new Error('Network Error'));
    render(<ThemeProvider><MemoryRouter><Landing /></MemoryRouter></ThemeProvider>);
    expect(await screen.findByText('Connection unavailable')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('try again in a moment');
    let resolve!: (value: typeof healthy) => void;
    getHealth.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checking…' }));
    expect(getHealth).toHaveBeenCalledTimes(2);
    await act(async () => resolve(healthy));
    expect(screen.getByText('Service available')).toBeInTheDocument();
    expect(screen.queryByText('Connection unavailable')).not.toBeInTheDocument();
  });

  it('does not report availability when the database is disconnected', async () => {
    getHealth.mockResolvedValue({ data: { success: true, data: { status: 'healthy', services: { database: { status: 'disconnected' } } } } });
    render(<ThemeProvider><MemoryRouter><Landing /></MemoryRouter></ThemeProvider>);
    expect(await screen.findByText('Connection unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Service available')).not.toBeInTheDocument();
  });
});
