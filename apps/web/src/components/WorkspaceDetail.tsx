import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { 
  ArrowLeft, Users, Shield, ShieldAlert, ShieldCheck, UserPlus, 
  Trash2, LogOut, Check, X, Edit2, Loader2, Mail, Calendar,
  Folder, File, FolderPlus, FilePlus, ChevronDown, ChevronRight, Save, Terminal, Code
} from 'lucide-react';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'EDITOR' | 'VIEWER';
  joinedAt: string;
}

interface WorkspaceDetails {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  currentUserRole: 'OWNER' | 'EDITOR' | 'VIEWER';
  members: Member[];
}

interface FileSystemItem {
  id: string;
  name: string;
  type: 'FILE' | 'FOLDER';
  content: string | null;
  parentId: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceDetailProps {
  workspaceId: string;
  onBack: () => void;
  onWorkspaceDeleted: () => void;
}

export const WorkspaceDetail: React.FC<WorkspaceDetailProps> = ({ 
  workspaceId, 
  onBack,
  onWorkspaceDeleted 
}) => {
  const { apiClient, user } = useAuth();
  
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Tab State: 'editor' or 'settings'
  const [activeTab, setActiveTab] = useState<'editor' | 'settings'>('editor');

  // Workspace settings editing
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Invite member form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'EDITOR' | 'VIEWER'>('VIEWER');

  // File System Explorer State
  const [files, setFiles] = useState<FileSystemItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');

  // Inline Creation / Renaming State
  const [newItemType, setNewItemType] = useState<'FILE' | 'FOLDER' | null>(null);
  const [newItemParentId, setNewItemParentId] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState('');

  // Scroll Sync Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  // Fetch workspace details
  const fetchWorkspaceDetails = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.get(`/workspaces/${workspaceId}`);
      if (res.data && res.data.success) {
        setWorkspace(res.data.data);
        setEditName(res.data.data.name);
        setEditDesc(res.data.data.description || '');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to load workspace details');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, apiClient]);

  // Fetch workspace files
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

  useEffect(() => {
    fetchWorkspaceDetails();
    fetchFiles();
  }, [fetchWorkspaceDetails, fetchFiles]);

  // Sync scroll between textarea and line numbers
  const handleScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Handle auto-clearing success messages
  useEffect(() => {
    if (successMsg) {
      const timer = setTimeout(() => setSuccessMsg(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [successMsg]);

  // Handle file saving (auto-save with debouncing)
  useEffect(() => {
    if (!activeFileId) return;

    const activeFile = files.find(f => f.id === activeFileId);
    if (!activeFile) return;

    // If matches original content, it is saved
    if (activeFile.content === editorContent) {
      setSaveStatus('saved');
      return;
    }

    setSaveStatus('unsaved');
    const timer = setTimeout(() => {
      handleSaveFileContent(activeFileId, editorContent);
    }, 1500);

    return () => clearTimeout(timer);
  }, [editorContent, activeFileId, files]);

  if (loading) {
    return (
      <div className="workspace-loading glass-card">
        <Loader2 className="animate-spin text-purple-500" size={32} />
        <p>Loading workspace environments...</p>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div className="workspace-error glass-card">
        <X size={48} className="text-red-500 mb-2" />
        <h2 className="text-xl font-bold">Error Loading Workspace</h2>
        <p className="text-gray-400 mb-4">{error}</p>
        <button className="btn btn-secondary btn-icon" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back to Dashboard</span>
        </button>
      </div>
    );
  }

  if (!workspace) return null;

  const userRole = workspace.currentUserRole;
  const isOwner = userRole === 'OWNER';
  const isEditor = userRole === 'EDITOR';
  const canModifySettings = isOwner || isEditor;

  // File system explorer handlers
  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const selectFile = (file: FileSystemItem) => {
    setActiveFileId(file.id);
    setEditorContent(file.content || '');
    setSaveStatus('saved');
  };

  const handleCreateFile = async (name: string, type: 'FILE' | 'FOLDER', parentId: string | null) => {
    try {
      setError(null);
      const res = await apiClient.post(`/workspaces/${workspaceId}/files`, {
        name,
        type,
        parentId,
      });
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
        if (type === 'FILE') {
          selectFile(newItem);
        }
        setNewItemType(null);
        setNewItemParentId(null);
        setNewItemName('');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to create item');
    }
  };

  const handleRenameFile = async (id: string, name: string) => {
    try {
      setError(null);
      const res = await apiClient.patch(`/workspaces/${workspaceId}/files/${id}`, {
        name,
      });
      if (res.data && res.data.success) {
        setFiles(prev => prev.map(f => f.id === id ? { ...f, name: res.data.data.name } : f));
        setRenamingItemId(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to rename item');
    }
  };

  const handleDeleteFile = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this item? Recursively deletes folders.')) return;

    try {
      setError(null);
      const res = await apiClient.delete(`/workspaces/${workspaceId}/files/${id}`);
      if (res.data && res.data.success) {
        setFiles(prev => prev.filter(f => f.id !== id && f.parentId !== id));
        if (activeFileId === id) {
          setActiveFileId(null);
          setEditorContent('');
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to delete item');
    }
  };

  const handleSaveFileContent = async (fileId: string, content: string) => {
    setSaveStatus('saving');
    try {
      setError(null);
      const res = await apiClient.patch(`/workspaces/${workspaceId}/files/${fileId}`, {
        content,
      });
      if (res.data && res.data.success) {
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, content: res.data.data.content } : f));
        setSaveStatus('saved');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to save changes');
      setSaveStatus('unsaved');
    }
  };

  // Save workspace updates
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}`, {
        name: editName,
        description: editDesc,
      });
      if (res.data && res.data.success) {
        setWorkspace(prev => prev ? { 
          ...prev, 
          name: res.data.data.name, 
          description: res.data.data.description 
        } : null);
        setIsEditing(false);
        setSuccessMsg('Workspace settings updated successfully');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to update workspace');
    } finally {
      setActionLoading(false);
    }
  };

  // Invite member
  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/members`, {
        email: inviteEmail,
        role: inviteRole,
      });
      if (res.data && res.data.success) {
        setWorkspace(prev => prev ? {
          ...prev,
          members: [...prev.members, res.data.data]
        } : null);
        setInviteEmail('');
        setSuccessMsg(`Successfully invited ${inviteEmail}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to invite member');
    } finally {
      setActionLoading(false);
    }
  };

  // Change member role
  const handleRoleChange = async (targetUserId: string, newRole: 'EDITOR' | 'VIEWER') => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/members/${targetUserId}`, {
        role: newRole,
      });
      if (res.data && res.data.success) {
        setWorkspace(prev => prev ? {
          ...prev,
          members: prev.members.map(m => m.userId === targetUserId ? { ...m, role: res.data.data.role } : m)
        } : null);
        setSuccessMsg('Member permission level updated');
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to change role');
    } finally {
      setActionLoading(false);
    }
  };

  // Remove member or Leave Workspace
  const handleRemoveMember = async (targetUserId: string) => {
    const isSelf = targetUserId === user?.id;
    const confirmMessage = isSelf 
      ? 'Are you sure you want to leave this workspace? You will lose access to its files.'
      : 'Are you sure you want to remove this member?';
    
    if (!window.confirm(confirmMessage)) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.delete(`/workspaces/${workspaceId}/members/${targetUserId}`);
      if (res.data && res.data.success) {
        if (isSelf) {
          onBack(); 
        } else {
          setWorkspace(prev => prev ? {
            ...prev,
            members: prev.members.filter(m => m.userId !== targetUserId)
          } : null);
          setSuccessMsg('Member removed successfully');
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to remove member');
    } finally {
      setActionLoading(false);
    }
  };

  // Delete workspace
  const handleDeleteWorkspace = async () => {
    if (!window.confirm('CRITICAL: Are you sure you want to delete this workspace? This will permanently erase the workspace and ALL of its files. This action cannot be undone.')) return;

    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.delete(`/workspaces/${workspaceId}`);
      if (res.data && res.data.success) {
        onWorkspaceDeleted();
      }
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Failed to delete workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const getRoleIcon = (role: 'OWNER' | 'EDITOR' | 'VIEWER') => {
    switch (role) {
      case 'OWNER': return <ShieldCheck className="text-purple-400" size={16} />;
      case 'EDITOR': return <Shield className="text-blue-400" size={16} />;
      case 'VIEWER': return <ShieldAlert className="text-gray-400" size={16} />;
    }
  };

  // Recursive Tree Renderer
  const renderTree = (parentId: string | null, depth: number) => {
    const items = files.filter(f => f.parentId === parentId);
    return items.map(item => {
      const isFolder = item.type === 'FOLDER';
      const isExpanded = expandedFolders.has(item.id);
      const isSelected = activeFileId === item.id;
      const isRenaming = renamingItemId === item.id;

      return (
        <div key={item.id} className="tree-node-wrapper">
          <div 
            className={`tree-node ${isSelected ? 'selected' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 12}px` }}
            onClick={(e) => {
              e.stopPropagation();
              if (isFolder) {
                toggleFolder(item.id);
              } else {
                selectFile(item);
              }
            }}
          >
            <div className="tree-node-info">
              {isFolder ? (
                <>
                  {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                  <Folder size={14} className="text-yellow-500 fill-yellow-500/20" />
                </>
              ) : (
                <File size={14} className="text-purple-400" />
              )}
              
              {isRenaming ? (
                <input
                  type="text"
                  className="tree-inline-input"
                  value={renamingName}
                  onChange={e => setRenamingName(e.target.value)}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      if (renamingName.trim() && renamingName.trim() !== item.name) {
                        handleRenameFile(item.id, renamingName.trim());
                      } else {
                        setRenamingItemId(null);
                      }
                    } else if (e.key === 'Escape') {
                      setRenamingItemId(null);
                    }
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      setRenamingItemId(null);
                    }, 200);
                  }}
                />
              ) : (
                <span className="tree-node-name">{item.name}</span>
              )}
            </div>

            {!isRenaming && canModifySettings && (
              <div className="tree-node-actions" onClick={e => e.stopPropagation()}>
                {isFolder && (
                  <>
                    <button 
                      className="tree-action-btn"
                      title="New File"
                      onClick={() => {
                        setExpandedFolders(prev => {
                          const next = new Set(prev);
                          next.add(item.id);
                          return next;
                        });
                        setNewItemType('FILE');
                        setNewItemParentId(item.id);
                        setNewItemName('');
                      }}
                    >
                      <FilePlus size={12} />
                    </button>
                    <button 
                      className="tree-action-btn"
                      title="New Folder"
                      onClick={() => {
                        setExpandedFolders(prev => {
                          const next = new Set(prev);
                          next.add(item.id);
                          return next;
                        });
                        setNewItemType('FOLDER');
                        setNewItemParentId(item.id);
                        setNewItemName('');
                      }}
                    >
                      <FolderPlus size={12} />
                    </button>
                  </>
                )}
                <button 
                  className="tree-action-btn"
                  title="Rename"
                  onClick={() => {
                    setRenamingItemId(item.id);
                    setRenamingName(item.name);
                  }}
                >
                  <Edit2 size={12} />
                </button>
                <button 
                  className="tree-action-btn danger"
                  title="Delete"
                  onClick={(e) => handleDeleteFile(item.id, e)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </div>

          {/* Inline creation input inside this folder */}
          {isFolder && isExpanded && newItemType !== null && newItemParentId === item.id && (
            <div className="tree-inline-input-wrapper" style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}>
              {newItemType === 'FILE' ? <File size={14} className="text-purple-400" /> : <Folder size={14} className="text-purple-400" />}
              <input 
                type="text"
                placeholder={newItemType === 'FILE' ? "file.txt" : "folder_name"}
                className="tree-inline-input"
                value={newItemName}
                onChange={e => setNewItemName(e.target.value)}
                autoFocus
                onClick={e => e.stopPropagation()}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    if (newItemName.trim()) {
                      handleCreateFile(newItemName.trim(), newItemType, item.id);
                    } else {
                      setNewItemType(null);
                    }
                  } else if (e.key === 'Escape') {
                    setNewItemType(null);
                  }
                }}
                onBlur={() => {
                  setTimeout(() => {
                    if (!newItemName.trim()) {
                      setNewItemType(null);
                    }
                  }, 200);
                }}
              />
            </div>
          )}

          {isFolder && isExpanded && renderTree(item.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="workspace-detail-container">
      {/* Alert Overlays */}
      {error && (
        <div className="alert alert-danger glass-card">
          <X className="alert-close" onClick={() => setError(null)} size={16} />
          <span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="alert alert-success glass-card">
          <span>{successMsg}</span>
        </div>
      )}

      {/* Workspace Sub-Header */}
      <div className="workspace-detail-header glass-card">
        <button className="btn btn-secondary btn-icon" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Workspaces</span>
        </button>

        <div className="workspace-meta-actions">
          {isOwner && (
            <button className="btn btn-danger btn-icon" onClick={handleDeleteWorkspace} disabled={actionLoading}>
              <Trash2 size={16} />
              <span>Delete Workspace</span>
            </button>
          )}
          {!isOwner && (
            <button className="btn btn-secondary btn-icon text-red-400" onClick={() => handleRemoveMember(user!.id)} disabled={actionLoading}>
              <LogOut size={16} />
              <span>Leave Workspace</span>
            </button>
          )}
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="workspace-tabs">
        <button 
          className={`workspace-tab-btn ${activeTab === 'editor' ? 'active' : ''}`}
          onClick={() => setActiveTab('editor')}
        >
          <Code size={16} />
          <span>Code Editor</span>
        </button>
        <button 
          className={`workspace-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <Users size={16} />
          <span>Collaborators & Settings</span>
        </button>
      </div>

      {activeTab === 'editor' ? (
        <div className="workspace-ide-container glass-card">
          {/* File Explorer Sidebar */}
          <aside className="workspace-sidebar">
            <div className="explorer-header">
              <span className="explorer-title">Files</span>
              {canModifySettings && (
                <div className="explorer-actions">
                  <button 
                    className="explorer-action-btn" 
                    title="New File"
                    onClick={() => {
                      setNewItemType('FILE');
                      setNewItemParentId(null);
                      setNewItemName('');
                    }}
                  >
                    <FilePlus size={16} />
                  </button>
                  <button 
                    className="explorer-action-btn" 
                    title="New Folder"
                    onClick={() => {
                      setNewItemType('FOLDER');
                      setNewItemParentId(null);
                      setNewItemName('');
                    }}
                  >
                    <FolderPlus size={16} />
                  </button>
                </div>
              )}
            </div>

            <div className="file-tree-container">
              {filesLoading ? (
                <div className="loading-spinner">
                  <Loader2 className="animate-spin text-purple-500" size={20} />
                  <span className="text-xs">Loading tree...</span>
                </div>
              ) : (
                <>
                  {/* Inline creation at root level */}
                  {newItemType !== null && newItemParentId === null && (
                    <div className="tree-inline-input-wrapper">
                      {newItemType === 'FILE' ? <File size={14} className="text-purple-400" /> : <Folder size={14} className="text-purple-400" />}
                      <input 
                        type="text"
                        placeholder={newItemType === 'FILE' ? "file.txt" : "folder_name"}
                        className="tree-inline-input"
                        value={newItemName}
                        onChange={e => setNewItemName(e.target.value)}
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            if (newItemName.trim()) {
                              handleCreateFile(newItemName.trim(), newItemType, null);
                            } else {
                              setNewItemType(null);
                            }
                          } else if (e.key === 'Escape') {
                            setNewItemType(null);
                          }
                        }}
                        onBlur={() => {
                          setTimeout(() => {
                            if (!newItemName.trim()) {
                              setNewItemType(null);
                            }
                          }, 200);
                        }}
                      />
                    </div>
                  )}
                  {files.length === 0 && newItemType === null ? (
                    <div className="p-4 text-center text-xs text-gray-500">
                      Empty workspace. Create a file to begin!
                    </div>
                  ) : (
                    renderTree(null, 0)
                  )}
                </>
              )}
            </div>
          </aside>

          {/* Code Editor Area */}
          <main className="workspace-editor-pane">
            {activeFileId ? (
              <>
                <div className="editor-header">
                  <div className="editor-active-tab">
                    <File size={14} className="text-purple-400" />
                    <span>{files.find(f => f.id === activeFileId)?.name}</span>
                  </div>
                  <div className="editor-header-actions">
                    <span className={`save-status-indicator ${saveStatus}`}>
                      {saveStatus === 'saving' && 'Saving...'}
                      {saveStatus === 'unsaved' && 'Unsaved changes'}
                      {saveStatus === 'saved' && 'Saved'}
                    </span>
                    <button 
                      className="btn btn-primary btn-icon py-1 px-3 text-xs"
                      onClick={() => handleSaveFileContent(activeFileId, editorContent)}
                      disabled={saveStatus === 'saving' || !canModifySettings}
                    >
                      <Save size={12} />
                      <span>Save</span>
                    </button>
                  </div>
                </div>

                <div className="editor-body">
                  <div ref={lineNumbersRef} className="editor-line-numbers">
                    {editorContent.split('\n').map((_, i) => (
                      <div key={i}>{i + 1}</div>
                    ))}
                  </div>
                  <textarea
                    ref={textareaRef}
                    className="editor-textarea"
                    value={editorContent}
                    onChange={e => setEditorContent(e.target.value)}
                    onScroll={handleScroll}
                    placeholder="// Start coding in this workspace..."
                    disabled={!canModifySettings}
                  />
                </div>

                <div className="editor-statusbar">
                  <span>Lines: {editorContent.split('\n').length} | Chars: {editorContent.length}</span>
                </div>
              </>
            ) : (
              <div className="editor-welcome-screen">
                <Terminal size={48} className="text-purple-500 opacity-60 mb-2" />
                <h3>No File Opened</h3>
                <p>Select an existing file from the explorer sidebar or create a new one to start collaborating.</p>
              </div>
            )}
          </main>
        </div>
      ) : (
        /* Settings and Collaborators content tab */
        <div className="workspace-detail-layout">
          {/* Left Side: Detail & Workspace Info */}
          <section className="workspace-info-card glass-card">
            {isEditing ? (
              <form onSubmit={handleSaveSettings} className="edit-workspace-form">
                <div className="form-group">
                  <label htmlFor="editName">Workspace Name</label>
                  <input 
                    id="editName"
                    type="text" 
                    value={editName} 
                    onChange={e => setEditName(e.target.value)} 
                    required 
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="editDesc">Description</label>
                  <textarea 
                    id="editDesc"
                    value={editDesc} 
                    onChange={e => setEditDesc(e.target.value)} 
                    rows={4}
                  />
                </div>
                <div className="form-actions-inline">
                  <button type="submit" className="btn btn-primary btn-icon" disabled={actionLoading}>
                    <Check size={16} />
                    <span>Save</span>
                  </button>
                  <button type="button" className="btn btn-secondary btn-icon" onClick={() => setIsEditing(false)}>
                    <X size={16} />
                    <span>Cancel</span>
                  </button>
                </div>
              </form>
            ) : (
              <div className="workspace-view-content">
                <div className="title-area">
                  <h1 className="workspace-title gradient-text">{workspace.name}</h1>
                  {canModifySettings && (
                    <button className="edit-btn" onClick={() => setIsEditing(true)}>
                      <Edit2 size={16} />
                    </button>
                  )}
                </div>
                <p className="workspace-desc">
                  {workspace.description || 'No description provided for this collaborative workspace.'}
                </p>
                
                <div className="metadata-list">
                  <div className="meta-item">
                    <Calendar size={16} />
                    <span>Created: {new Date(workspace.createdAt).toLocaleDateString()}</span>
                  </div>
                  <div className="meta-item">
                    <ShieldCheck size={16} />
                    <span>Your Access: <strong className="role-label">{workspace.currentUserRole}</strong></span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Right Side: Members & Access controls */}
          <section className="workspace-members-card glass-card">
            <div className="panel-title-area">
              <Users size={20} className="card-icon" />
              <h2>Collaborators ({workspace.members.length})</h2>
            </div>

            {/* Invite form (only for OWNER/EDITOR) */}
            {canModifySettings && (
              <form onSubmit={handleInviteMember} className="invite-member-form">
                <h3>Invite Member</h3>
                <div className="invite-input-row">
                  <div className="input-with-icon flex-1">
                    <Mail size={16} className="input-icon" />
                    <input 
                      type="email" 
                      placeholder="User email address" 
                      value={inviteEmail} 
                      onChange={e => setInviteEmail(e.target.value)} 
                      required 
                    />
                  </div>
                  <select 
                    value={inviteRole} 
                    onChange={e => setInviteRole(e.target.value as any)}
                    className="role-select-invite"
                  >
                    <option value="EDITOR">Editor</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                  <button type="submit" className="btn btn-primary btn-icon" disabled={actionLoading}>
                    <UserPlus size={16} />
                    <span>Invite</span>
                  </button>
                </div>
              </form>
            )}

            {/* Members list */}
            <div className="members-list">
              {workspace.members.map((member) => {
                const isTargetSelf = member.userId === user?.id;
                const isTargetOwner = member.role === 'OWNER';

                return (
                  <div key={member.userId} className={`member-row ${isTargetSelf ? 'self-member' : ''}`}>
                    <div className="member-avatar">
                      {member.name.charAt(0).toUpperCase()}
                    </div>
                    
                    <div className="member-info">
                      <div className="name-row">
                        <span className="member-name">{member.name}</span>
                        {isTargetSelf && <span className="self-badge">You</span>}
                      </div>
                      <span className="member-email">{member.email}</span>
                    </div>

                    <div className="member-role-area">
                      {isOwner && !isTargetOwner && !isTargetSelf ? (
                        <select 
                          value={member.role}
                          onChange={(e) => handleRoleChange(member.userId, e.target.value as any)}
                          disabled={actionLoading}
                          className="role-dropdown"
                        >
                          <option value="EDITOR">Editor</option>
                          <option value="VIEWER">Viewer</option>
                        </select>
                      ) : (
                        <div className="member-role-badge">
                          {getRoleIcon(member.role)}
                          <span>{member.role}</span>
                        </div>
                      )}

                      {((isOwner && !isTargetOwner) || isTargetSelf) && (
                        <button 
                          className="remove-member-btn" 
                          onClick={() => handleRemoveMember(member.userId)}
                          disabled={actionLoading}
                          title={isTargetSelf ? "Leave Workspace" : "Remove member"}
                        >
                          {isTargetSelf ? <LogOut size={14} /> : <Trash2 size={14} />}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
