import { useEffect, useState } from 'react';

export interface EditorPreferences {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = { fontSize: 14, tabSize: 2, wordWrap: true, minimap: true };
const STORAGE_KEY = 'syncscript-editor-preferences';

export function useEditorPreferences() {
  const [preferences, setPreferences] = useState<EditorPreferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        fontSize: [12, 14, 16, 18, 20, 22, 24].includes(saved?.fontSize) ? saved.fontSize : 14,
        tabSize: [2, 4, 8].includes(saved?.tabSize) ? saved.tabSize : 2,
        wordWrap: typeof saved?.wordWrap === 'boolean' ? saved.wordWrap : true,
        minimap: typeof saved?.minimap === 'boolean' ? saved.minimap : true,
      };
    } catch { return DEFAULT_EDITOR_PREFERENCES; }
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Preferences still work for this session when storage is unavailable. */ }
  }, [preferences]);
  return { preferences, setPreferences };
}
