import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEditorSession,
  readEditorSession,
  reconcileEditorSession,
  writeEditorSession,
  type EditorSession,
} from './editorSession';

const key = (userId = 'alice', workspaceId = 'workspace-a') =>
  `syncscript:editor-session:v1:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;

function session(overrides: Partial<EditorSession> = {}): EditorSession {
  return {
    version: 1,
    openFileIds: ['file-b', 'file-a'],
    activeFileId: 'file-b',
    positions: {
      'file-b': { lineNumber: 25, column: 8 },
      'file-a': { lineNumber: 2, column: 1 },
    },
    expandedFolderIds: ['folder-a'],
    ...overrides,
  };
}

const emptySession = (): EditorSession => session({
  openFileIds: [], activeFileId: null, positions: {}, expandedFolderIds: [],
});

describe('editor session metadata', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round trips tab order, the active file, cursor positions and expanded folders', () => {
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
    const saved = session();
    expect(writeEditorSession('alice', 'workspace-a', saved)).toBe(true);
    expect(readEditorSession('alice', 'workspace-a')).toEqual(saved);
    expect(readEditorSession('alice', 'workspace-a')).not.toBe(saved);
  });

  it('preserves an intentionally empty session separately from a missing session', () => {
    expect(writeEditorSession('alice', 'workspace-a', emptySession())).toBe(true);
    expect(readEditorSession('alice', 'workspace-a')).toEqual(emptySession());
    expect(reconcileEditorSession(emptySession(), [{ id: 'file-a', type: 'FILE' }])).toEqual(emptySession());
    clearEditorSession('alice', 'workspace-a');
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
  });

  it('isolates accounts and workspaces, including ambiguous separators in their IDs', () => {
    writeEditorSession('alice', 'workspace-a', session());
    writeEditorSession('bob', 'workspace-a', emptySession());
    writeEditorSession('alice', 'workspace-b', session({ activeFileId: 'file-a' }));
    writeEditorSession('alice:team', 'workspace', session());
    writeEditorSession('alice', 'team:workspace', emptySession());
    writeEditorSession('alice%3Ateam', 'workspace', emptySession());

    expect(readEditorSession('alice', 'workspace-a')).toEqual(session());
    expect(readEditorSession('bob', 'workspace-a')).toEqual(emptySession());
    expect(readEditorSession('alice', 'workspace-b')?.activeFileId).toBe('file-a');
    expect(readEditorSession('alice:team', 'workspace')).toEqual(session());
    expect(readEditorSession('alice', 'team:workspace')).toEqual(emptySession());
    expect(readEditorSession('alice%3Ateam', 'workspace')).toEqual(emptySession());

    clearEditorSession('alice', 'workspace-a');
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
    expect(readEditorSession('bob', 'workspace-a')).toEqual(emptySession());
    expect(readEditorSession('alice', 'workspace-b')?.activeFileId).toBe('file-a');
  });

  it.each([
    'not json', 'null', '[]', '{}',
    JSON.stringify({ ...session(), version: 2 }),
    JSON.stringify({ ...session(), openFileIds: 'file-a' }),
    JSON.stringify({ ...session(), activeFileId: 1 }),
    JSON.stringify({ ...session(), positions: [] }),
    JSON.stringify({ ...session(), expandedFolderIds: null }),
  ])('ignores malformed or unsupported stored sessions: %s', (stored) => {
    window.localStorage.setItem(key(), stored);
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
  });

  it('rejects oversized stored values before parsing them', () => {
    window.localStorage.setItem(key(), JSON.stringify({ ...session(), content: 'x'.repeat(256 * 1024) }));
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
  });

  it('deduplicates and bounds IDs while retaining an active tab beyond the cap in its original order', () => {
    const openFileIds = Array.from({ length: 70 }, (_, index) => `file-${index}`);
    const expandedFolderIds = Array.from({ length: 250 }, (_, index) => `folder-${index}`);
    const stored = {
      ...session(),
      openFileIds: [null, '', 42, ' ', 'x'.repeat(257), 'file-0', ...openFileIds],
      activeFileId: 'file-69',
      expandedFolderIds: [{}, '', 'folder-0', ...expandedFolderIds],
      positions: Object.fromEntries(openFileIds.map(id => [id, { lineNumber: 1, column: 1 }])),
    };
    window.localStorage.setItem(key(), JSON.stringify(stored));
    const restored = readEditorSession('alice', 'workspace-a');
    const expectedTabs = [...openFileIds.slice(0, 49), 'file-69'];
    expect(restored?.openFileIds).toEqual(expectedTabs);
    expect(restored?.expandedFolderIds).toEqual(expandedFolderIds.slice(0, 200));
    expect(restored?.activeFileId).toBe('file-69');
    expect(Object.keys(restored!.positions)).toEqual(expectedTabs);
    expect(writeEditorSession('alice', 'workspace-a', stored as unknown as EditorSession)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(key())!)).toEqual(restored);
  });

  it('does not add an unknown active file when limiting tabs', () => {
    const openFileIds = Array.from({ length: 70 }, (_, index) => `file-${index}`);
    writeEditorSession('alice', 'workspace-a', session({ openFileIds, activeFileId: 'unknown-file' }));
    const restored = readEditorSession('alice', 'workspace-a');
    expect(restored?.openFileIds).toEqual(openFileIds.slice(0, 50));
    expect(restored?.activeFileId).toBe('file-49');
  });

  it('keeps only bounded positive integer positions for saved tabs', () => {
    const openFileIds = ['valid', 'large', 'zero', 'negative', 'fraction', 'nan', 'infinite', 'string', 'missing'];
    const saved = session({
      openFileIds,
      activeFileId: 'valid',
      positions: {
        valid: { lineNumber: 12, column: 3 },
        large: { lineNumber: 2_000_000, column: Number.MAX_VALUE },
        zero: { lineNumber: 0, column: 1 },
        negative: { lineNumber: 1, column: -3 },
        fraction: { lineNumber: 1.5, column: 2 },
        nan: { lineNumber: Number.NaN, column: 1 },
        infinite: { lineNumber: 1, column: Number.POSITIVE_INFINITY },
        string: { lineNumber: '10', column: 1 } as unknown as EditorSession['positions'][string],
        closed: { lineNumber: 10, column: 2 },
      },
    });
    writeEditorSession('alice', 'workspace-a', saved);
    expect(readEditorSession('alice', 'workspace-a')?.positions).toEqual({
      valid: { lineNumber: 12, column: 3 },
      large: { lineNumber: 1_000_000, column: 1_000_000 },
    });
  });

  it('persists only metadata even if callers supply content, file names, credentials or extra position fields', () => {
    const input = {
      ...session(),
      content: 'private source code',
      name: 'secret-file.ts',
      token: 'secret-token',
      files: [{ id: 'file-b', name: 'secret-file.ts', content: 'private source code' }],
      positions: { 'file-b': { lineNumber: 25, column: 8, content: 'private source code', token: 'secret-token' } },
    };
    writeEditorSession('alice', 'workspace-a', input);
    const stored = window.localStorage.getItem(key())!;
    expect(JSON.parse(stored)).toEqual(session({ positions: { 'file-b': { lineNumber: 25, column: 8 } } }));
    expect(stored).not.toMatch(/content|name|token|private source code|secret-file/);
  });

  it('reconciles only against the provided successful listing and does not mutate saved storage or its arguments', () => {
    const saved = session({
      openFileIds: ['file-b', 'deleted', 'folder-a', 'file-a', 'file-b'],
      activeFileId: 'deleted',
      positions: {
        'file-b': { lineNumber: 25, column: 8 },
        deleted: { lineNumber: 9, column: 1 },
        'folder-a': { lineNumber: 1, column: 1 },
        'file-a': { lineNumber: 2, column: 1 },
      },
      expandedFolderIds: ['folder-a', 'deleted-folder', 'file-a', 'folder-a'],
    });
    const files = [
      { id: 'file-a', type: 'FILE' as const },
      { id: 'folder-a', type: 'FOLDER' as const },
      { id: 'file-b', type: 'FILE' as const },
      { id: 'new-file', type: 'FILE' as const },
    ];
    writeEditorSession('alice', 'workspace-a', saved);
    const before = JSON.stringify({ saved, files });
    const stored = window.localStorage.getItem(key());
    expect(reconcileEditorSession(saved, files)).toEqual(session({ activeFileId: 'file-a' }));
    expect(JSON.stringify({ saved, files })).toBe(before);
    expect(window.localStorage.getItem(key())).toBe(stored);
    expect(reconcileEditorSession(saved, [])).toEqual(emptySession());
    expect(reconcileEditorSession(session(), files).activeFileId).toBe('file-b');
  });

  it('handles reserved object property names as ordinary file IDs', () => {
    const positions = JSON.parse('{"__proto__":{"lineNumber":4,"column":2},"constructor":{"lineNumber":3,"column":1}}');
    const saved = session({ openFileIds: ['__proto__', 'constructor'], activeFileId: '__proto__', positions });
    writeEditorSession('alice', 'workspace-a', saved);
    const restored = readEditorSession('alice', 'workspace-a');
    expect(restored).toEqual(saved);
    expect(Object.keys(restored!.positions)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(restored!.positions)).toBe(Object.prototype);
  });

  it.each([undefined, null, '', ' ', 'x'.repeat(257), '\ud800'])('does not use storage without a valid account and workspace: %s', (id) => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    expect(readEditorSession(id, 'workspace-a')).toBeNull();
    expect(readEditorSession('alice', id)).toBeNull();
    expect(writeEditorSession(id, 'workspace-a', session())).toBe(false);
    expect(writeEditorSession('alice', id, session())).toBe(false);
    clearEditorSession(id, 'workspace-a');
    clearEditorSession('alice', id);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects malformed writes without replacing an existing saved session', () => {
    writeEditorSession('alice', 'workspace-a', session());
    expect(writeEditorSession('alice', 'workspace-a', null as unknown as EditorSession)).toBe(false);
    expect(readEditorSession('alice', 'workspace-a')).toEqual(session());
  });

  it('rejects writes whose escaped IDs exceed the stored size limit', () => {
    writeEditorSession('alice', 'workspace-a', session());
    const id = '\u0000'.repeat(250);
    const oversized = session({
      openFileIds: Array.from({ length: 50 }, (_, index) => `${id}f${index}`),
      expandedFolderIds: Array.from({ length: 200 }, (_, index) => `${id}d${index}`),
    });
    expect(writeEditorSession('alice', 'workspace-a', oversized)).toBe(false);
    expect(readEditorSession('alice', 'workspace-a')).toEqual(session());
  });

  it('gracefully handles blocked storage access and full storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
    expect(writeEditorSession('alice', 'workspace-a', session())).toBe(false);
    expect(() => clearEditorSession('alice', 'workspace-a')).not.toThrow();
  });

  it('gracefully handles a denied localStorage getter', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('Storage denied'); });
    expect(readEditorSession('alice', 'workspace-a')).toBeNull();
    expect(writeEditorSession('alice', 'workspace-a', session())).toBe(false);
    expect(() => clearEditorSession('alice', 'workspace-a')).not.toThrow();
  });
});
