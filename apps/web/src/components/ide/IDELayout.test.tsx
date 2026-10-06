import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDELayout } from './IDELayout';

const mocks = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  socket: null as any,
  onCursor: null as null | ((event: any) => void),
  onEditorChange: null as null | ((value: string, event: any) => void),
  onModelChange: null as null | ((event: any) => void),
  modelEOL: '\r\n',
  setPosition: vi.fn(), revealLineInCenter: vi.fn(), editorFocus: vi.fn(),
  deferEditorMount: false,
  mountEditor: null as null | (() => void),
  remoteInput: null as null | ((input: string) => void),
  lineInput: null as null | ((input: string) => void),
  createWorkspaceArchive: vi.fn(), createFileDownload: vi.fn(), downloadBlob: vi.fn(),
  terminalManager: {
    setRawMode: vi.fn(), setInputEnabled: vi.fn(), fit: vi.fn(), focus: vi.fn(),
    getDimensions: vi.fn(), onData: vi.fn(), onRawData: vi.fn(), onResize: vi.fn(),
    writeStdout: vi.fn(), writeStderr: vi.fn(), writeInfo: vi.fn(),
  },
}));

vi.mock('../../lib/workspaceExport', () => ({
  createWorkspaceArchive: mocks.createWorkspaceArchive,
  createFileDownload: mocks.createFileDownload,
  downloadBlob: mocks.downloadBlob,
  workspaceArchiveName: (name: string) => `${name}.zip`,
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ apiClient: mocks.apiClient, user: { id: 'self', name: 'Self' } }),
}));

vi.mock('./hooks/useWorkspaceSocket', () => ({
  useWorkspaceSocket: () => ({
    socket: mocks.socket,
    isConnected: mocks.socket.connected,
    activeCollaborators: [], chatMessages: [], typingUsers: [], chatInput: '',
    handleChatInputChange: vi.fn(), sendChatMessage: vi.fn(), permissionError: null,
  }),
}));

// Exercise the real file cache, edit queue, selection, and snapshot handlers.
// Only Monaco and unrelated execution surfaces are replaced in this DOM test.
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  return {
    default: function MockEditor({ value, onChange, onMount, options, path }: any) {
      mocks.onEditorChange = onChange;
      useEffect(() => {
        const mount = () => onMount?.({
          setPosition: mocks.setPosition,
          revealLineInCenter: mocks.revealLineInCenter,
          focus: mocks.editorFocus,
          getModel: () => ({
            getOffsetAt: (position: { column: number }) => position.column - 1,
            getEOL: () => mocks.modelEOL,
            setEOL: () => { mocks.modelEOL = '\n'; },
            onDidChangeContent: (listener: (event: any) => void) => {
              mocks.onModelChange = listener;
              return { dispose: vi.fn() };
            },
          }),
          onDidChangeCursorPosition: (listener: (event: any) => void) => {
            mocks.onCursor = listener;
            return { dispose: vi.fn() };
          },
          onDidDispose: vi.fn(),
        }, { editor: { EndOfLineSequence: { LF: 0 } } });
        mocks.mountEditor = mount;
        if (!mocks.deferEditorMount) mount();
      }, []);
      useEffect(() => {
        // Monaco may notify after a controlled value replacement. Such a
        // callback must never become a new edit to the other selected file.
        onChange?.(value, { changes: [{ rangeOffset: 0, rangeLength: value.length, text: value }] });
      }, [value]);
      return <textarea aria-label="Code editor" data-file={path || 'preview'} readOnly={options?.readOnly} value={value} onChange={event => onChange?.(event.target.value, { changes: [{ rangeOffset: 0, rangeLength: value.length, text: event.target.value }] })} />;
    },
  };
});

