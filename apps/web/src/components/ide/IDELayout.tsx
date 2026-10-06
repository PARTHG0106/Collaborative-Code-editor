import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { IDEThemeProvider, useTheme } from './IDEThemeProvider';
import { ActivityBar, ActivityType } from './ActivityBar';
import { TopBar } from './TopBar';
import { QuickOpen } from './QuickOpen';
import { getFilePath } from './filePaths';
import { useEditorPreferences } from './hooks/useEditorPreferences';
import { useEditorSession } from './hooks/useEditorSession';
import { reconcileEditorSession } from '../../lib/editorSession';
import { useWorkspaceDownloads } from './hooks/useWorkspaceDownloads';
import { ExplorerPanel } from './sidebar/ExplorerPanel';
import { SearchPanel } from './sidebar/SearchPanel';
import { CollaboratorsPanel } from './sidebar/CollaboratorsPanel';
import { SnapshotsPanel } from './sidebar/SnapshotsPanel';
import { SettingsPanel } from './sidebar/SettingsPanel';
import { RightPanel } from './RightPanel';
import { useFileSystem, FileSystemItem } from './hooks/useFileSystem';
import { useWorkspaceSocket } from './hooks/useWorkspaceSocket';
import { ExecutionOrchestrator, getLangFromFilename } from '../../lib/execution/ExecutionOrchestrator';
import { RemoteExecutionSession } from '../../lib/execution/RemoteExecutionSession';
import { TerminalPanel } from '../../lib/execution/terminal/TerminalPanel';
import { TerminalManager } from '../../lib/execution/terminal/TerminalManager';
import { TerminalSession, TerminalStatus } from '../../lib/execution/terminal/TerminalSession';
import { AgentConnector } from '../../lib/execution/AgentConnector';
import { ExecutionTarget } from '../../lib/execution/types';
import { NotebookRenderer } from '../../lib/execution/notebook/NotebookRenderer';
import { useNotebook } from './hooks/useNotebook';
import Editor from '@monaco-editor/react';
import { useCollaborativeFiles } from './hooks/useCollaborativeFiles';
import { normalizeEditorContent, editorOffsetToDocumentOffset, documentOffsetToEditorOffset, mapEditorChanges } from '../../lib/EditorText';
import {
  File, X, Terminal as TerminalIcon, Loader2, Play, Square
} from 'lucide-react';
import './IDELayout.css';

// --- Helpers ---
const getLanguage = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown',
    sql: 'sql', sh: 'shell', yml: 'yaml', yaml: 'yaml',
    c: 'c', cpp: 'cpp', java: 'java', go: 'go', rs: 'rust',
    ipynb: 'jupyter'
  };
  return map[ext || ''] || 'plaintext';
};

const getColor = (id: string) => {
  const colors = ['#556B5D','#70806e','#8f9e8b','#a99f8c','#5d6b70','#7f8e94','#5c6454','#58705c','#6e8572'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h % colors.length)];
};

const ensureCursorStyle = (userId: string, name: string) => {
  const styleId = `cursor-${userId}`;
  if (document.getElementById(styleId)) return;
  const color = getColor(userId);
  const style = document.createElement('style');
  style.id = styleId;
  style.innerHTML = `.rc-${userId}{border-left:2px solid ${color}!important;position:relative}.rc-${userId}::after{content:"${name}";position:absolute;top:-16px;left:0;background:${color};color:#fff;font-size:8px;line-height:10px;padding:1px 4px;border-radius:2px;white-space:nowrap;pointer-events:none;z-index:1000;font-family:sans-serif;font-weight:600;opacity:.85}`;
  document.head.appendChild(style);
};



// --- Workspace Details interface ---
interface WorkspaceDetails {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  currentUserRole: 'OWNER' | 'EDITOR' | 'VIEWER';
  members: { userId: string; name: string; email: string; role: 'OWNER' | 'EDITOR' | 'VIEWER'; joinedAt: string }[];
}

