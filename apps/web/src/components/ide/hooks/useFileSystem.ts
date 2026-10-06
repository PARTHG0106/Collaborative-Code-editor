import { useState, useCallback, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
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
  hasLoadedFiles: boolean;
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

export function useFileSystem(workspaceId: string, socket?: Socket | null): UseFileSystemReturn {
  const { apiClient } = useAuth();
  const [files, setFilesState] = useState<FileSystemItem[]>([]);
  const filesRef = useRef<FileSystemItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [hasLoadedFiles, setHasLoadedFiles] = useState(false);
  const [activeFileId, setActiveFileIdState] = useState<string | null>(null);
  const activeFileRef = useRef<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const scopeRef = useRef({ workspaceId, active: true });
  const fetchIdRef = useRef(0);
  const saveIdsRef = useRef(new Map<string, number>());
  const saveQueuesRef = useRef(new Map<string, Promise<void>>());

  // Keep an immediate cache as well as React state: a socket event or an HTTP
  // response can arrive before React commits the previous edit.
  const setFiles = useCallback<React.Dispatch<React.SetStateAction<FileSystemItem[]>>>((value) => {
    filesRef.current = typeof value === 'function' ? value(filesRef.current) : value;
    setFilesState(filesRef.current);
  }, []);

  const setActiveFileId = useCallback<React.Dispatch<React.SetStateAction<string | null>>>((value) => {
    activeFileRef.current = typeof value === 'function' ? value(activeFileRef.current) : value;
    setActiveFileIdState(activeFileRef.current);
  }, []);

  useEffect(() => {
    const scope = { workspaceId, active: true };
    scopeRef.current = scope;
    setFiles([]);
    setActiveFileId(null);
    setExpandedFolders(new Set());
    setSaveStatus('saved');
    setFilesLoading(false);
    setHasLoadedFiles(false);
    saveIdsRef.current = new Map();
    saveQueuesRef.current = new Map();
    return () => { scope.active = false; };
  }, [workspaceId, setFiles, setActiveFileId]);

  const removeMissingSelection = useCallback((items: FileSystemItem[]) => {
    const ids = new Set(items.map(item => item.id));
    if (activeFileRef.current && !ids.has(activeFileRef.current)) {
      setActiveFileId(null);
      setSaveStatus('saved');
    }
    setExpandedFolders(prev => new Set([...prev].filter(id => ids.has(id))));
  }, [setActiveFileId]);

  const fetchFiles = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope.active || scope.workspaceId !== workspaceId) return;
    const fetchId = ++fetchIdRef.current;
    const initial = new Map(filesRef.current.map(item => [item.id, item]));
    try {
      setFilesLoading(true);
      const res = await apiClient.get(`/workspaces/${workspaceId}/files`);
      if (!scope.active || fetchId !== fetchIdRef.current) return;
      if (res.data?.success === true && Array.isArray(res.data.data)) {
        const current = new Map(filesRef.current.map(item => [item.id, item]));
        const incoming = res.data.data as FileSystemItem[];
        const incomingIds = new Set(incoming.map(item => item.id));
        const merged = incoming
          // Do not resurrect an item deleted while this fetch was in flight.
          .filter(item => !initial.has(item.id) || current.has(item.id))
          .map(item => {
            const cached = current.get(item.id);
            if (!cached) return item;
            const before = initial.get(item.id);
            return {
              ...item,
              // The editor owns existing buffers. Tree refreshes must not
              // replace an unsent edit with an older database snapshot.
              content: cached.content,
              name: before && cached.name !== before.name ? cached.name : item.name,
            };
          });
        // A create response can precede an older listing response.
        for (const item of current.values()) {
          if (!initial.has(item.id) && !incomingIds.has(item.id)) merged.push(item);
        }
        setFiles(merged);
        removeMissingSelection(merged);
        setHasLoadedFiles(true);
      }
    } catch (err: any) {
      console.error('Failed to load file tree:', err);
    } finally {
      if (scope.active && fetchId === fetchIdRef.current) setFilesLoading(false);
    }
  }, [workspaceId, apiClient, setFiles, removeMissingSelection]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => { void fetchFiles(); };
    const onFilesChanged = (payload: { workspaceId: string }) => {
      if (payload.workspaceId === workspaceId) refresh();
    };
    socket.on('workspace_files_changed', onFilesChanged);
    socket.on('connect', refresh);
    return () => {
      socket.off('workspace_files_changed', onFilesChanged);
      socket.off('connect', refresh);
    };
  }, [workspaceId, socket, fetchFiles]);

  const createFile = useCallback(async (name: string, type: 'FILE' | 'FOLDER', parentId: string | null, content?: string): Promise<FileSystemItem | null> => {
    const scope = scopeRef.current;
    if (!scope.active || scope.workspaceId !== workspaceId) return null;
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/files`, { name, type, parentId, content });
      if (!scope.active) return null;
      if (res.data && res.data.success) {
        const newItem = res.data.data;
        setFiles(prev => prev.some(item => item.id === newItem.id) ? prev : [...prev, newItem]);
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
  }, [workspaceId, apiClient, setFiles]);

  const renameFile = useCallback(async (id: string, name: string) => {
    const scope = scopeRef.current;
    if (!scope.active || scope.workspaceId !== workspaceId) return;
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/files/${id}`, { name });
      if (!scope.active) return;
      if (res.data && res.data.success) {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, name: res.data.data.name } : f));
      }
    } catch (err: any) {
      throw new Error(err.response?.data?.error?.message || 'Failed to rename item');
    }
  }, [workspaceId, apiClient, setFiles]);

  const deleteFile = useCallback(async (id: string) => {
    const scope = scopeRef.current;
    if (!scope.active || scope.workspaceId !== workspaceId) return;
    try {
      const res = await apiClient.delete(`/workspaces/${workspaceId}/files/${id}`);
      if (!scope.active) return;
      if (res.data && res.data.success) {
        const removed = new Set([id]);
        // The API cascades through every descendant, including nested folders.
        let changed = true;
        while (changed) {
          changed = false;
          for (const item of filesRef.current) {
            if (item.parentId && removed.has(item.parentId) && !removed.has(item.id)) {
              removed.add(item.id);
              changed = true;
            }
          }
        }
        const remaining = filesRef.current.filter(item => !removed.has(item.id));
        setFiles(remaining);
        removeMissingSelection(remaining);
      }
    } catch (err: any) {
      throw new Error(err.response?.data?.error?.message || 'Failed to delete item');
    }
  }, [workspaceId, apiClient, setFiles, removeMissingSelection]);

  const saveFileContent = useCallback(async (fileId: string, content: string) => {
    const scope = scopeRef.current;
    if (!scope.active || scope.workspaceId !== workspaceId) return;
    const saveId = (saveIdsRef.current.get(fileId) || 0) + 1;
    saveIdsRef.current.set(fileId, saveId);
    const originalContent = filesRef.current.find(item => item.id === fileId)?.content;
    if (activeFileRef.current === fileId) setSaveStatus('saving');

    // Serialize saves for a file so an older request cannot finish last on the
    // server and overwrite a newer one. Saves for different files can overlap.
    const previous = saveQueuesRef.current.get(fileId) || Promise.resolve();
    const save = previous.catch(() => {}).then(async () => {
      if (!scope.active) return;
      try {
        const res = await apiClient.patch(`/workspaces/${workspaceId}/files/${fileId}`, { content });
        if (!scope.active || saveIdsRef.current.get(fileId) !== saveId) return;
        if (!res.data?.success) throw new Error('Failed to save changes');
        const cached = filesRef.current.find(item => item.id === fileId);
        const unchanged = cached?.content === originalContent || cached?.content === content;
        if (unchanged) {
          setFiles(prev => prev.map(item => item.id === fileId ? { ...item, content: res.data.data.content } : item));
        }
        if (activeFileRef.current === fileId) setSaveStatus(unchanged ? 'saved' : 'unsaved');
      } catch (err: any) {
        if (scope.active && saveIdsRef.current.get(fileId) === saveId && activeFileRef.current === fileId) {
          setSaveStatus('unsaved');
        }
        throw new Error(err.response?.data?.error?.message || err.message || 'Failed to save changes');
      }
    });
    saveQueuesRef.current.set(fileId, save);
    try {
      await save;
    } finally {
      if (saveQueuesRef.current.get(fileId) === save) saveQueuesRef.current.delete(fileId);
    }
  }, [workspaceId, apiClient, setFiles]);

  return {
    files,
    filesLoading,
    hasLoadedFiles,
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