vi.mock('../../lib/execution/AgentConnector', () => ({
  AgentConnector: class {
    onStatus() {}
    connect() { return Promise.resolve(false); }
    disconnect() {}
    isConnected() { return false; }
  },
}));
vi.mock('../../lib/execution/ExecutionOrchestrator', () => ({
  ExecutionOrchestrator: class {
    selectTarget() { return 'remote'; }
    execute(_filename: string, code: string, callbacks: any, _agent: unknown, remote: any, target: string) { return remote('typescript', code, callbacks, target); }
    setRemoteInputHandler(handler: (input: string) => void) { mocks.remoteInput = handler; }
    sendInput(input: string) { mocks.remoteInput?.(input); }
    cancel() {}
  },
  getLangFromFilename: () => 'typescript',
}));
vi.mock('../../lib/execution/terminal/TerminalPanel', async () => {
  const { useEffect } = await import('react');
  return { TerminalPanel: ({ visible, onTerminalReady }: any) => {
    useEffect(() => { if (visible) onTerminalReady(mocks.terminalManager); }, [visible, onTerminalReady]);
    return null;
  } };
});
vi.mock('./RightPanel', () => ({ RightPanel: () => null }));

class FakeSocket {
  connected = true;
  handlers = new Map<string, Set<(...args: any[]) => void>>();
  emit = vi.fn();
  on(event: string, listener: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(listener);
  }
  off(event: string, listener: (...args: any[]) => void) { this.handlers.get(event)?.delete(listener); }
  receive(event: string, payload?: unknown) {
    for (const listener of [...(this.handlers.get(event) || [])]) listener(payload);
  }
}

const file = (id: string, content: string, name = `${id}.ts`) => ({
  id, name, content, parentId: null, workspaceId: 'workspace', type: 'FILE', createdAt: '', updatedAt: '',
});
const response = (data: unknown) => ({ data: { success: true, data } });

