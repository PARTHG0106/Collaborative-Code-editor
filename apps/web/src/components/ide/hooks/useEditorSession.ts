import { useCallback, useEffect, useRef, useState } from 'react';
import { readEditorSession, writeEditorSession, type EditorSession, type EditorSessionPosition } from '../../../lib/editorSession';

/** Persist navigation metadata without putting document contents in browser storage. */
export function useEditorSession(userId: string | undefined, workspaceId: string) {
  const [savedSession] = useState(() => readEditorSession(userId, workspaceId));
  const positions = useRef(savedSession?.positions ?? {});
  const currentSession = useRef<EditorSession | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (currentSession.current) {
      writeEditorSession(userId, workspaceId, { ...currentSession.current, positions: positions.current });
    }
  }, [userId, workspaceId]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const saveNavigation = useCallback((openFileIds: string[], activeFileId: string | null, expandedFolderIds: string[]) => {
    currentSession.current = { version: 1, openFileIds, activeFileId, expandedFolderIds, positions: {} };
    flush();
  }, [flush]);

  const getPosition = useCallback((fileId: string) => (
    Object.prototype.hasOwnProperty.call(positions.current, fileId) ? positions.current[fileId] : undefined
  ), []);

  const savePosition = useCallback((fileId: string, position: EditorSessionPosition) => {
    const previous = getPosition(fileId);
    if (previous?.lineNumber === position.lineNumber && previous.column === position.column) return;
    positions.current = { ...positions.current, [fileId]: position };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 300);
  }, [flush, getPosition]);

  return { savedSession, saveNavigation, getPosition, savePosition };
}
