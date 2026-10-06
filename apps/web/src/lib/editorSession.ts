export interface EditorSessionPosition {
  lineNumber: number;
  column: number;
}

export interface EditorSession {
  version: 1;
  openFileIds: string[];
  activeFileId: string | null;
  positions: Record<string, EditorSessionPosition>;
  expandedFolderIds: string[];
}

type ScopeId = string | null | undefined;
type SessionFile = { id: string; type: 'FILE' | 'FOLDER' };

const MAX_TABS = 50;
const MAX_FOLDERS = 200;
const MAX_ID_LENGTH = 256;
const MAX_COORDINATE = 1_000_000;
const MAX_STORED_LENGTH = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && value.trim().length > 0;
}

function storageKey(userId: ScopeId, workspaceId: ScopeId): string | null {
  if (!isId(userId) || !isId(workspaceId)) return null;
  return `syncscript:editor-session:v1:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
}

function normalizeIds(values: unknown[], limit: number): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (isId(value)) ids.add(value);
    if (ids.size === limit) break;
  }
  return [...ids];
}

function coordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_COORDINATE);
}

function positionsForTabs(value: Record<string, unknown>, openFileIds: string[]): Record<string, EditorSessionPosition> {
  const entries: Array<[string, EditorSessionPosition]> = [];
  for (const id of openFileIds) {
    if (!Object.prototype.hasOwnProperty.call(value, id)) continue;
    const position = value[id];
    if (!isRecord(position)) continue;
    const lineNumber = coordinate(position.lineNumber);
    const column = coordinate(position.column);
    if (lineNumber !== null && column !== null) entries.push([id, { lineNumber, column }]);
  }
  // Define ordinary own properties even for an ID such as "__proto__".
  return Object.fromEntries(entries);
}

function normalizeSession(value: unknown): EditorSession | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.openFileIds)
    || !Array.isArray(value.expandedFolderIds) || !isRecord(value.positions)
    || (value.activeFileId !== null && typeof value.activeFileId !== 'string')) return null;

  const openFileIds = normalizeIds(value.openFileIds, MAX_TABS);
  if (openFileIds.length === MAX_TABS && isId(value.activeFileId)
    && !openFileIds.includes(value.activeFileId) && value.openFileIds.includes(value.activeFileId)) {
    // An active tab beyond the cap follows every retained tab in the original order.
    openFileIds[MAX_TABS - 1] = value.activeFileId;
  }
  return {
    version: 1,
    openFileIds,
    activeFileId: typeof value.activeFileId === 'string' && openFileIds.includes(value.activeFileId)
      ? value.activeFileId
      : openFileIds.at(-1) ?? null,
    positions: positionsForTabs(value.positions, openFileIds),
    expandedFolderIds: normalizeIds(value.expandedFolderIds, MAX_FOLDERS),
  };
}

/** Personal navigation metadata for one account and workspace on this browser. */
export function readEditorSession(userId: ScopeId, workspaceId: ScopeId): EditorSession | null {
  try {
    const key = storageKey(userId, workspaceId);
    if (!key) return null;
    const stored = window.localStorage.getItem(key);
    if (stored === null || stored.length > MAX_STORED_LENGTH) return null;
    return normalizeSession(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** Rebuild the stored object so file contents, names and credentials cannot be included. */
export function writeEditorSession(userId: ScopeId, workspaceId: ScopeId, session: EditorSession): boolean {
  try {
    const key = storageKey(userId, workspaceId);
    if (!key) return false;
    const normalized = normalizeSession(session);
    if (!normalized) return false;
    const stored = JSON.stringify(normalized);
    if (stored.length > MAX_STORED_LENGTH) return false;
    window.localStorage.setItem(key, stored);
    return true;
  } catch {
    // Navigation continues to work when storage is unavailable or full.
    return false;
  }
}

export function clearEditorSession(userId: ScopeId, workspaceId: ScopeId): void {
  try {
    const key = storageKey(userId, workspaceId);
    if (key) window.localStorage.removeItem(key);
  } catch {
    // Clearing session metadata must not interrupt the editor.
  }
}

/** Call only with a successful complete file listing; an empty listing removes all saved IDs. */
export function reconcileEditorSession(session: EditorSession, files: readonly SessionFile[]): EditorSession {
  const normalized = normalizeSession(session) ?? {
    version: 1,
    openFileIds: [],
    activeFileId: null,
    positions: {},
    expandedFolderIds: [],
  };
  const types = new Map(files.map(file => [file.id, file.type]));
  const openFileIds = normalized.openFileIds.filter(id => types.get(id) === 'FILE');
  return {
    version: 1,
    openFileIds,
    activeFileId: normalized.activeFileId && openFileIds.includes(normalized.activeFileId)
      ? normalized.activeFileId
      : openFileIds.at(-1) ?? null,
    positions: positionsForTabs(normalized.positions, openFileIds),
    expandedFolderIds: normalized.expandedFolderIds.filter(id => types.get(id) === 'FOLDER'),
  };
}
