import { useState, useCallback } from 'react';
import { useAuth } from '../../../context/AuthContext';

export interface FileSystemItem {
  id: string;
  name: string;
  type: 'FILE' | 'FOLDER';
  content: string | null;
  parentId: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

interface UseFileSystemReturn {
  files: FileSystemItem[];
  filesLoading: boolean;
  activeFileId: string | null;
  setActiveFileId: React.Dispatch<React.SetStateAction<string | null>>;
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  fetchFiles: () => Promise<void>;
  createFile: (name: string, type: 'FILE' | 'FOLDER', parentId: string | null, content?: string) => Promise<FileSystemItem | null>;
  renameFile: (id: string, name: string) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  saveFileContent: (fileId: string, content: string) => Promise<void>;
  saveStatus: 'saved' | 'saving' | 'unsaved';
  setSaveStatus: React.Dispatch<React.SetStateAction<'saved' | 'saving' | 'unsaved'>>;
  setFiles: React.Dispatch<React.SetStateAction<FileSystemItem[]>>;
}

export function useFileSystem(workspaceId: string): UseFileSystemReturn {
  const { apiClient } = useAuth();
  const [files, setFiles] = useState<FileSystemItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');

  const fetchFiles = useCallback(async () => {
    try {
      setFilesLoading(true);
      const res = await apiClient.get(`/workspaces/${workspaceId}/files`);
      if (res.data && res.data.success) {
        setFiles(res.data.data);
      }
    } catch (err: any) {
      console.error('Failed to load file tree:', err);
    } finally {
      setFilesLoading(false);
    }
  }, [workspaceId, apiClient]);

  const createFile = useCallback(async (name: string, type: 'FILE' | 'FOLDER', parentId: string | null, content?: string): Promise<FileSystemItem | null> => {
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/files`, { name, type, parentId, content });
      if (res.data && res.data.success) {
        const newItem = res.data.data;
        setFiles(prev => [...prev, newItem]);
        if (parentId) {
          setExpandedFolders(prev => {
            const next = new Set(prev);
            next.add(parentId);
            return next;
          });
        }
        return newItem;
      }
    } catch (err: any) {
      console.error('Failed to create item:', err);
      throw new Error(err.response?.data?.error?.message || 'Failed to create item');
    }
    return null;
  }, [workspaceId, apiClient]);

  const renameFile = useCallback(async (id: string, name: string) => {
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/files/${id}`, { name });
      if (res.data && res.data.success) {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, name: res.data.data.name } : f));
      }
    } catch (err: any) {
      throw new Error(err.response?.data?.error?.message || 'Failed to rename item');
    }
  }, [workspaceId, apiClient]);

  const deleteFile = useCallback(async (id: string) => {
    try {
      const res = await apiClient.delete(`/workspaces/${workspaceId}/files/${id}`);
      if (res.data && res.data.success) {
        setFiles(prev => prev.filter(f => f.id !== id && f.parentId !== id));
        if (activeFileId === id) {
          setActiveFileId(null);
        }
      }
    } catch (err: any) {
      throw new Error(err.response?.data?.error?.message || 'Failed to delete item');
    }
  }, [workspaceId, apiClient, activeFileId]);

  const saveFileContent = useCallback(async (fileId: string, content: string) => {
    setSaveStatus('saving');
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/files/${fileId}`, { content });
      if (res.data && res.data.success) {
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, content: res.data.data.content } : f));
        setSaveStatus('saved');
      }
    } catch (err: any) {
      setSaveStatus('unsaved');
      throw new Error(err.response?.data?.error?.message || 'Failed to save changes');
    }
  }, [workspaceId, apiClient]);

  return {
    files,
    filesLoading,
    activeFileId,
    setActiveFileId,
    expandedFolders,
    setExpandedFolders,
    fetchFiles,
    createFile,
    renameFile,
    deleteFile,
    saveFileContent,
    saveStatus,
    setSaveStatus,
    setFiles,
  };
}
