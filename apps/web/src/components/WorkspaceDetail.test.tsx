import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { WorkspaceDetail } from './WorkspaceDetail';
import { useAuth } from '../context/AuthContext';

// Mock AuthContext
vi.mock('../context/AuthContext', () => {
  const mockUser = { id: 'user-123', email: 'user@example.com', name: 'User One' };
  const mockApiClient = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  return {
    useAuth: () => ({
      user: mockUser,
      apiClient: mockApiClient,
    }),
  };
});

// Mock Monaco Editor
vi.mock('@monaco-editor/react', () => {
  return {
    default: ({ value, onChange, options }: any) => (
      <textarea
        placeholder="// Start coding in this workspace..."
        data-testid="monaco-editor-mock"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options?.readOnly}
      />
    ),
  };
});

describe('WorkspaceDetail Component', () => {
  const { apiClient } = useAuth();

  const mockWorkspace = {
    id: 'ws-123',
    name: 'Test Project',
    description: 'A workspace description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentUserRole: 'OWNER',
    members: [
      { userId: 'user-123', name: 'User One', email: 'user@example.com', role: 'OWNER', joinedAt: new Date().toISOString() }
    ],
  };

  const mockFiles = [
    { id: 'item-1', name: 'src', type: 'FOLDER', parentId: null, workspaceId: 'ws-123', createdAt: '', updatedAt: '' },
    { id: 'item-2', name: 'index.js', type: 'FILE', content: 'console.log("hi")', parentId: 'item-1', workspaceId: 'ws-123', createdAt: '', updatedAt: '' },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/ws-123')) {
        return { data: { success: true, data: mockWorkspace } };
      }
      if (url.endsWith('/files')) {
        return { data: { success: true, data: mockFiles } };
      }
      return { data: { success: true, data: {} } };
    });
  });

  it('renders loading state initially then tab links', async () => {
    render(<WorkspaceDetail workspaceId="ws-123" onBack={() => {}} onWorkspaceDeleted={() => {}} />);

    expect(screen.getByText('Loading workspace environments...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('Loading workspace environments...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Code Editor')).toBeInTheDocument();
    expect(screen.getByText('Collaborators & Settings')).toBeInTheDocument();
  });

  it('displays the file tree and opens files in the editor pane', async () => {
    render(<WorkspaceDetail workspaceId="ws-123" onBack={() => {}} onWorkspaceDeleted={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading workspace environments...')).not.toBeInTheDocument();
    });

    // Verify folder is shown
    expect(screen.getByText('src')).toBeInTheDocument();

    // Click folder to expand/collapse (expandedFolders changes)
    fireEvent.click(screen.getByText('src'));

    // Wait for the children of the folder to render
    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    // Editor welcome state is shown before opening any file
    expect(screen.getByText('No File Opened')).toBeInTheDocument();

    // Open file
    fireEvent.click(screen.getByText('index.js'));

    // Wait for text editor and its content to appear
    await waitFor(() => {
      expect(screen.getByPlaceholderText('// Start coding in this workspace...')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('// Start coding in this workspace...') as HTMLTextAreaElement;
    expect(textarea.value).toBe('console.log("hi")');
  });

  it('supports creating a new file in the explorer', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        success: true,
        data: { id: 'item-3', name: 'test.css', type: 'FILE', content: '', parentId: null, workspaceId: 'ws-123' }
      }
    });

    render(<WorkspaceDetail workspaceId="ws-123" onBack={() => {}} onWorkspaceDeleted={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading workspace environments...')).not.toBeInTheDocument();
    });

    // Click New File button
    const newFileBtn = screen.getAllByTitle('New File')[0];
    fireEvent.click(newFileBtn);

    // Should render input for naming
    const input = screen.getByPlaceholderText('file.txt');
    fireEvent.change(input, { target: { value: 'test.css' } });

    // Submit input
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/workspaces/ws-123/files', {
        name: 'test.css',
        type: 'FILE',
        parentId: null
      });
    });
  });

  it('can delete files from the explorer actions', async () => {
    window.confirm = vi.fn(() => true);
    vi.mocked(apiClient.delete).mockResolvedValue({
      data: { success: true, data: { message: 'Item deleted' } }
    });

    render(<WorkspaceDetail workspaceId="ws-123" onBack={() => {}} onWorkspaceDeleted={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText('Loading workspace environments...')).not.toBeInTheDocument();
    });

    // Toggle folder so children render
    fireEvent.click(screen.getByText('src'));

    await waitFor(() => {
      expect(screen.getByText('index.js')).toBeInTheDocument();
    });

    // Delete index.js
    const deleteBtn = screen.getAllByTitle('Delete')[0]; // first item delete button (folders or files)
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/workspaces/ws-123/files/item-1'); // item-1 is folder 'src'
    });
  });
});