describe('IDE collaborative editing', () => {
  let socket: FakeSocket;
  let files: ReturnType<typeof file>[];

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    mocks.deferEditorMount = false;
    mocks.mountEditor = null;
    mocks.remoteInput = null;
    mocks.lineInput = null;
    mocks.createWorkspaceArchive.mockResolvedValue(new Blob(['zip']));
    mocks.createFileDownload.mockReturnValue(new Blob(['file']));
    mocks.terminalManager.getDimensions.mockReturnValue({ cols: 80, rows: 24 });
    mocks.terminalManager.onRawData.mockReturnValue(() => {});
    mocks.terminalManager.onResize.mockReturnValue(() => {});
    mocks.terminalManager.onData.mockImplementation(handler => { mocks.lineInput = handler; return () => { mocks.lineInput = null; }; });
    socket = new FakeSocket();
    mocks.socket = socket;
    files = [file('alpha', 'cached alpha'), file('beta', 'cached beta')];
    mocks.apiClient.get.mockImplementation(async (url: string) => {
      if (url === '/workspaces/workspace') return response({ id: 'workspace', name: 'Test Workspace', members: [], currentUserRole: 'OWNER' });
      if (url === '/workspaces/workspace/files') return response(files);
      if (url.endsWith('/versions/version-1')) return response({ content: 'historical alpha' });
      if (url.endsWith('/versions')) return response([{ id: 'version-1', version: 1, createdAt: '2026-10-03T00:00:00Z' }]);
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  async function openAlpha(onBack = vi.fn()) {
    render(<IDELayout workspaceId="workspace" onBack={onBack} />);
    fireEvent.click(await screen.findByText('alpha.ts'));
    act(() => { socket.receive('file_init', { fileId: 'alpha', content: 'live alpha', version: 0, persistedVersion: 0 }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live alpha');
  }

  const edits = () => socket.emit.mock.calls.filter(([event]) => event === 'edit_file');

  it('downloads a fresh workspace listing with unsaved editor contents and keeps edits pending', async () => {
    await openAlpha();
    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'my unsaved alpha' } });
    files = [file('alpha', 'server alpha'), file('beta', 'new remote beta')];
    const editCount = edits().length;
    fireEvent.click(screen.getByRole('button', { name: 'Download workspace ZIP' }));
    await waitFor(() => expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Test Workspace.zip'));
    expect(mocks.createWorkspaceArchive).toHaveBeenCalledWith(files, {
      contentOverrides: new Map([['alpha', 'my unsaved alpha']]),
    });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('my unsaved alpha');
    expect(edits()).toHaveLength(editCount);
    expect(screen.getByText('Download started: Test Workspace.zip')).toBeInTheDocument();
  });

  it('lets viewers download files without opening them or exposing edit actions', async () => {
    mocks.apiClient.get.mockImplementation(async (url: string) => url === '/workspaces/workspace'
      ? response({ id: 'workspace', name: 'Viewed Workspace', members: [], currentUserRole: 'VIEWER' })
      : response(files));
    render(<IDELayout workspaceId="workspace" onBack={vi.fn()} />);
    const download = await screen.findByRole('button', { name: 'Download alpha.ts' });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    fireEvent.click(download);
    await waitFor(() => expect(mocks.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'alpha.ts'));
    expect(mocks.createFileDownload).toHaveBeenCalledWith(files[0], undefined);
    expect(screen.queryByRole('textbox', { name: 'Code editor' })).not.toBeInTheDocument();
    expect(edits()).toHaveLength(0);
  });

  it('jumps to a search result when opening a different file and when it is already open', async () => {
    files = [file('alpha', 'header\nneedle\nfooter')];
    render(<IDELayout workspaceId="workspace" onBack={vi.fn()} />);
    await screen.findByText('alpha.ts');
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file contents' }), { target: { value: 'needle' } });
    fireEvent.click(await screen.findByRole('button', { name: 'alpha.ts, line 2: needle' }));
    expect(mocks.setPosition).not.toHaveBeenCalled();
    act(() => { socket.receive('file_init', { fileId: 'alpha', content: files[0].content, version: 0, persistedVersion: 0 }); });
    await waitFor(() => expect(mocks.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 }));
    expect(mocks.revealLineInCenter).toHaveBeenCalledWith(2);
    expect(screen.getByText('Ln 2, Col 1')).toBeInTheDocument();
    mocks.setPosition.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'alpha.ts, line 2: needle' }));
    expect(mocks.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
    expect(edits()).toHaveLength(0);
  });

  it('opens files through quick open and exposes a separate keyboard-operable close button', async () => {
    render(<IDELayout workspaceId="workspace" onBack={vi.fn()} />);
    await screen.findByText('alpha.ts');
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox', { name: 'Find a file by name or path' }), { target: { value: 'beta' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Find a file by name or path' }), { key: 'Enter' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'beta.ts' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(mocks.editorFocus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Close beta.ts' }));
    expect(screen.queryByRole('textbox', { name: 'Code editor' })).not.toBeInTheDocument();
  });

  it('honors a pending search line when synchronization finishes before Monaco loads', async () => {
    mocks.deferEditorMount = true;
    files = [file('alpha', 'header\nneedle\nfooter')];
    render(<IDELayout workspaceId="workspace" onBack={vi.fn()} />);
    await screen.findByText('alpha.ts');
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file contents' }), { target: { value: 'needle' } });
    fireEvent.click(await screen.findByRole('button', { name: 'alpha.ts, line 2: needle' }));
    await act(async () => {
      socket.receive('file_init', { fileId: 'alpha', content: files[0].content, version: 0, persistedVersion: 0 });
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(mocks.setPosition).not.toHaveBeenCalled();
    act(() => { mocks.mountEditor?.(); });
    expect(mocks.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
    expect(screen.getByText('Ln 2, Col 1')).toBeInTheDocument();
  });

  it('restores the previous panel choices after leaving focus mode', async () => {
    await openAlpha();
    expect(screen.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Enter focus mode' }));
    expect(screen.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus mode' }));
    expect(screen.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('routes execution input and Stop to the acknowledged session and ignores unrelated completion', async () => {
    await openAlpha();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('execution:start', expect.objectContaining({ fileId: 'alpha', code: 'live alpha' })));
    act(() => { socket.receive('execution:started', { sessionId: 'run-alpha' }); mocks.lineInput?.('input line\n'); });
    expect(socket.emit).toHaveBeenCalledWith('execution:stdin', { sessionId: 'run-alpha', data: 'input line\n' });
    act(() => { socket.receive('execution:completed', { sessionId: 'other-run', exitCode: 0 }); });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(socket.emit).toHaveBeenCalledWith('execution:cancel', { sessionId: 'run-alpha' });
    act(() => { socket.receive('execution:completed', { sessionId: 'run-alpha', exitCode: -1 }); });
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    expect(socket.emit).toHaveBeenCalledWith('execution:unwatch', { sessionId: 'run-alpha' });
  });

  it('keeps a pending Stop until the execution session ID arrives', async () => {
    await openAlpha();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('execution:start', expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(socket.emit).not.toHaveBeenCalledWith('execution:cancel', expect.anything());
    act(() => { socket.receive('execution:started', { sessionId: 'late-run' }); });
    expect(socket.emit).toHaveBeenCalledWith('execution:cancel', { sessionId: 'late-run' });
    act(() => { socket.receive('execution:completed', { sessionId: 'late-run', exitCode: -1 }); });
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  });

  it('preserves typing and cursor offsets after mixed line endings arrive from another editor', async () => {
    await openAlpha();
    act(() => { socket.receive('file_resync', { fileId: 'alpha', content: 'alpha\r\nbeta', version: 0 }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('alpha\nbeta');
    act(() => { socket.receive('file_edit', { fileId: 'alpha', version: 1, operation: [11, '\ngamma'] }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('alpha\nbeta\ngamma');

    act(() => {
      mocks.onCursor?.({ position: { column: 17 } });
      mocks.onEditorChange?.('alpha\nbeta\ngamma!', { changes: [{ rangeOffset: 16, rangeLength: 0, text: '!' }] });
      // Monaco can issue another change before React commits the first one.
      mocks.onEditorChange?.('alpha\nbeta\ngamma!?', { changes: [{ rangeOffset: 17, rangeLength: 0, text: '?' }] });
    });
    expect(socket.emit).toHaveBeenCalledWith('cursor_move', { fileId: 'alpha', cursor: { offset: 17 } });
    expect(edits()).toHaveLength(1);
    expect(edits()[0][1].operation).toEqual([17, '!']);
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('alpha\nbeta\ngamma!?');
    expect(screen.getByText('Saving...')).toBeInTheDocument();

    act(() => { socket.receive('file_edit_ack', { ...edits()[0][1], version: 2 }); });
    expect(edits()[1][1].operation).toEqual([18, '?']);
    act(() => {
      socket.receive('file_edit_ack', { ...edits()[1][1], version: 3 });
      socket.receive('file_saved', { fileId: 'alpha', version: 3 });
    });
    expect(screen.getByText('✓ Saved')).toBeInTheDocument();
  });

  it('keeps LF positions after read-only model replacements reset Windows line endings', async () => {
    await openAlpha();
    expect(mocks.modelEOL).toBe('\n');
    act(() => {
      mocks.modelEOL = '\r\n';
      mocks.onModelChange?.({ isFlush: true });
      mocks.onEditorChange?.('live alpha', { isEolChange: true, changes: [] });
    });
    expect(mocks.modelEOL).toBe('\n');
    expect(edits()).toHaveLength(0);
  });

  it('keeps sending cursor positions after a refreshed session replaces the socket', async () => {
    const onBack = vi.fn();
    const view = render(<IDELayout workspaceId="workspace" onBack={onBack} />);
    fireEvent.click(await screen.findByText('alpha.ts'));
    act(() => { socket.receive('file_init', { fileId: 'alpha', content: 'live alpha', version: 0 }); });
    const mountedCursorListener = mocks.onCursor;
    act(() => { mocks.onCursor?.({ position: { column: 3 } }); });
    expect(socket.emit).toHaveBeenCalledWith('cursor_move', { fileId: 'alpha', cursor: { offset: 2 } });

    const refreshedSocket = new FakeSocket();
    socket.connected = false;
    socket.emit.mockClear();
    mocks.socket = refreshedSocket;
    view.rerender(<IDELayout workspaceId="workspace" onBack={onBack} />);
    act(() => { refreshedSocket.receive('file_init', { fileId: 'alpha', content: 'live alpha', version: 0 }); });
    expect(mocks.onCursor).toBe(mountedCursorListener);
    act(() => { mocks.onCursor?.({ position: { column: 5 } }); });
    expect(refreshedSocket.emit).toHaveBeenCalledWith('cursor_move', { fileId: 'alpha', cursor: { offset: 4 } });
    expect(socket.emit).not.toHaveBeenCalledWith('cursor_move', expect.anything());
  });

  it('keeps edits attached to their file while switching tabs and ignores controlled value echoes', async () => {
    await openAlpha();
    expect(edits()).toHaveLength(0);

    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'live alpha edited' } });
    expect(edits()).toHaveLength(1);
    const edit = edits()[0][1];
    expect(edit.fileId).toBe('alpha');

    fireEvent.click(screen.getByText('beta.ts'));
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', true);
    act(() => { socket.receive('file_init', { fileId: 'beta', content: 'live beta', version: 0, persistedVersion: 0 }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live beta');
    expect(edits()).toHaveLength(1);

    // The response for the previous tab must neither replace beta nor lose
    // alpha's draft when alpha is selected again.
    act(() => {
      socket.receive('file_edit_ack', { ...edit, version: 1 });
      socket.receive('file_saved', { fileId: 'alpha', version: 1 });
    });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live beta');
    fireEvent.click(screen.getByRole('button', { name: 'alpha.ts' }));
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live alpha edited');
    expect(edits()).toHaveLength(1);
    expect(mocks.apiClient.patch).not.toHaveBeenCalled();
  });

  it('makes the editor read-only until file synchronization completes again after reconnect', async () => {
    await openAlpha();
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', false);
    act(() => { socket.connected = false; socket.receive('disconnect'); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', true);
    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
    await act(async () => { socket.connected = true; socket.receive('connect'); });
    expect(socket.emit).toHaveBeenCalledWith('join_file', { fileId: 'alpha', sinceVersion: 0 });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', true);
    act(() => { socket.receive('file_init', { fileId: 'alpha', content: 'reconnected alpha', version: 1, persistedVersion: 1 }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('reconnected alpha');
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', false);
    expect(edits()).toHaveLength(0);
  });

  it('immediately locks editing when an out-of-order operation requires a resync', async () => {
    await openAlpha();
    act(() => { socket.receive('file_edit', { fileId: 'alpha', version: 2, operation: [10] }); });
    expect(socket.emit).toHaveBeenCalledWith('join_file', { fileId: 'alpha', sinceVersion: 0 });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', true);
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live alpha');
    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();

    act(() => { socket.receive('file_resync', { fileId: 'alpha', content: 'resynced alpha', version: 2, persistedVersion: 2 }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('resynced alpha');
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', false);
    expect(edits()).toHaveLength(0);
  });

  it('keeps navigation and unload warnings for a preserved draft until it is explicitly dismissed', async () => {
    const onBack = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openAlpha(onBack);
    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'my unreplayed draft' } });

    // Lost server history clears the edit queue and replaces the visible
    // document, but its separate recovery copy still needs protection.
    act(() => { socket.receive('file_resync', { fileId: 'alpha', content: 'server after restart', version: 8, persistedVersion: 8 }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('server after restart');
    expect(screen.getByText('✓ Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download preserved copy' })).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Back to Dashboard'));
    expect(confirm).toHaveBeenCalledWith('Changes or recovered copies are still unsaved. Leave this workspace?');
    expect(onBack).not.toHaveBeenCalled();
    const guardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guardedUnload);
    expect(guardedUnload.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss preserved copy' }));
    expect(screen.getByRole('button', { name: 'Download preserved copy' })).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss preserved copy' }));
    expect(screen.queryByRole('button', { name: 'Download preserved copy' })).not.toBeInTheDocument();
    const unguardedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unguardedUnload);
    expect(unguardedUnload.defaultPrevented).toBe(false);
    confirm.mockClear();
    fireEvent.click(screen.getByTitle('Back to Dashboard'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('opens a snapshot as a read-only preview without changing or saving the live document', async () => {
    await openAlpha();
    fireEvent.click(screen.getByTitle('Snapshots'));
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('historical alpha'));
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', true);
    expect(edits()).toHaveLength(0);
    expect(mocks.apiClient.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Explorer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download alpha.ts' }));
    await waitFor(() => expect(mocks.createFileDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }), 'live alpha'));
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('historical alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live alpha');
    expect(edits()).toHaveLength(0);
  });

  it('preserves acknowledged but unpersisted work when a collaborator deletes its file', async () => {
    const onBack = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openAlpha(onBack);
    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'accepted but not yet saved' } });
    act(() => { socket.receive('file_edit_ack', { ...edits()[0][1], version: 1 }); });
    expect(screen.getByText('Saving...')).toBeInTheDocument();

    files = [file('beta', 'cached beta')];
    await act(async () => {
      socket.receive('file_deleted', { fileId: 'alpha' });
      socket.receive('workspace_files_changed', { workspaceId: 'workspace' });
    });

    expect(screen.queryByRole('textbox', { name: 'Code editor' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download preserved copy' })).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Back to Dashboard'));
    expect(confirm).toHaveBeenCalledWith('Changes or recovered copies are still unsaved. Leave this workspace?');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('offers a recovery copy when a file was deleted while this client was disconnected', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openAlpha();
    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'draft before disconnect' } });
    act(() => { socket.connected = false; socket.receive('disconnect'); });
    files = [file('beta', 'cached beta')];
    await act(async () => { socket.connected = true; socket.receive('connect'); });
    act(() => { socket.receive('authz_error', { event: 'join_file', fileId: 'alpha', message: 'File not found' }); });

    expect(screen.queryByRole('textbox', { name: 'Code editor' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download preserved copy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss preserved copy' }));
    expect(confirm).toHaveBeenCalledOnce();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it('preserves work after an edit denial and stops sending until synchronization resumes', async () => {
    await openAlpha();
    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'draft before access changed' } });
    act(() => { socket.receive('authz_error', { event: 'edit_file', fileId: 'alpha', message: 'You do not have permission to perform this action' }); });

    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveProperty('readOnly', true);
    expect(screen.getByRole('button', { name: 'Download preserved copy' })).toBeInTheDocument();
    expect(edits()).toHaveLength(1);
  });

  it('shows rejected merge recovery without resending and keeps separate copies dismissible', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openAlpha();
    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'first local version' } });
    act(() => { socket.receive('file_resync', { fileId: 'alpha', content: 'first peer version', version: 1, conflict: true, message: 'Concurrent changes could not be merged.' }); });
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('first peer version');
    expect(screen.getByText('Concurrent changes could not be merged.')).toBeInTheDocument();
    expect(edits()).toHaveLength(1);

    fireEvent.change(screen.getByRole('textbox', { name: 'Code editor' }), { target: { value: 'second local version' } });
    act(() => { socket.receive('file_resync', { fileId: 'alpha', content: 'second peer version', version: 2, conflict: true }); });
    expect(edits()).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Download preserved copy' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss preserved copy' })[0]!);
    expect(screen.getAllByRole('button', { name: 'Download preserved copy' })).toHaveLength(1);
  });

  it('updates open tab names and removes deleted tabs when a collaborator changes the tree', async () => {
    await openAlpha();
    files = [file('alpha', 'stale database content', 'renamed.ts'), file('beta', 'cached beta')];
    await act(async () => { socket.receive('workspace_files_changed', { workspaceId: 'workspace' }); });
    expect(screen.getByRole('button', { name: 'renamed.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'alpha.ts' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Code editor' })).toHaveValue('live alpha');
    files = [file('beta', 'cached beta')];
    await act(async () => { socket.receive('workspace_files_changed', { workspaceId: 'workspace' }); });
    expect(screen.queryByRole('button', { name: 'renamed.ts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Code editor' })).not.toBeInTheDocument();
    expect(edits()).toHaveLength(0);
  });
});
