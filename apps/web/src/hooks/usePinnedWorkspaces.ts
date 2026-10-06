import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_PINS: ReadonlySet<string> = new Set();

function storageKey(userId: string) {
  return `syncscript:pinned-workspaces:${userId}`;
}

function parsePins(value: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : []);
  } catch {
    return new Set();
  }
}

function readPins(userId: string | undefined): Set<string> {
  if (!userId) return new Set();
  try {
    return parsePins(window.localStorage.getItem(storageKey(userId)));
  } catch {
    return new Set();
  }
}

/** Personal shortcuts, saved separately for each account on this browser. */
export function usePinnedWorkspaces(userId: string | undefined) {
  const [saved, setSaved] = useState(() => ({ userId, pins: readPins(userId) }));
  const savedRef = useRef(saved);

  useEffect(() => {
    const next = { userId, pins: readPins(userId) };
    savedRef.current = next;
    setSaved(next);

    if (!userId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey(userId) && event.key !== null) return;
      if (event.storageArea) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
      }
      const updated = { userId, pins: parsePins(event.newValue) };
      savedRef.current = updated;
      setSaved(updated);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  const toggleWorkspacePin = useCallback((workspaceId: string) => {
    if (!userId || !workspaceId) return;
    const previous = savedRef.current;
    const pins = new Set(previous.userId === userId ? previous.pins : readPins(userId));
    if (pins.has(workspaceId)) pins.delete(workspaceId);
    else pins.add(workspaceId);
    const next = { userId, pins };
    savedRef.current = next;
    setSaved(next);
    try {
      window.localStorage.setItem(storageKey(userId), JSON.stringify([...pins]));
    } catch {
      // Pinning still works for this visit if browser storage is blocked or full.
    }
  }, [userId]);

  return {
    pinnedWorkspaceIds: saved.userId === userId ? saved.pins : EMPTY_PINS,
    toggleWorkspacePin,
  };
}
