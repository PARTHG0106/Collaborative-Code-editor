import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { IDEThemeProvider, useTheme } from './IDEThemeProvider';
import { ActivityBar, ActivityType } from './ActivityBar';
import { TopBar } from './TopBar';
import { ExplorerPanel } from './sidebar/ExplorerPanel';
import { SearchPanel } from './sidebar/SearchPanel';
import { CollaboratorsPanel } from './sidebar/CollaboratorsPanel';
import { SnapshotsPanel } from './sidebar/SnapshotsPanel';
import { SettingsPanel } from './sidebar/SettingsPanel';
import { RightPanel } from './RightPanel';
import { useFileSystem, FileSystemItem } from './hooks/useFileSystem';
import { useWorkspaceSocket } from './hooks/useWorkspaceSocket';
import { ExecutionOrchestrator, getLangFromFilename } from '../../lib/execution/ExecutionOrchestrator';
import { TerminalPanel } from '../../lib/execution/terminal/TerminalPanel';
import { TerminalManager } from '../../lib/execution/terminal/TerminalManager';
import { AgentConnector } from '../../lib/execution/AgentConnector';
import { ExecutionTarget } from '../../lib/execution/types';
import { NotebookRenderer, NotebookCell, CellOutput } from '../../lib/execution/notebook/NotebookRenderer';
import { parseNotebook, serializeNotebook, NotebookKernel } from '../../lib/execution/notebook/NotebookExecutor';
import Editor from '@monaco-editor/react';
import { io, Socket } from 'socket.io-client';
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

  // Workspace data
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // UI state
  const [activity, setActivity] = useState<ActivityType>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [openTabs, setOpenTabs] = useState<FileSystemItem[]>([]);
  const [editorContent, setEditorContent] = useState('');

  // Execution state
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget | null>(null);
  const [runTarget, setRunTarget] = useState<'auto' | ExecutionTarget>('auto');
  const [agentConnected, setAgentConnected] = useState(false);
  const orchestratorRef = useRef(new ExecutionOrchestrator());
  const terminalManagerRef = useRef<TerminalManager | null>(null);
  const agentRef = useRef(new AgentConnector());
  
  // Notebook state
  const [notebookCells, setNotebookCells] = useState<NotebookCell[]>([]);
  const notebookKernelRef = useRef<NotebookKernel | null>(null);

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

  // File system hook
  const fs = useFileSystem(workspaceId);
  // Socket hook
  const ws = useWorkspaceSocket(workspaceId);

  // Editor refs
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const socketRef = useRef<Socket | null>(null);
  const serverVersionRef = useRef(0);
  const localVersionRef = useRef(0);
  const isRemoteEditRef = useRef(false);
  const decorationsRef = useRef<Map<string, string[]>>(new Map());
  const activeFileIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeFileIdRef.current = fs.activeFileId;
  }, [fs.activeFileId]);

  useEffect(() => {
    if (terminalManagerRef.current) {
      terminalManagerRef.current.setRawMode(!isExecuting);
    }
  }, [isExecuting]);

  useEffect(() => {
    if (ws.socket) {
      ws.socket.emit('terminal:spawn', { workspaceId });
      
      const onConnect = () => {
        ws.socket?.emit('terminal:spawn', { workspaceId });
      };
      
      ws.socket.on('connect', onConnect);
      return () => {
        ws.socket?.off('connect', onConnect);
      };
    }
  }, [ws.socket, workspaceId]);

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

  // Use the shared socket from useWorkspaceSocket instead of duplicating
  useEffect(() => {
    socketRef.current = ws.socket;
  }, [ws.socket]);

  // File room sync
  useEffect(() => {
    const socket = ws.socket;
    if (!socket || !fs.activeFileId) return;

    socket.emit('join_file', { fileId: fs.activeFileId });

    const onInit = ({ content, version }: any) => {
      setEditorContent(content);
      serverVersionRef.current = version;
      localVersionRef.current = version;
    };

    const onAck = ({ version }: any) => {
      serverVersionRef.current = version;
      fs.setSaveStatus('saved');
    };

    const onEdit = ({ fileId, edit, version, userId }: any) => {
      if (fileId !== fs.activeFileId) return;
      serverVersionRef.current = version;
      localVersionRef.current = version;
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      if (ed && monaco) {
        const model = ed.getModel();
        if (model) {
          isRemoteEditRef.current = true;
          const start = model.getPositionAt(edit.offset);
          const end = model.getPositionAt(edit.offset + edit.length);
          model.pushEditOperations([], [{ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text, forceMoveMarkers: true }], () => null);
          isRemoteEditRef.current = false;
        }
      }
    };

    const onCursor = ({ userId, name, email, cursor }: any) => {
      ensureCursorStyle(userId, name);
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      if (ed && monaco) {
        const model = ed.getModel();
        if (model) {
          const prev = decorationsRef.current.get(userId) || [];
          const pos = model.getPositionAt(cursor.offset);
          const range = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
          const newDec = ed.deltaDecorations(prev, [{ range, options: { className: `rc-${userId}`, hoverMessage: { value: `${name}` } } }]);
          decorationsRef.current.set(userId, newDec);
        }
      }
    };

    socket.on('file_init', onInit);
    socket.on('file_edit_ack', onAck);
    socket.on('file_edit', onEdit);
    socket.on('cursor_update', onCursor);

    return () => {
      socket.emit('leave_file', { fileId: fs.activeFileId });
      socket.off('file_init', onInit);
      socket.off('file_edit_ack', onAck);
      socket.off('file_edit', onEdit);
      socket.off('cursor_update', onCursor);
      decorationsRef.current.forEach(d => editorRef.current?.deltaDecorations(d, []));
      decorationsRef.current.clear();
    };
  }, [fs.activeFileId, ws.socket]);

  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.onDidChangeModelContent((e: any) => {
      if (isRemoteEditRef.current) return;
      e.changes.forEach((c: any) => {
        if (socketRef.current && activeFileIdRef.current) {
          socketRef.current.emit('edit_file', {
            fileId: activeFileIdRef.current,
            baseVersion: localVersionRef.current,
            edit: { offset: c.rangeOffset, text: c.text, length: c.rangeLength }
          });
          localVersionRef.current += 1;
          fs.setSaveStatus('unsaved');
        }
      });
    });

    editor.onDidChangeCursorPosition((e: any) => {
      if (socketRef.current && activeFileIdRef.current) {
        const model = editor.getModel();
        if (model) {
          socketRef.current.emit('cursor_move', {
            fileId: activeFileIdRef.current,
            cursor: { lineNumber: e.position.lineNumber, column: e.position.column, offset: model.getOffsetAt(e.position) }
          });
        }
      }
    });
  };

  // Auto-save
  useEffect(() => {
    if (fs.activeFileId) {
      const activeItem = fs.files.find(f => f.id === fs.activeFileId);
      if (activeItem?.content) {
        setEditorContent(activeItem.content);
        if (activeItem.name.endsWith('.ipynb')) {
          setNotebookCells(parseNotebook(activeItem.content));
        }
      } else {
        setEditorContent('');
        if (activeItem?.name.endsWith('.ipynb')) setNotebookCells([]);
      }
    }
  }, [fs.activeFileId]);

  useEffect(() => {
    if (!fs.activeFileId) return;
    const file = fs.files.find(f => f.id === fs.activeFileId);
    if (!file || file.content === editorContent) { fs.setSaveStatus('saved'); return; }
    fs.setSaveStatus('unsaved');
    const t = setTimeout(() => fs.saveFileContent(fs.activeFileId!, editorContent), 1500);
    return () => clearTimeout(t);
  }, [editorContent, fs.activeFileId]);

  // Fetch versions when snapshots panel is active
  const fetchVersions = useCallback(async () => {
    if (!fs.activeFileId) return;
    setVersionsLoading(true);
    try {
      const res = await apiClient.get(`/workspaces/${workspaceId}/files/${fs.activeFileId}/versions`);
      if (res.data?.success) setVersions(res.data.data);
    } catch { } finally { setVersionsLoading(false); }
  }, [fs.activeFileId, workspaceId, apiClient]);

  useEffect(() => { if (activity === 'snapshots') fetchVersions(); }, [activity, fs.activeFileId, fetchVersions]);

  // Handlers
  const selectFile = (file: FileSystemItem) => {
    fs.setActiveFileId(file.id);
    setEditorContent(file.content || '');
    fs.setSaveStatus('saved');
    setOpenTabs(prev => prev.find(t => t.id === file.id) ? prev : [...prev, file]);
  };

  const closeTab = (id: string) => {
    setOpenTabs(prev => prev.filter(t => t.id !== id));
    if (fs.activeFileId === id) {
      const remaining = openTabs.filter(t => t.id !== id);
      if (remaining.length) selectFile(remaining[remaining.length - 1]);
      else { fs.setActiveFileId(null); setEditorContent(''); }
    }
  };

  const handleActivity = (a: ActivityType) => {
    if (a === activity && sidebarVisible) setSidebarVisible(false);
    else { setActivity(a); setSidebarVisible(true); }
  };

  const handleInvite = async (email: string, role: 'EDITOR' | 'VIEWER') => {
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/members`, { email, role });
      if (res.data?.success) setWorkspace(prev => prev ? { ...prev, members: [...prev.members, res.data.data] } : null);
    } catch (e: any) { setError(e.response?.data?.error?.message || 'Failed to invite'); }
  };

  const handleRoleChange = async (userId: string, role: 'EDITOR' | 'VIEWER') => {
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}/members/${userId}`, { role });
      if (res.data?.success) setWorkspace(prev => prev ? { ...prev, members: prev.members.map(m => m.userId === userId ? { ...m, role: res.data.data.role } : m) } : null);
    } catch { }
  };

  const handleRemoveMember = async (userId: string) => {
    const isSelf = userId === user?.id;
    if (!window.confirm(isSelf ? 'Leave this workspace?' : 'Remove this member?')) return;
    try {
      await apiClient.delete(`/workspaces/${workspaceId}/members/${userId}`);
      if (isSelf) onBack();
      else setWorkspace(prev => prev ? { ...prev, members: prev.members.filter(m => m.userId !== userId) } : null);
    } catch { }
  };

  const handleSaveSettings = async (name: string, desc: string) => {
    try {
      const res = await apiClient.patch(`/workspaces/${workspaceId}`, { name, description: desc });
      if (res.data?.success) setWorkspace(prev => prev ? { ...prev, name: res.data.data.name, description: res.data.data.description } : null);
    } catch { }
  };

  const handleDeleteWorkspace = async () => {
    if (!window.confirm('Delete this workspace permanently?')) return;
    try { await apiClient.delete(`/workspaces/${workspaceId}`); onBack(); } catch { }
  };

  const handleEditorAreaClick = () => {
    if (window.innerWidth <= 768 && sidebarVisible) {
      setSidebarVisible(false);
    }
  };

  const handleCreateSnapshot = async () => {
    if (!fs.activeFileId) return;
    setActionLoading(true);
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/files/${fs.activeFileId}/versions`);
      if (res.data?.success) setVersions(prev => [res.data.data, ...prev]);
    } catch { } finally { setActionLoading(false); }
  };

  const handleRestoreVersion = async (versionId: string) => {
    if (!fs.activeFileId) return;
    setActionLoading(true);
    try {
      const res = await apiClient.post(`/workspaces/${workspaceId}/files/${fs.activeFileId}/versions/${versionId}/restore`);
      if (res.data?.success) {
        setEditorContent(res.data.data.content);
        if (socketRef.current) {
          socketRef.current.emit('edit_file', {
            fileId: fs.activeFileId, baseVersion: localVersionRef.current,
            edit: { offset: 0, text: res.data.data.content, length: editorContent.length }
          });
        }
      }
    } catch { } finally { setActionLoading(false); }
  };

  const handleRunCode = async () => {
    if (!fs.activeFileId) return;
    const file = fs.files.find(f => f.id === fs.activeFileId);
    if (!file) return;

    const lang = getLangFromFilename(file.name);
    if (!lang) {
      setTerminalOpen(true);
      terminalManagerRef.current?.clear();
      terminalManagerRef.current?.writeStderr(`Unsupported file type: .${file.name.split('.').pop()}\r\n`);
      return;
    }

    setIsExecuting(true);
    setTerminalOpen(true);
    
    // Wait for the TerminalPanel to mount and initialize the manager
    let retries = 0;
    while (!terminalManagerRef.current && retries < 20) {
      await new Promise(r => setTimeout(r, 50));
      retries++;
    }
    
    const target = runTarget === 'auto' ? orchestratorRef.current.selectTarget(lang) : runTarget;
    setExecutionTarget(target);

    // If manual target is unsupported by Browser/Agent, it falls back to Remote/GPU in execute.
    // For now we just pass it to execute (we might need to update ExecutionOrchestrator to accept an override target).
    // Wait, ExecutionOrchestrator currently selects its own target internally!
    // Let's pass the override target.
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
        if (!ws.socket) {
          cb.onStderr('WebSocket not connected\r\n');
          cb.onExit(1);
          return;
        }
        
        // Handle input to remote server
        orchestratorRef.current.setRemoteInputHandler((input) => {
          ws.socket!.emit('execution:stdin', { sessionId: ws.socket!.id, data: input });
        });

        const onStdout = (data: any) => cb.onStdout(data.data);
        const onStderr = (data: any) => cb.onStderr(data.data);
        const onCompleted = (data: any) => {
          ws.socket!.off('execution:stdout', onStdout);
          ws.socket!.off('execution:stderr', onStderr);
          ws.socket!.off('execution:completed', onCompleted);
          cb.onExit(data.exitCode);
        };
        ws.socket.on('execution:stdout', onStdout);
        ws.socket.on('execution:stderr', onStderr);
        ws.socket.on('execution:completed', onCompleted);
        ws.socket.emit('execution:start', {
          workspaceId,
          fileId: fs.activeFileId,
          language: lang,
          code,
          target, // Passes 'remote' or 'gpu-worker'
        });
      },
      target
    );
  };

  const handleStopCode = () => {
    orchestratorRef.current.cancel();
    setIsExecuting(false);
    setExecutionTarget(null);
    terminalManagerRef.current?.writeStderr('\r\n[Execution cancelled]\r\n');
  };

  // --- Notebook Handlers ---
  const syncNotebookToEditor = (cells: NotebookCell[]) => {
    setNotebookCells(cells);
    const serialized = serializeNotebook(cells);
    setEditorContent(serialized);
    if (socketRef.current && fs.activeFileId) {
      socketRef.current.emit('edit_file', {
        fileId: fs.activeFileId,
        baseVersion: localVersionRef.current,
        edit: { offset: 0, text: serialized, length: editorContent.length }
      });
      localVersionRef.current += 1;
      fs.setSaveStatus('unsaved');
    }
  };

  const handleCellChange = (id: string, source: string) => {
    const newCells = notebookCells.map(c => c.id === id ? { ...c, source } : c);
    syncNotebookToEditor(newCells);
  };

  const handleAddCell = (afterId: string, type: 'code' | 'markdown') => {
    const idx = notebookCells.findIndex(c => c.id === afterId);
    const newCell: NotebookCell = { id: `cell-${Date.now()}`, type, source: '', outputs: [], executionCount: null, isRunning: false };
    const newCells = [...notebookCells];
    newCells.splice(idx >= 0 ? idx + 1 : newCells.length, 0, newCell);
    syncNotebookToEditor(newCells);
  };

  const handleDeleteCell = (id: string) => {
    const newCells = notebookCells.filter(c => c.id !== id);
    syncNotebookToEditor(newCells);
  };

  const handleMoveCell = (id: string, direction: 'up' | 'down') => {
    const idx = notebookCells.findIndex(c => c.id === id);
    if (idx < 0) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === notebookCells.length - 1) return;
    
    const newCells = [...notebookCells];
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    [newCells[idx], newCells[targetIdx]] = [newCells[targetIdx], newCells[idx]];
    syncNotebookToEditor(newCells);
  };

  const handleRunCell = async (id: string) => {
    if (!notebookKernelRef.current) notebookKernelRef.current = new NotebookKernel();
    
    setNotebookCells(cells => cells.map(c => c.id === id ? { ...c, isRunning: true, outputs: [] } : c));
    
    const cell = notebookCells.find(c => c.id === id);
    if (!cell || cell.type !== 'code') return;

    let finalOutputs: CellOutput[] = [];
    await notebookKernelRef.current.runCell(
      cell,
      (outputs) => {
        finalOutputs = outputs;
        setNotebookCells(cells => cells.map(c => c.id === id ? { ...c, outputs } : c));
      },
      () => {
        // Request input - show in terminal panel as a fallback or native prompt
        const answer = window.prompt("Python input:");
        notebookKernelRef.current?.sendInput(answer || '');
      }
    );

    setNotebookCells(cells => {
      const newCells = cells.map(c => c.id === id ? { 
        ...c, 
        outputs: finalOutputs,
        isRunning: false,
        executionCount: notebookKernelRef.current?.getExecutionCount() || null
      } : c);
      // Sync final outputs to file immediately after state calculation
      setTimeout(() => syncNotebookToEditor(newCells), 0);
      return newCells;
    });
  };

  const handleRunAllCells = async () => {
    for (const cell of notebookCells) {
      if (cell.type === 'code') await handleRunCell(cell.id);
    }
  };

  // Loading state
  if (loading) return <div className="ide-root ide-dark" style={{ alignItems: 'center', justifyContent: 'center' }}><Loader2 size={24} className="animate-spin" style={{ color: 'var(--ide-accent)' }} /></div>;
  if (!workspace) return <div className="ide-root ide-dark" style={{ alignItems: 'center', justifyContent: 'center', gap: 8 }}><span>Failed to load workspace</span><button className="ide-btn" onClick={onBack}>Back</button></div>;

  const isOwner = workspace.currentUserRole === 'OWNER';
  const canModify = workspace.currentUserRole !== 'VIEWER';
  const activeFile = fs.files.find(f => f.id === fs.activeFileId);
  const editorLang = activeFile ? getLanguage(activeFile.name) : 'plaintext';

  return (
    <div className={`ide-root ${theme === 'dark' ? 'ide-dark' : ''}`}>
      <TopBar
        workspaceName={workspace.name}
        collaboratorCount={ws.activeCollaborators.length}
        isConnected={true}
        userName={user?.name || ''}
        onBack={onBack}
        rightPanelOpen={rightPanelOpen}
        onToggleRightPanel={() => setRightPanelOpen(p => !p)}
      />
      <div className="ide-body">
        <ActivityBar active={activity} onSelect={handleActivity} sidebarVisible={sidebarVisible} />

        <div className={`ide-sidebar ${!sidebarVisible ? 'collapsed' : 'mobile-open'}`}>
          {activity === 'explorer' && (
            <ExplorerPanel
              files={fs.files} filesLoading={fs.filesLoading} activeFileId={fs.activeFileId}
              expandedFolders={fs.expandedFolders} canModify={canModify}
              onSelectFile={selectFile}
              onToggleFolder={id => fs.setExpandedFolders(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
              onCreateFile={(name, type, parentId, content) => fs.createFile(name, type, parentId, content).then(item => { if (item && type === 'FILE') selectFile(item); return item; })}
              onRenameFile={fs.renameFile} onDeleteFile={fs.deleteFile}
            />
          )}
          {activity === 'search' && <SearchPanel files={fs.files} onOpenFile={selectFile} />}
          {activity === 'collaborators' && (
            <CollaboratorsPanel
              members={workspace.members} currentUserId={user?.id || ''} currentUserRole={workspace.currentUserRole}
              activeCollaborators={ws.activeCollaborators} canModify={canModify}
              onInvite={handleInvite} onChangeRole={handleRoleChange} onRemoveMember={handleRemoveMember}
            />
          )}
          {activity === 'snapshots' && (
            <SnapshotsPanel
              activeFileId={fs.activeFileId} activeFileName={activeFile?.name || null}
              versions={versions} loading={versionsLoading} actionLoading={actionLoading}
              onCreateSnapshot={handleCreateSnapshot}
              onPreview={content => { setEditorContent(content); fs.setSaveStatus('unsaved'); }}
              onRestore={handleRestoreVersion}
            />
          )}
          {activity === 'settings' && (
            <SettingsPanel
              workspace={workspace} isOwner={isOwner} canModify={canModify}
              onSave={handleSaveSettings} onDelete={handleDeleteWorkspace}
              onLeave={() => handleRemoveMember(user?.id || '')}
            />
          )}
        </div>

        <div className="ide-editor-area" onPointerDownCapture={handleEditorAreaClick}>
          {/* Tab Bar */}
          <div className="ide-tabs-bar">
            <div style={{ display: 'flex', flex: 1, overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              {openTabs.map(tab => (
                <button
                  key={tab.id}
                  className={`ide-tab ${fs.activeFileId === tab.id ? 'active' : ''}`}
                  onClick={() => selectFile(tab)}
                  style={{ flexShrink: 0 }}
                >
                  <File size={12} style={{ color: 'var(--ide-accent)', flexShrink: 0 }} />
                  {tab.name}
                  <span className="ide-tab-close" onClick={e => { e.stopPropagation(); closeTab(tab.id); }}>
                    <X size={10} />
                  </span>
                </button>
              ))}
            </div>
            
            {/* Run / Stop Button */}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: '8px', gap: '4px' }}>
              {!isExecuting && (
                <select
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
              {editorLang === 'jupyter' ? (
                <NotebookRenderer
                  cells={notebookCells}
                  onCellChange={handleCellChange}
                  onRunCell={handleRunCell}
                  onRunAll={handleRunAllCells}
                  onAddCell={handleAddCell}
                  onDeleteCell={handleDeleteCell}
                  onMoveCell={handleMoveCell}
                  theme={theme}
                />
              ) : (
                <Editor
                  height="100%"
                  path={fs.activeFileId}
                  language={editorLang}
                  theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                  value={editorContent}
                  onChange={val => setEditorContent(val || '')}
                  onMount={handleEditorMount}
                  options={{
                    minimap: { enabled: true },
                    fontSize: 14,
                    fontFamily: "var(--ide-font-mono), monospace",
                    lineNumbers: 'on',
                    roundedSelection: true,
                    scrollBeyondLastLine: false,
                    readOnly: !canModify,
                    automaticLayout: true,
                    tabSize: 2,
                    insertSpaces: true,
                    wordWrap: 'on',
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
            </div>
          )}

          {/* xterm.js Terminal Panel */}
          <TerminalPanel
            visible={terminalOpen}
            onClose={() => setTerminalOpen(false)}
            executionTarget={executionTarget}
            isRunning={isExecuting}
            onTerminalReady={(manager) => { 
              terminalManagerRef.current = manager;
              manager.setRawMode(!isExecuting);
              
              if (ws.socket) {
                ws.socket.on('terminal:output', (payload: any) => {
                  manager.writeStdout(payload.data);
                });
              }

              manager.onRawData((data) => {
                if (orchestratorRef.current.getIsRunning()) {
                  const input = data === '\r' ? '\n' : data;
                  orchestratorRef.current.sendInput(input);
                } else if (ws.socket) {
                  ws.socket.emit('terminal:data', { data });
                }
              });

              // Also request a terminal spawn if not spawned
              if (ws.socket) {
                ws.socket.emit('terminal:spawn', { workspaceId });
              }
            }}
          />

          {/* Status Bar */}
          <div className="ide-statusbar">
            <div className="ide-statusbar-left">
              {activeFile && <span className="ide-statusbar-item">{editorLang}</span>}
              {activeFile && <span className="ide-statusbar-item">Ln {editorContent.split('\n').length}</span>}
            </div>
            <div className="ide-statusbar-right">
              <span className="ide-statusbar-item" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: agentConnected ? 'var(--ide-success)' : 'var(--ide-text-muted)', display: 'inline-block' }} />
                {agentConnected ? 'Agent' : 'No Agent'}
              </span>
              <span className="ide-statusbar-item">{fs.saveStatus === 'saved' ? '✓ Saved' : fs.saveStatus === 'saving' ? 'Saving...' : '● Unsaved'}</span>
            </div>
          </div>
        </div>

        <RightPanel
          collapsed={!rightPanelOpen}
          chatMessages={ws.chatMessages}
          typingUsers={ws.typingUsers}
          chatInput={ws.chatInput}
          onChatInputChange={ws.handleChatInputChange}
          onSendMessage={ws.sendChatMessage}
          activeCollaborators={ws.activeCollaborators}
          currentUserId={user?.id || ''}
        />
      </div>
    </div>
  );
};

// --- Exported Component with Theme Provider ---
export const IDELayout: React.FC<{ workspaceId: string; onBack: () => void }> = (props) => (
  <IDEThemeProvider>
    <IDEInner {...props} />
  </IDEThemeProvider>
);
