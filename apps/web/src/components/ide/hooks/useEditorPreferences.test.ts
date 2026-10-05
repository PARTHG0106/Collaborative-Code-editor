import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EDITOR_PREFERENCES, useEditorPreferences } from './useEditorPreferences';

const storageKey = 'syncscript-editor-preferences';

describe('useEditorPreferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it.each(['not json', 'null', '[]', '42'])('uses safe defaults for malformed stored preferences: %s', (stored) => {
    localStorage.setItem(storageKey, stored);
    const { result } = renderHook(() => useEditorPreferences());
    expect(result.current.preferences).toEqual(DEFAULT_EDITOR_PREFERENCES);
  });

  it('validates each stored preference without losing other valid choices', () => {
    localStorage.setItem(storageKey, JSON.stringify({ fontSize: 300, tabSize: 4, wordWrap: 'off', minimap: false }));
    const { result } = renderHook(() => useEditorPreferences());
    expect(result.current.preferences).toEqual({ fontSize: 14, tabSize: 4, wordWrap: true, minimap: false });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(result.current.preferences);
  });

  it('keeps preferences usable for the session when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Access denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    const { result } = renderHook(() => useEditorPreferences());
    expect(result.current.preferences).toEqual(DEFAULT_EDITOR_PREFERENCES);
    act(() => result.current.setPreferences({ ...DEFAULT_EDITOR_PREFERENCES, fontSize: 24, minimap: false }));
    expect(result.current.preferences.fontSize).toBe(24);
    expect(result.current.preferences.minimap).toBe(false);
  });
});
