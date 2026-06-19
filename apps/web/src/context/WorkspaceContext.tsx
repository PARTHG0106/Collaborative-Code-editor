import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiClient, useAuth } from './AuthContext.js';

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  members?: WorkspaceMember[];
  invitations?: WorkspaceInvitation[];
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: 'EDITOR' | 'VIEWER';
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  expiresAt: string;
  createdAt: string;
  invitedBy: {
    id: string;
    name: string;
  };
  token: string;
}

interface WorkspaceContextType {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  loading: boolean;
  error: string | null;
  fetchWorkspaces: () => Promise<void>;
  fetchWorkspaceDetails: (id: string) => Promise<Workspace>;
  createWorkspace: (name: string, description?: string) => Promise<Workspace>;
  updateWorkspace: (id: string, name: string, description?: string | null) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  inviteMember: (workspaceId: string, email: string, role: 'EDITOR' | 'VIEWER') => Promise<WorkspaceInvitation>;
  cancelInvitation: (workspaceId: string, invitationId: string) => Promise<void>;
  updateMemberRole: (workspaceId: string, memberId: string, role: 'OWNER' | 'EDITOR' | 'VIEWER') => Promise<void>;
  removeMember: (workspaceId: string, memberId: string) => Promise<void>;
  selectWorkspace: (workspace: Workspace | null) => void;
  clearWorkspaceError: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export const WorkspaceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const clearWorkspaceError = useCallback(() => setError(null), []);

  const fetchWorkspaces = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get('/workspaces');
      if (response.data && response.data.success) {
        const list = response.data.data;
        setWorkspaces(list);
        setCurrentWorkspace((prev) => {
          if (!list || list.length === 0) return null;
          const stillExists = prev ? list.find((ws: any) => ws.id === prev.id) : null;
          if (stillExists) return stillExists;
          return list[0];
        });
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to fetch workspaces');
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Load workspaces when user logging status changes
  useEffect(() => {
    if (user) {
      fetchWorkspaces();
    } else {
      setWorkspaces([]);
      setCurrentWorkspace(null);
    }
  }, [user, fetchWorkspaces]);

  const selectWorkspace = useCallback((ws: Workspace | null) => {
    setCurrentWorkspace(ws);
  }, []);

  const fetchWorkspaceDetails = async (id: string): Promise<Workspace> => {
    setError(null);
    try {
      const response = await apiClient.get(`/workspaces/${id}`);
      if (response.data && response.data.success) {
        const details = response.data.data;
        // Keep current workspace sync'ed if it's the active one
        if (currentWorkspace?.id === id) {
          setCurrentWorkspace(details);
        }
        return details;
      }
      throw new Error('Failed to get workspace details');
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to fetch workspace details';
      setError(msg);
      throw new Error(msg);
    }
  };

  const createWorkspace = async (name: string, description?: string): Promise<Workspace> => {
    setError(null);
    setLoading(true);
    try {
      const response = await apiClient.post('/workspaces', { name, description });
      if (response.data && response.data.success) {
        const newWs = response.data.data;
        setWorkspaces((prev) => [...prev, newWs]);
        setCurrentWorkspace(newWs);
        return newWs;
      }
      throw new Error('Failed to create workspace');
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to create workspace';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  };

  const updateWorkspace = async (id: string, name: string, description?: string | null) => {
    setError(null);
    try {
      const response = await apiClient.patch(`/workspaces/${id}`, { name, description });
      if (response.data && response.data.success) {
        const updated = response.data.data;
        setWorkspaces((prev) => prev.map((ws) => (ws.id === id ? { ...ws, ...updated } : ws)));
        if (currentWorkspace?.id === id) {
          setCurrentWorkspace((prev) => (prev ? { ...prev, ...updated } : null));
        }
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to update workspace';
      setError(msg);
      throw new Error(msg);
    }
  };

  const deleteWorkspace = async (id: string) => {
    setError(null);
    try {
      const response = await apiClient.delete(`/workspaces/${id}`);
      if (response.data && response.data.success) {
        setWorkspaces((prev) => prev.filter((ws) => ws.id !== id));
        if (currentWorkspace?.id === id) {
          setCurrentWorkspace(null);
        }
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to delete workspace';
      setError(msg);
      throw new Error(msg);
    }
  };

  const inviteMember = async (
    workspaceId: string,
    email: string,
    role: 'EDITOR' | 'VIEWER'
  ): Promise<WorkspaceInvitation> => {
    setError(null);
    try {
      const response = await apiClient.post(`/workspaces/${workspaceId}/invitations`, { email, role });
      if (response.data && response.data.success) {
        // Refresh details
        await fetchWorkspaceDetails(workspaceId);
        return response.data.data;
      }
      throw new Error('Failed to send invitation');
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to invite team member';
      setError(msg);
      throw new Error(msg);
    }
  };

  const cancelInvitation = async (workspaceId: string, invitationId: string) => {
    setError(null);
    try {
      const response = await apiClient.delete(`/workspaces/${workspaceId}/invitations/${invitationId}`);
      if (response.data && response.data.success) {
        await fetchWorkspaceDetails(workspaceId);
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to cancel invitation';
      setError(msg);
      throw new Error(msg);
    }
  };

  const updateMemberRole = async (
    workspaceId: string,
    memberId: string,
    role: 'OWNER' | 'EDITOR' | 'VIEWER'
  ) => {
    setError(null);
    try {
      const response = await apiClient.patch(`/workspaces/${workspaceId}/members/${memberId}`, { role });
      if (response.data && response.data.success) {
        await fetchWorkspaceDetails(workspaceId);
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to update member role';
      setError(msg);
      throw new Error(msg);
    }
  };

  const removeMember = async (workspaceId: string, memberId: string) => {
    setError(null);
    try {
      const response = await apiClient.delete(`/workspaces/${workspaceId}/members/${memberId}`);
      if (response.data && response.data.success) {
        await fetchWorkspaceDetails(workspaceId);
        // If left own workspace, clear selector
        const memberRemoved = currentWorkspace?.members?.find((m) => m.id === memberId);
        if (memberRemoved && memberRemoved.userId === user?.id) {
          fetchWorkspaces();
        }
      }
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to remove member';
      setError(msg);
      throw new Error(msg);
    }
  };

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        currentWorkspace,
        loading,
        error,
        fetchWorkspaces,
        fetchWorkspaceDetails,
        createWorkspace,
        updateWorkspace,
        deleteWorkspace,
        inviteMember,
        cancelInvitation,
        updateMemberRole,
        removeMember,
        selectWorkspace,
        clearWorkspaceError,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
};

export const useWorkspaces = () => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspaces must be used within a WorkspaceProvider');
  }
  return context;
};
