import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { Dashboard } from './Dashboard';
import { useAuth } from '../context/AuthContext';

// Mock AuthContext
vi.mock('../context/AuthContext', () => {
  const mockUser = { id: 'user-123', email: 'user@example.com', name: 'User One' };
  const mockLogout = vi.fn();
  const mockApiClient = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return {
    useAuth: () => ({
      user: mockUser,
      logout: mockLogout,
      apiClient: mockApiClient,
    }),
    AuthProvider: ({ children }: any) => <div>{children}</div>,
  };
});

// Mock WorkspaceDetail to isolate Dashboard unit tests
vi.mock('../components/WorkspaceDetail', () => {
  return {
    WorkspaceDetail: ({ workspaceId, onBack }: any) => (
      <div data-testid="workspace-detail-view">
        <span>Workspace ID: {workspaceId}</span>
        <button onClick={onBack}>Back Button</button>
      </div>
    ),
  };
});

describe('Dashboard Workspace Flow', () => {
  const { apiClient } = useAuth();

  beforeEach(() => {
    vi.resetAllMocks();
    // Default implementation to avoid unhandled promise resolution warnings
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { success: true, data: [] },
    });
  });

  it('renders loading state initially then list of workspaces', async () => {
    const mockWorkspaces = [
      {
        id: 'ws-1',
        name: 'Workspace Alpha',
        description: 'First description',
        role: 'OWNER',
        memberCount: 2,
      },
    ];

    vi.mocked(apiClient.get).mockResolvedValue({
      data: { success: true, data: mockWorkspaces },
    });

    render(<Dashboard />);

    // Verify loading spinner is shown initially
    expect(screen.getByText('Loading workspaces...')).toBeInTheDocument();

    // Wait for the workspace listing
    await waitFor(() => {
      expect(screen.queryByText('Loading workspaces...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Workspace Alpha')).toBeInTheDocument();
    expect(screen.getByText('First description')).toBeInTheDocument();
    expect(screen.getByText('OWNER')).toBeInTheDocument();
  });

  it('renders empty state when no workspaces exist', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { success: true, data: [] },
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByText('Loading workspaces...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('No Workspaces Yet')).toBeInTheDocument();
    expect(screen.getByText('Create a workspace to begin coding, or have a teammate invite you by email.')).toBeInTheDocument();
  });

  it('opens and submits create workspace modal successfully', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { success: true, data: [] },
    });

    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        success: true,
        data: {
          id: 'ws-new',
          name: 'Workspace Beta',
          description: 'A new workspace desc',
          role: 'OWNER',
          memberCount: 1,
        },
      },
    });

    const { container } = render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByText('Loading workspaces...')).not.toBeInTheDocument();
    });

    // Open Modal
    const newWorkspaceBtn = screen.getByRole('button', { name: /New Workspace/i });
    fireEvent.click(newWorkspaceBtn);

    expect(screen.getByText('New Workspace Environment')).toBeInTheDocument();

    // Populate form
    const nameInput = screen.getByLabelText(/Workspace Name/i);
    const descInput = screen.getByLabelText(/Description/i);

    fireEvent.change(nameInput, { target: { value: 'Workspace Beta' } });
    fireEvent.change(descInput, { target: { value: 'A new workspace desc' } });

    // Submit form targeting modal submit button specifically
    const submitBtn = container.querySelector('.modal-form button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn).toBeInTheDocument();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/workspaces', {
        name: 'Workspace Beta',
        description: 'A new workspace desc',
      });
    });

    // Wait for the modal to close to avoid leaking async operations into subsequent tests
    await waitFor(() => {
      expect(screen.queryByText('New Workspace Environment')).not.toBeInTheDocument();
    });
  });

  it('switches to WorkspaceDetail view on workspace item card click', async () => {
    const mockWorkspaces = [
      {
        id: 'ws-select',
        name: 'Workspace Alpha',
        description: 'Selectable workspace',
        role: 'EDITOR',
        memberCount: 3,
      },
    ];

    vi.mocked(apiClient.get).mockResolvedValue({
      data: { success: true, data: mockWorkspaces },
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.queryByText('Loading workspaces...')).not.toBeInTheDocument();
    });

    // Click Card
    const card = screen.getByText('Workspace Alpha');
    fireEvent.click(card);

    // Verify detail view rendered
    expect(screen.getByTestId('workspace-detail-view')).toBeInTheDocument();
    expect(screen.getByText('Workspace ID: ws-select')).toBeInTheDocument();

    // Click Back
    const backBtn = screen.getByRole('button', { name: /Back Button/i });
    fireEvent.click(backBtn);

    // Back to main view
    await waitFor(() => {
      expect(screen.queryByTestId('workspace-detail-view')).not.toBeInTheDocument();
    });
    
    await waitFor(() => {
      expect(screen.getByText('Workspace Alpha')).toBeInTheDocument();
    });
  });
});