// --- Inner IDE Component (needs theme context) ---
const IDEInner: React.FC<{ workspaceId: string; onBack: () => void }> = ({ workspaceId, onBack }) => {
  const { apiClient, user } = useAuth();
  const { theme } = useTheme();
  const { preferences, setPreferences } = useEditorPreferences();

  // Workspace data
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // UI state
  const [activity, setActivity] = useState<ActivityType>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(() => window.innerWidth > 1024);
  const [chatTabVisible, setChatTabVisible] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [cursorPosition, setCursorPosition] = useState({ lineNumber: 1, column: 1 });
  const previousPanelsRef = useRef({ sidebar: true, right: true });
  const pendingNavigationRef = useRef<{ fileId: string; lineNumber?: number } | null>(null);
  const [openTabs, setOpenTabs] = useState<FileSystemItem[]>([]);
  const [preview, setPreview] = useState<{ fileId: string; content: string } | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const tabsTouchedRef = useRef(false);
  const foldersTouchedRef = useRef(false);
  const { savedSession, saveNavigation, getPosition, savePosition } = useEditorSession(user?.id, workspaceId);

  // Execution state
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget | null>(null);
  const [runTarget, setRunTarget] = useState<'auto' | ExecutionTarget>('auto');
  const [agentConnected, setAgentConnected] = useState(false);
  const orchestratorRef = useRef(new ExecutionOrchestrator());
  const remoteExecutionRef = useRef<RemoteExecutionSession | null>(null);
  const executionAttemptRef = useRef(0);
  const terminalManagerRef = useRef<TerminalManager | null>(null);
  const [terminalManager, setTerminalManager] = useState<TerminalManager | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>('disconnected');
  const terminalSessionRef = useRef<TerminalSession | null>(null);
  const agentRef = useRef(new AgentConnector());
  
  // Auto-detect local agent on mount
  useEffect(() => {
    const agent = agentRef.current;
    agent.onStatus((connected, runtimes) => {
      setAgentConnected(connected);
      orchestratorRef.current.setAgentStatus(connected, runtimes);
      if (connected) {
        orchestratorRef.current.setAgentInputHandler((text) => agent.sendInput(text));
      }
    });

    // Try connecting
    agent.connect().then((ok) => {
      if (ok) console.log('🔌 Local agent connected');
    });

    // Retry every 10s
    const interval = setInterval(() => {
      if (!agent.isConnected()) {
        agent.connect().catch(() => {});
      }
    }, 10000);

    return () => {
      clearInterval(interval);
      agent.disconnect();
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault(); setQuickOpen(value => !value); return;
      }
      if (e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
        e.preventDefault(); setSidebarVisible(value => !value); return;
      }
      if (e.key.toLowerCase() === 'f' && e.shiftKey) {
        e.preventDefault(); setActivity('search'); setSidebarVisible(true); return;
      }
      // Toggle Terminal (Ctrl+`)
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        setTerminalOpen(prev => !prev);
        if (!terminalOpen) {
          setTimeout(() => terminalManagerRef.current?.focus(), 50);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [terminalOpen]);

  const ws = useWorkspaceSocket(workspaceId, rightPanelOpen && chatTabVisible);
  useEffect(() => () => {
    const execution = remoteExecutionRef.current;
    if (!execution) return;
    execution.cancel();
    execution.dispose();
    remoteExecutionRef.current = null;
    orchestratorRef.current.cancel();
    setIsExecuting(false);
    setExecutionTarget(null);
  }, [ws.socket, workspaceId]);
  const fs = useFileSystem(workspaceId, ws.socket);
  const activeFile = fs.files.find(file => file.id === fs.activeFileId);
  const canModify = !!workspace && workspace.currentUserRole !== 'VIEWER';
  const activeFileIdRef = useRef(fs.activeFileId);
  activeFileIdRef.current = fs.activeFileId;
  const editorSourceRef = useRef(activeFile?.content ?? '');
  const collaboration = useCollaborativeFiles(ws.socket, fs.activeFileId, activeFile?.content ?? '', (fileId, content) => {
    if (fileId === activeFileIdRef.current) editorSourceRef.current = content;
    fs.setFiles(files => files.map(file => file.id === fileId && file.content !== content ? { ...file, content } : file));
  });
  const downloads = useWorkspaceDownloads(workspaceId, workspace?.name || 'workspace', collaboration.getDownloadContents);
  const editorContent = collaboration.content;
  editorSourceRef.current = editorContent;
  const notebook = useNotebook({
    fileId: fs.activeFileId,
    content: editorContent,
    enabled: getLanguage(activeFile?.name ?? '') === 'jupyter' && preview?.fileId !== fs.activeFileId,
    writable: canModify && collaboration.ready,
    onChange: collaboration.replaceContent,
  });
  const cursorSocketRef = useRef(ws.socket);
  cursorSocketRef.current = ws.socket;
  const editorRef = useRef<any>(null);
  const mountedEditorRef = useRef<{ editor: any; fileId: string; restored: boolean } | null>(null);
  const collaborationReadyRef = useRef(collaboration.ready);
  collaborationReadyRef.current = collaboration.ready;
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<Map<string, string[]>>(new Map());
  const revealPendingLine = useCallback(() => {
    const pending = pendingNavigationRef.current;
    const editor = editorRef.current;
    const mounted = mountedEditorRef.current;
    if (!editor || !mounted || mounted.editor !== editor || mounted.fileId !== fs.activeFileId
      || preview?.fileId === fs.activeFileId || getLanguage(activeFile?.name ?? '') === 'jupyter') return;
    const navigation = pending?.fileId === mounted.fileId ? pending : null;
    if (navigation?.lineNumber && !collaboration.ready) return;
    if (collaboration.ready && (!mounted.restored || navigation?.lineNumber)) {
      const target = navigation?.lineNumber
        ? { lineNumber: navigation.lineNumber, column: 1 }
        : getPosition(mounted.fileId);
      mounted.restored = true;
      if (target) {
        const model = editor.getModel();
        const lineNumber = Math.max(1, Math.min(target.lineNumber, model.getLineCount()));
        const position = { lineNumber, column: Math.max(1, Math.min(target.column, model.getLineMaxColumn(lineNumber))) };
        editor.setPosition(position);
        editor.revealLineInCenter(lineNumber);
        setCursorPosition(position);
        savePosition(mounted.fileId, position);
      }
    }
    if (navigation) {
      editor.focus();
      pendingNavigationRef.current = null;
    }
  }, [fs.activeFileId, collaboration.ready, activeFile?.name, preview, getPosition, savePosition]);
  // Monaco retains its initial onMount callback while its loader is pending.
  const revealPendingLineRef = useRef(revealPendingLine);
  revealPendingLineRef.current = revealPendingLine;

  useEffect(() => {
    // Let Monaco receive the synchronized content before navigating in it.
    const frame = requestAnimationFrame(revealPendingLine);
    return () => cancelAnimationFrame(frame);
  }, [revealPendingLine]);

  useEffect(() => {
    terminalManager?.setRawMode(!isExecuting);
    terminalManager?.setInputEnabled(isExecuting || terminalStatus === 'ready');
  }, [isExecuting, terminalManager, terminalStatus]);

  useEffect(() => {
    if (!terminalManager || !ws.socket) {
      setTerminalStatus('disconnected');
      return;
    }
    const session = new TerminalSession(ws.socket, terminalManager, workspaceId, setTerminalStatus);
    terminalSessionRef.current = session;
    return () => {
      session.dispose();
      if (terminalSessionRef.current === session) terminalSessionRef.current = null;
    };
  }, [terminalManager, ws.socket, workspaceId]);

  useEffect(() => {
    return terminalManager?.onData(input => orchestratorRef.current.sendInput(input));
  }, [terminalManager]);

  const handleTerminalReady = useCallback((manager: TerminalManager) => {
    manager.setInputEnabled(false);
    terminalManagerRef.current = manager;
    setTerminalManager(manager);
  }, []);

  const handleTerminalDispose = useCallback((manager: TerminalManager) => {
    if (terminalManagerRef.current === manager) terminalManagerRef.current = null;
    setTerminalManager(current => current === manager ? null : current);
  }, []);

  // Versions
  const [versions, setVersions] = useState<any[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  // Fetch workspace
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await apiClient.get(`/workspaces/${workspaceId}`);
        if (res.data?.success) setWorkspace(res.data.data);
      } catch (e: any) {
        setError(e.response?.data?.error?.message || 'Failed to load workspace');
      } finally {
        setLoading(false);
      }
    })();
  }, [workspaceId, apiClient]);

  // Fetch files
  useEffect(() => { fs.fetchFiles(); }, []);

  useEffect(() => {
    if (sessionReady || loading || workspace?.id !== workspaceId || !user?.id || !fs.hasLoadedFiles) return;
    if (savedSession) {
      const restored = reconcileEditorSession(savedSession, fs.files);
      const filesById = new Map(fs.files.map(file => [file.id, file]));
      // A retry may finish after the user has created files or closed tabs.
      // Their current navigation takes precedence over the previous session.
      if (!tabsTouchedRef.current) {
        setOpenTabs(restored.openFileIds.map(id => filesById.get(id)!));
        fs.setActiveFileId(restored.activeFileId);
      }
      if (!foldersTouchedRef.current) {
        fs.setExpandedFolders(current => new Set([...restored.expandedFolderIds, ...current]));
      }
    }
    // Persist on the next render, after the restored tabs and selection commit.
    setSessionReady(true);
  }, [sessionReady, loading, workspace?.id, workspaceId, user?.id, fs.hasLoadedFiles, fs.files, fs.setActiveFileId, fs.setExpandedFolders, savedSession]);

  // Contents change on each edit; only navigation changes trigger an immediate write.
  const openFileIdsKey = JSON.stringify(openTabs.map(file => file.id));
  const expandedFolderIdsKey = JSON.stringify([...fs.expandedFolders]);
  useEffect(() => {
    if (sessionReady) saveNavigation(JSON.parse(openFileIdsKey), fs.activeFileId, JSON.parse(expandedFolderIdsKey));
  }, [sessionReady, openFileIdsKey, fs.activeFileId, expandedFolderIdsKey, saveNavigation]);

  useEffect(() => {
    setPreview(null);
    setVersions([]);
    decorationsRef.current.clear();
  }, [fs.activeFileId]);

  useEffect(() => {
    if (!fs.hasLoadedFiles || fs.filesLoading) return;
    setOpenTabs(tabs => tabs.flatMap(tab => {
      const current = fs.files.find(file => file.id === tab.id);
      return current?.type === 'FILE' ? [current] : [];
    }));
  }, [fs.files, fs.filesLoading, fs.hasLoadedFiles]);

  useEffect(() => {
    const socket = ws.socket;
    if (!socket) return;
    const onCursor = ({ fileId, userId, name, cursor }: any) => {
      if (fileId !== fs.activeFileId || !Number.isInteger(cursor?.offset)) return;
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!model || !monacoRef.current) return;
      ensureCursorStyle(userId, name);
      const pos = model.getPositionAt(documentOffsetToEditorOffset(editorSourceRef.current, cursor.offset));
      const range = new monacoRef.current.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
      const decorations = editor.deltaDecorations(decorationsRef.current.get(userId) || [], [{ range, options: { className: 'rc-' + userId, hoverMessage: { value: name } } }]);
      decorationsRef.current.set(userId, decorations);
    };
    socket.on('cursor_update', onCursor);
    return () => { socket.off('cursor_update', onCursor); };
  }, [ws.socket, fs.activeFileId]);

  const handleEditorMount = (editor: any, monaco: any) => {
    const fileId = fs.activeFileId;
    if (!fileId || fileId !== activeFileIdRef.current) return;
    editorRef.current = editor;
    const mounted = { editor, fileId, restored: false };
    mountedEditorRef.current = mounted;
    setCursorPosition({ lineNumber: 1, column: 1 });
    monacoRef.current = monaco;
    // Monaco normalizes line endings in its model. Keep its view in LF and
    // translate positions against the file's original text at the boundary.
    const mountedModel = editor.getModel();
    const ensureLF = () => {
      if (mountedModel && mountedModel.getEOL() !== '\n') mountedModel.setEOL(monaco.editor.EndOfLineSequence.LF);
    };
    ensureLF();
    // A read-only setValue can rebuild an empty model with Windows defaults.
    const modelSubscription = mountedModel?.onDidChangeContent((event: any) => {
      if (event.isFlush || event.isEolChange) ensureLF();
    });
    const subscription = editor.onDidChangeCursorPosition((event: any) => {
      if (mountedEditorRef.current !== mounted || activeFileIdRef.current !== fileId) return;
      const position = { lineNumber: event.position.lineNumber || 1, column: event.position.column };
      setCursorPosition(position);
      // Model flushes and pre-sync defaults must not erase a remembered cursor.
      if (mounted.restored && collaborationReadyRef.current && event.reason !== 1) savePosition(fileId, position);
      // Token refresh can replace the socket without remounting this editor.
      const socket = cursorSocketRef.current;
      const model = editor.getModel();
      if (socket?.connected && fileId && model) socket.emit('cursor_move', { fileId, cursor: { offset: editorOffsetToDocumentOffset(editorSourceRef.current, model.getOffsetAt(event.position)) } });
    });
    editor.onDidDispose(() => {
      subscription.dispose(); modelSubscription?.dispose();
      if (editorRef.current === editor) editorRef.current = null;
      if (mountedEditorRef.current === mounted) mountedEditorRef.current = null;
    });
    requestAnimationFrame(() => revealPendingLineRef.current());
  };

  // Fetch versions when snapshots panel is active
  const fetchVersions = useCallback(async () => {
    if (!fs.activeFileId) return;
    const fileId = fs.activeFileId;
    setVersionsLoading(true);
    try {
      const res = await apiClient.get(`/workspaces/${workspaceId}/files/${fileId}/versions`);
      if (activeFileIdRef.current === fileId && res.data?.success) setVersions(res.data.data);
    } catch { setError('Could not load snapshots. Reopen the Snapshots panel to try again.'); } finally { if (activeFileIdRef.current === fileId) setVersionsLoading(false); }
  }, [fs.activeFileId, workspaceId, apiClient]);

  useEffect(() => { if (activity === 'snapshots') fetchVersions(); }, [activity, fs.activeFileId, fetchVersions]);

  // Handlers
  const selectFile = (file: FileSystemItem, lineNumber?: number) => {
    tabsTouchedRef.current = true;
    if (lineNumber && !file.name.endsWith('.ipynb')) {
      pendingNavigationRef.current = { fileId: file.id, lineNumber };
      if (fs.activeFileId === file.id && !preview) revealPendingLine();
    } else pendingNavigationRef.current = null;
    fs.setActiveFileId(file.id);
    setPreview(null);
    setOpenTabs(prev => prev.find(t => t.id === file.id) ? prev : [...prev, file]);
    if (window.innerWidth <= 768) setSidebarVisible(false);
  };

  const toggleFocusMode = () => {
    if (!sidebarVisible && !rightPanelOpen) {
      setSidebarVisible(previousPanelsRef.current.sidebar);
      setRightPanelOpen(previousPanelsRef.current.right);
    } else {
      previousPanelsRef.current = { sidebar: sidebarVisible, right: rightPanelOpen };
      setSidebarVisible(false);
      setRightPanelOpen(false);
    }
  };

  const closeTab = (id: string) => {
    tabsTouchedRef.current = true;
    setOpenTabs(prev => prev.filter(t => t.id !== id));
    if (fs.activeFileId === id) {
      const remaining = openTabs.filter(t => t.id !== id);
      if (remaining.length) selectFile(remaining[remaining.length - 1]);
      else fs.setActiveFileId(null);
    }
  };

  const handleActivity = (a: ActivityType) => {
    if (a === activity && sidebarVisible) setSidebarVisible(false);
    else { setActivity(a); setSidebarVisible(true); }
  };

  const handleInvite = async (email: string, role: 'EDITOR' | 'VIEWER') => {
    setError(null);
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/members`, { email, role });
      if (!res.data?.success) throw new Error('Invite failed');
      setWorkspace(prev => prev ? { ...prev, members: [...prev.members, res.data.data] } : null);
      return true;
    } catch (e: any) { setError(e.response?.data?.error?.message || 'Failed to invite. Please try again.'); return false; }
  };

  const handleRoleChange = async (userId: string, role: 'EDITOR' | 'VIEWER') => {
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/members/${userId}`, { role });
      if (res.data?.success) setWorkspace(prev => prev ? { ...prev, members: prev.members.map(m => m.userId === userId ? { ...m, role: res.data.data.role } : m) } : null);
    } catch { setError('Could not change this member’s role. Please try again.'); }
  };

  const handleRemoveMember = async (userId: string) => {
    const isSelf = userId === user?.id;
    if (!window.confirm(isSelf ? 'Leave this workspace?' : 'Remove this member?')) return;
    try {
      await apiClient.delete(`/workspaces/${workspaceId}/members/${userId}`);
      if (isSelf) onBack();
      else setWorkspace(prev => prev ? { ...prev, members: prev.members.filter(m => m.userId !== userId) } : null);
    } catch { setError(isSelf ? 'Could not leave the workspace. Please try again.' : 'Could not remove this member. Please try again.'); }
  };

  const handleSaveSettings = async (name: string, desc: string) => {
    setError(null);
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}`, { name, description: desc });
      if (!res.data?.success) throw new Error('Save failed');
      setWorkspace(prev => prev ? { ...prev, name: res.data.data.name, description: res.data.data.description } : null);
      return true;
    } catch { setError('Could not save workspace settings. Your draft is still available.'); return false; }
  };

  const handleDeleteWorkspace = async () => {
    if (!window.confirm('Delete this workspace permanently?')) return;
    try { await apiClient.delete(`/workspaces/${workspaceId}`); onBack(); } catch { setError('Could not delete the workspace. Please try again.'); }
  };

  const handleEditorAreaClick = () => {
    if (window.innerWidth <= 768 && sidebarVisible) {
      setSidebarVisible(false);
    }
  };

  const handleCreateSnapshot = async () => {
    if (!fs.activeFileId || !canModify || collaboration.saveStatus !== 'saved') return;
    const fileId = fs.activeFileId;
    setActionLoading(true);
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/files/${fileId}/versions`);
      if (activeFileIdRef.current === fileId && res.data?.success) setVersions(prev => [res.data.data, ...prev]);
    } catch { setError('Could not create a snapshot. Please try again.'); } finally { setActionLoading(false); }
  };

  const handlePreviewVersion = async (versionId: string) => {
    if (!fs.activeFileId) return;
    const fileId = fs.activeFileId;
    setActionLoading(true);
    try {
      const res = await apiClient.get('/workspaces/' + workspaceId + '/files/' + fileId + '/versions/' + versionId);
      if (res.data?.success) setPreview({ fileId, content: res.data.data.content });
    } catch { setError('Failed to load snapshot'); } finally { setActionLoading(false); }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!fs.activeFileId || !canModify || !collaboration.ready) return;
    const fileId = fs.activeFileId;
    setActionLoading(true);
    try {
      const res = await apiClient.get('/workspaces/' + workspaceId + '/files/' + fileId + '/versions/' + versionId);
      if (res.data?.success) {
        collaboration.replaceContent(fileId, res.data.data.content);
        setPreview(null);
      }
    } catch { setError('Failed to restore snapshot'); } finally { setActionLoading(false); }
  };

  const handleRunCode = async () => {
    if (!fs.activeFileId || isExecuting || remoteExecutionRef.current) return;
    const file = fs.files.find(f => f.id === fs.activeFileId);
    if (!file) return;
    const attempt = ++executionAttemptRef.current;

    const lang = getLangFromFilename(file.name);
    setIsExecuting(true);
    setTerminalOpen(true);
    
    // Wait for the TerminalPanel to mount and initialize the manager
    let retries = 0;
    while (!terminalManagerRef.current && retries < 20 && attempt === executionAttemptRef.current) {
      await new Promise(r => setTimeout(r, 50));
      retries++;
    }

    if (attempt !== executionAttemptRef.current) return;

    if (!terminalManagerRef.current) {
      setIsExecuting(false);
      setError('The terminal could not open. Try running the file again.');
      return;
    }
    if (!lang) {
      terminalManagerRef.current.writeStderr(`Unsupported file type: .${file.name.split('.').pop()}\r\n`);
      setIsExecuting(false);
      return;
    }
    
    const target = runTarget === 'auto' ? orchestratorRef.current.selectTarget(lang) : runTarget;
    setExecutionTarget(target);

    await orchestratorRef.current.execute(
      file.name,
      editorContent,
      {
        onStdout: (data) => terminalManagerRef.current?.writeStdout(data),
        onStderr: (data) => terminalManagerRef.current?.writeStderr(data),
        onExit: (code) => {
          setIsExecuting(false);
          setExecutionTarget(null);
          const color = code === 0 ? '\x1b[32m' : '\x1b[31m';
          terminalManagerRef.current?.writeStdout(
            `\r\n${color}[Process exited with code ${code}]\x1b[0m\r\n`
          );
        },
      },
      // Agent executor
      agentRef.current.isConnected()
        ? (lang, code, cb) => agentRef.current.execute(lang, code, cb)
        : undefined,
      // Remote executor
      async (lang, code, cb, target) => {
        if (!ws.socket?.connected) {
          cb.onStderr('WebSocket not connected\r\n');
          cb.onExit(1);
          return;
        }
        
        const execution = new RemoteExecutionSession(ws.socket, {
          workspaceId,
          fileId: file.id,
          language: lang,
          code,
          target,
        }, {
          ...cb,
          onExit: exitCode => {
            if (remoteExecutionRef.current === execution) remoteExecutionRef.current = null;
            cb.onExit(exitCode);
          },
        });
        remoteExecutionRef.current = execution;
        orchestratorRef.current.setRemoteInputHandler(input => remoteExecutionRef.current?.sendInput(input));
        execution.start();
      },
      target
    );
  };

  const handleStopCode = () => {
    if (remoteExecutionRef.current) {
      remoteExecutionRef.current.cancel();
      return;
    }
    executionAttemptRef.current++;
    orchestratorRef.current.cancel();
    setIsExecuting(false);
    setExecutionTarget(null);
    terminalManagerRef.current?.writeStderr('\r\n[Execution cancelled]\r\n');
  };

  // Loading state
  if (loading) return <div className={`ide-root ${theme === 'dark' ? 'ide-dark' : ''}`} style={{ alignItems: 'center', justifyContent: 'center' }}><Loader2 size={24} className="animate-spin" style={{ color: 'var(--ide-accent)' }} /></div>;
  if (!workspace) return <div className={`ide-root ${theme === 'dark' ? 'ide-dark' : ''}`} style={{ alignItems: 'center', justifyContent: 'center', gap: 8 }}><span>Failed to load workspace</span><button className="ide-btn" onClick={onBack}>Back</button></div>;

  const isOwner = workspace.currentUserRole === 'OWNER';
  const editorLang = activeFile ? getLanguage(activeFile.name) : 'plaintext';

  return (
    <div className={`ide-root ${theme === 'dark' ? 'ide-dark' : ''}`}>
      <TopBar
        workspaceName={workspace.name}
        collaboratorCount={ws.activeCollaborators.length}
        isConnected={ws.isConnected}
        presenceReady={ws.presenceReady}
        userName={user?.name || ''}
        onBack={() => { if (!collaboration.hasPendingChanges || window.confirm('Changes or recovered copies are still unsaved. Leave this workspace?')) onBack(); }}
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={() => setRightPanelOpen(p => !p)}
        unreadMessages={ws.unreadMessages}
        onQuickOpen={() => setQuickOpen(true)}
        focusMode={!sidebarVisible && !rightPanelOpen}
        onToggleFocusMode={toggleFocusMode}
      />
      {(error || collaboration.error || ws.permissionError) && <div role="alert" style={{ padding: 8, color: 'var(--ide-danger)' }}>{error || collaboration.error || ws.permissionError}</div>}
      {(downloads.downloading || downloads.error || downloads.notice) && <div className={`ide-download-notice${downloads.error ? ' error' : ''}`} role={downloads.error ? 'alert' : 'status'}>
        <span>{downloads.downloading ? 'Preparing download with current editor changes…' : downloads.error || downloads.notice}</span>
        {!downloads.downloading && <button type="button" className="ide-icon-btn" aria-label="Dismiss download message" onClick={downloads.dismissFeedback}><X size={14} aria-hidden="true" /></button>}
      </div>}
      {collaboration.recoveries.map(draft => <div role="alert" key={`${draft.fileId}-${draft.id}`} style={{ padding: 8 }}>
        An unsynced copy was preserved. Download it to keep your changes.
        <button className="ide-btn" onClick={() => {
          const url = URL.createObjectURL(new Blob([draft.content], { type: 'text/plain' }));
          const link = document.createElement('a'); link.href = url;
          link.download = 'recovered-' + (fs.files.find(file => file.id === draft.fileId)?.name || 'file.txt');
          link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Download preserved copy</button>
        <button className="ide-btn" onClick={() => {
          if (window.confirm('Dismiss this preserved copy? Download it first if you need it.')) collaboration.dismissRecovery(draft.fileId, draft.id);
        }}>Dismiss preserved copy</button>
      </div>)}
      <div className="ide-body">
        <ActivityBar active={activity} onSelect={handleActivity} sidebarVisible={sidebarVisible} />

        <div className={`ide-sidebar ${!sidebarVisible ? 'collapsed' : 'mobile-open'}`}>
          {activity === 'explorer' && (
            <ExplorerPanel
              files={fs.files} filesLoading={fs.filesLoading} activeFileId={fs.activeFileId}
              expandedFolders={fs.expandedFolders} canModify={canModify}
              onSelectFile={selectFile}
              onToggleFolder={id => {
                foldersTouchedRef.current = true;
                fs.setExpandedFolders(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
              }}
              onCreateFile={(name, type, parentId, content) => fs.createFile(name, type, parentId, content).then(item => { if (item && type === 'FILE') selectFile(item); return item; })}
              onRenameFile={fs.renameFile} onDeleteFile={fs.deleteFile}
              onDownloadWorkspace={() => void downloads.downloadWorkspace()}
              onDownloadFile={id => void downloads.downloadFile(id)}
              downloading={downloads.downloading}
            />
          )}
          {activity === 'search' && <SearchPanel files={fs.files} onOpenFile={selectFile} />}
          {activity === 'collaborators' && (
            <CollaboratorsPanel
              members={workspace.members} currentUserId={user?.id || ''} currentUserRole={workspace.currentUserRole}
              activeCollaborators={ws.activeCollaborators} presenceReady={ws.presenceReady} canModify={canModify}
              onInvite={handleInvite} onChangeRole={handleRoleChange} onRemoveMember={handleRemoveMember}
            />
          )}
          {activity === 'snapshots' && (
            <SnapshotsPanel
              activeFileId={fs.activeFileId} activeFileName={activeFile?.name || null}
              versions={versions} loading={versionsLoading} actionLoading={actionLoading || !canModify || !collaboration.ready || collaboration.saveStatus !== 'saved'}
              onCreateSnapshot={handleCreateSnapshot}
              onPreview={handlePreviewVersion}
              onRestore={handleRestoreVersion}
            />
          )}
          {activity === 'settings' && (
            <SettingsPanel
              workspace={workspace} isOwner={isOwner} canModify={canModify}
              onSave={handleSaveSettings} onDelete={handleDeleteWorkspace}
              onLeave={() => handleRemoveMember(user?.id || '')}
              editorPreferences={preferences}
              onEditorPreferencesChange={setPreferences}
            />
          )}
        </div>

        <div className="ide-editor-area" onPointerDownCapture={handleEditorAreaClick}>
          {/* Tab Bar */}
          <div className="ide-tabs-bar">
            <div style={{ display: 'flex', flex: 1, overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              {openTabs.map(tab => (
                <div
                  key={tab.id}
                  className={`ide-tab ${fs.activeFileId === tab.id ? 'active' : ''}`}
                  style={{ flexShrink: 0 }}
                >
                  <button className="ide-tab-select" aria-pressed={fs.activeFileId === tab.id} title={getFilePath(tab, fs.files)} onClick={() => selectFile(tab)}>
                  <File size={12} style={{ color: 'var(--ide-accent)', flexShrink: 0 }} />
                  {tab.name}
                  </button>
                  <button className="ide-tab-close" aria-label={`Close ${tab.name}`} onClick={() => closeTab(tab.id)}>
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
            
            {/* Run / Stop Button */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: '8px', gap: '4px' }}>
              {!isExecuting && (
                <select
                  aria-label="Run code using"
                  value={runTarget}
                  onChange={(e) => setRunTarget(e.target.value as any)}
                  className="ide-btn"
                  style={{ height: '24px', padding: '0 6px', fontSize: '11px', outline: 'none', appearance: 'menulist', backgroundColor: 'var(--ide-bg-light, #2e2e2e)', color: 'var(--ide-fg, #e0e0e0)' }}
                  disabled={!fs.activeFileId || editorLang === 'jupyter'}
                >
                  <option style={{ backgroundColor: '#2e2e2e', color: '#e0e0e0' }} value="auto">Auto Select</option>
                  <option style={{ backgroundColor: '#2e2e2e', color: '#e0e0e0' }} value="browser">🌐 Browser</option>
                  <option style={{ backgroundColor: '#2e2e2e', color: '#e0e0e0' }} value="local-agent">💻 Local Agent</option>
                  <option style={{ backgroundColor: '#2e2e2e', color: '#e0e0e0' }} value="remote">☁️ CPU Worker</option>
                  <option style={{ backgroundColor: '#2e2e2e', color: '#e0e0e0' }} value="gpu-worker">🚀 GPU Worker</option>
                </select>
              )}
              {isExecuting ? (
                <button 
                  className="ide-btn" 
                  style={{ height: '24px', padding: '0 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', background: 'var(--ide-danger)', color: '#fff' }}
                  onClick={handleStopCode}
                >
                  <Square size={10} fill="currentColor" />
                  Stop
                </button>
              ) : (
                <button 
                  className="ide-btn" 
                  style={{ height: '24px', padding: '0 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: editorLang === 'jupyter' ? 0.5 : 1 }}
                  onClick={handleRunCode}
                  disabled={!fs.activeFileId || editorLang === 'jupyter'}
                  title={editorLang === 'jupyter' ? "Run cells individually in the notebook" : undefined}
                >
                  <Play size={12} />
                  Run
                </button>
              )}
            </div>
          </div>

          {/* Editor */}
          {fs.activeFileId && activeFile ? (
            <div className="ide-editor-body">
              {preview?.fileId === fs.activeFileId ? (
                <>
                  <div style={{ padding: 8 }}>Snapshot preview <button className="ide-btn" onClick={() => setPreview(null)}>Back to editing</button></div>
                  <Editor key={'preview-' + preview.fileId} height="100%" language={editorLang} theme={theme === 'dark' ? 'vs-dark' : 'vs'} value={preview.content} options={{ readOnly: true }} />
                </>
              ) : editorLang === 'jupyter' ? (
                notebook.error ? <div role="alert" style={{ padding: 24 }}>
                  {notebook.error} Download the original file from Explorer to inspect its JSON.
                </div> :
                <NotebookRenderer
                  key={fs.activeFileId}
                  readOnly={!canModify || !collaboration.ready}
                  cells={notebook.cells}
                  isExecuting={notebook.isExecuting}
                  onStop={notebook.stop}
                  inputText={notebook.inputText}
                  onInputTextChange={notebook.changeInput}
                  onCellChange={notebook.changeCell}
                  onRunCell={notebook.runCell}
                  onRunAll={notebook.runAll}
                  onAddCell={notebook.addCell}
                  onDeleteCell={notebook.deleteCell}
                  onMoveCell={notebook.moveCell}
                  theme={theme}
                />
              ) : (
                <Editor
                  key={fs.activeFileId}
                  height="100%"
                  path={fs.activeFileId}
                  language={editorLang}
                  theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                  value={normalizeEditorContent(editorContent)}
                  onChange={(val, event) => {
                    if (event.isFlush || event.isEolChange) return;
                    if (canModify && collaboration.ready && fs.activeFileId) {
                      const changes = event.changes.map(change => ({ offset: change.rangeOffset, length: change.rangeLength, text: change.text }));
                      const mapped = mapEditorChanges(editorSourceRef.current, changes, val ?? '');
                      collaboration.replaceContent(fs.activeFileId, mapped.content, mapped.edits);
                    }
                  }}
                  onMount={handleEditorMount}
                  options={{
                    minimap: { enabled: preferences.minimap },
                    fontSize: preferences.fontSize,
                    fontFamily: "var(--ide-font-mono), monospace",
                    lineNumbers: 'on',
                    roundedSelection: true,
                    scrollBeyondLastLine: false,
                    readOnly: !canModify || !collaboration.ready,
                    automaticLayout: true,
                    tabSize: preferences.tabSize,
                    insertSpaces: true,
                    wordWrap: preferences.wordWrap ? 'on' : 'off',
                    padding: { top: 12 },
                  }}
                  loading={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ide-text-muted)' }}><Loader2 size={20} className="animate-spin" /></div>}
                />
              )}
            </div>
          ) : (
            <div className="ide-welcome">
              <TerminalIcon size={40} style={{ opacity: 0.3, color: 'var(--ide-accent)' }} />
              <h3>SyncScript</h3>
              <p>Select a file from the explorer to start editing, or create a new file.</p>
              <button className="ide-btn primary" onClick={() => setQuickOpen(true)}>Open a file <kbd>Ctrl/⌘ P</kbd></button>
              <p className="ide-help-text">Ctrl/⌘ B: sidebar · Ctrl/⌘ Shift F: search · Ctrl/⌘ `: terminal</p>
            </div>
          )}

          {/* xterm.js Terminal Panel */}
          <TerminalPanel
            visible={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            executionTarget={executionTarget}
            isRunning={isExecuting}
            status={terminalStatus}
            onRestart={() => terminalSessionRef.current?.restart()}
            onTerminalReady={handleTerminalReady}
            onTerminalDispose={handleTerminalDispose}
          />

          {/* Status Bar */}
          <div className="ide-statusbar">
            <div className="ide-statusbar-left">
              {activeFile && <span className="ide-statusbar-item">{editorLang}</span>}
              {activeFile && <span className="ide-statusbar-item" title={`${editorContent.split('\n').length} lines`}>Ln {cursorPosition.lineNumber}, Col {cursorPosition.column}</span>}
              {!canModify && <span className="ide-statusbar-item">Read-only</span>}
            </div>
            <div className="ide-statusbar-right">
              <span className="ide-statusbar-item" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: agentConnected ? 'var(--ide-success)' : 'var(--ide-text-muted)', display: 'inline-block' }} />
                {agentConnected ? 'Agent' : 'No Agent'}
              </span>
              <span className="ide-statusbar-item" role="status" title="Edits save automatically when connected">{!collaboration.ready && fs.activeFileId ? 'Reconnecting...' : collaboration.saveStatus === 'saved' ? '✓ Saved' : collaboration.saveStatus === 'saving' ? 'Saving...' : '● Unsaved'}</span>
            </div>
          </div>
        </div>

        <RightPanel
          workspaceId={workspaceId}
          chatHistoryLoading={ws.chatHistoryLoading}
          chatHistoryError={ws.chatHistoryError}
          onRetryChatHistory={ws.retryChatHistory}
          onChatVisibilityChange={setChatTabVisible}
          unreadMessages={ws.unreadMessages}
          isSendingChat={ws.isSendingChat}
          chatSendError={ws.chatSendError}
          collapsed={!rightPanelOpen}
          chatMessages={ws.chatMessages}
          typingUsers={ws.typingUsers}
          chatInput={ws.chatInput}
          onChatInputChange={ws.handleChatInputChange}
          onSendMessage={ws.sendChatMessage}
          activeCollaborators={ws.activeCollaborators}
          isConnected={ws.isConnected}
          presenceReady={ws.presenceReady}
          currentUserId={user?.id || ''}
        />
      </div>
      {quickOpen && <QuickOpen files={fs.files} openFileIds={openTabs.map(file => file.id)} onClose={() => setQuickOpen(false)} onSelect={file => {
        selectFile(file);
        pendingNavigationRef.current = { fileId: file.id };
        requestAnimationFrame(() => revealPendingLineRef.current());
      }} />}
    </div>
  );
};

// --- Exported Component with Theme Provider ---
export const IDELayout: React.FC<{ workspaceId: string; onBack: () => void }> = (props) => {
  const { user } = useAuth();
  return <IDEThemeProvider>
    <IDEInner key={JSON.stringify([user?.id, props.workspaceId])} {...props} />
  </IDEThemeProvider>;
};
