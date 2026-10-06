import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as renderUI, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from './Dashboard';
import { useAuth } from '../context/AuthContext';
import { ThemeProvider } from '../context/ThemeContext';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mockNavigate,
}));

const render = (ui: React.ReactElement) => renderUI(<ThemeProvider><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter></ThemeProvider>);

const workspaceFixtures = [
  { id: 'alpha', name: 'Alpha API', description: 'Backend service', role: 'OWNER', memberCount: 1, joinedAt: '2026-10-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' },
  { id: 'zebra', name: 'Zebra UI', description: 'Shared design system', role: 'EDITOR', memberCount: 3, joinedAt: '2026-10-04T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' },
  { id: 'beta', name: 'Beta docs', description: null, role: 'VIEWER', memberCount: 2, joinedAt: '2026-10-02T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
];

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

    expect(screen.getByRole('dialog', { name: 'New Workspace' })).toBeInTheDocument();

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
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/ws-new');
  });

  it('exposes workspace rows as keyboard accessible links with their access level', async () => {
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

    const card = screen.getByRole('link', { name: 'Workspace Alpha' });
    expect(card).toHaveAttribute('href', '/workspace/ws-select');
    expect(card).toHaveAccessibleDescription('Edit files and collaborate');
    card.focus();
    expect(card).toHaveFocus();
  });

  it('combines case-insensitive search and role filters, with a clear path out of no results', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { success: true, data: workspaceFixtures } });
    render(<Dashboard />);
    await screen.findByRole('link', { name: 'Alpha API' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search workspaces' }), { target: { value: '  DESIGN  ' } });
    expect(screen.getByRole('link', { name: 'Zebra UI' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Alpha API' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 workspaces');

    fireEvent.change(screen.getByLabelText('Your role'), { target: { value: 'OWNER' } });
    expect(screen.getByText('No matching workspaces')).toBeInTheDocument();
    expect(screen.queryByText('No Workspaces Yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(screen.getByRole('main')).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByLabelText('Your role')).toHaveValue('ALL');

    fireEvent.change(screen.getByLabelText('Your role'), { target: { value: 'VIEWER' } });
    expect(screen.getByRole('link', { name: 'Beta docs' })).toHaveAccessibleDescription('Read-only access');
    expect(within(screen.getByRole('main')).getAllByRole('link')).toHaveLength(1);
  });

  it('sorts workspace links by joined date, name, or creation date', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { success: true, data: workspaceFixtures } });
    render(<Dashboard />);
    await screen.findByRole('link', { name: 'Alpha API' });
    const names = () => within(screen.getByRole('main')).getAllByRole('link').map((link) => within(link).getByRole('heading').textContent);
    expect(names()).toEqual(['Zebra UI', 'Beta docs', 'Alpha API']);

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    expect(names()).toEqual(['Alpha API', 'Beta docs', 'Zebra UI']);
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'created' } });
    expect(names()).toEqual(['Beta docs', 'Alpha API', 'Zebra UI']);
  });

  it('shows a retryable load error without claiming the user has no workspaces', async () => {
    vi.mocked(apiClient.get)
      .mockRejectedValueOnce({ response: { data: { error: { message: 'Connection unavailable' } } } })
      .mockResolvedValueOnce({ data: { success: true, data: workspaceFixtures } });
    render(<Dashboard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection unavailable');
    expect(screen.queryByText('No Workspaces Yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Alpha API' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('keeps loaded workspaces available when a refresh fails', async () => {
    vi.mocked(apiClient.get)
      .mockResolvedValueOnce({ data: { success: true, data: workspaceFixtures } })
      .mockRejectedValueOnce(new Error('offline'));
    render(<Dashboard />);
    await screen.findByRole('link', { name: 'Alpha API' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh workspaces' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch workspaces');
    expect(within(screen.getByRole('main')).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('keeps keyboard focus inside the create dialog and restores the trigger on Escape', async () => {
    render(<Dashboard />);
    await screen.findByText('No Workspaces Yet');
    const trigger = screen.getByRole('button', { name: 'New Workspace' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'New Workspace' });
    expect(within(dialog).getByLabelText('Workspace Name')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    const close = within(dialog).getByRole('button', { name: 'Close create workspace dialog' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('shows creation errors inside the dialog and preserves the draft for retry', async () => {
    vi.mocked(apiClient.post)
      .mockRejectedValueOnce({ response: { data: { error: { message: 'Workspace limit reached' } } } })
      .mockResolvedValueOnce({ data: { success: true, data: { ...workspaceFixtures[0], id: 'new' } } });
    render(<Dashboard />);
    await screen.findByText('No Workspaces Yet');
    fireEvent.click(screen.getByRole('button', { name: 'New Workspace' }));
    const dialog = screen.getByRole('dialog');
    const name = within(dialog).getByLabelText('Workspace Name');
    const description = within(dialog).getByLabelText('Description (Optional)');
    expect(name).toHaveAttribute('maxlength', '100');
    expect(description).toHaveAttribute('maxlength', '500');
    fireEvent.change(name, { target: { value: '   ' } });
    expect(within(dialog).getByRole('button', { name: 'Create Workspace' })).toBeDisabled();
    fireEvent.change(name, { target: { value: '  Alpha API  ' } });
    fireEvent.change(description, { target: { value: '  Backend service  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Workspace limit reached');
    expect(name).toHaveValue('  Alpha API  ');
    expect(apiClient.post).toHaveBeenCalledWith('/workspaces', { name: 'Alpha API', description: 'Backend service' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Workspace' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/workspace/new'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('prevents duplicate creation and dismissal while a create request is in flight', async () => {
    let finishCreation!: (value: unknown) => void;
    vi.mocked(apiClient.post).mockReturnValue(new Promise((resolve) => { finishCreation = resolve; }));
    render(<Dashboard />);
    await screen.findByText('No Workspaces Yet');
    fireEvent.click(screen.getByRole('button', { name: 'New Workspace' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Workspace Name'), { target: { value: 'Alpha API' } });
    const form = within(dialog).getByRole('button', { name: 'Create Workspace' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    await act(async () => finishCreation({ data: { success: true, data: { ...workspaceFixtures[0], id: 'new' } } }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/new');
  });
});
