import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePinnedWorkspaces } from './usePinnedWorkspaces';

const key = (userId: string) => `syncscript:pinned-workspaces:${userId}`;

describe('personal workspace pins', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('persists pins across visits and keeps each account separate', () => {
    const { result, rerender, unmount } = renderHook(({ userId }) => usePinnedWorkspaces(userId), { initialProps: { userId: 'alice' } });
    act(() => result.current.toggleWorkspacePin('project-a'));
    expect(JSON.parse(window.localStorage.getItem(key('alice'))!)).toEqual(['project-a']);

    rerender({ userId: 'bob' });
    expect([...result.current.pinnedWorkspaceIds]).toEqual([]);
    act(() => result.current.toggleWorkspacePin('project-b'));
    rerender({ userId: 'alice' });
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-a']);
    expect(JSON.parse(window.localStorage.getItem(key('bob'))!)).toEqual(['project-b']);
    unmount();

    const nextVisit = renderHook(() => usePinnedWorkspaces('alice'));
    expect([...nextVisit.result.current.pinnedWorkspaceIds]).toEqual(['project-a']);
    act(() => nextVisit.result.current.toggleWorkspacePin('project-a'));
    expect(window.localStorage.getItem(key('alice'))).toBe('[]');
  });

  it('syncs matching local-storage changes, removals and clears from another tab', () => {
    const { result } = renderHook(() => usePinnedWorkspaces('alice'));
    const dispatch = (event: StorageEventInit) => act(() => window.dispatchEvent(new StorageEvent('storage', event)));

    dispatch({ key: key('alice'), newValue: '["project-a"]', storageArea: window.localStorage });
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-a']);
    dispatch({ key: key('bob'), newValue: '["project-b"]', storageArea: window.localStorage });
    dispatch({ key: key('alice'), newValue: '["project-c"]', storageArea: window.sessionStorage });
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-a']);
    dispatch({ key: key('alice'), newValue: null, storageArea: window.localStorage });
    expect([...result.current.pinnedWorkspaceIds]).toEqual([]);
    act(() => result.current.toggleWorkspacePin('project-a'));
    dispatch({ key: null, newValue: null, storageArea: window.localStorage });
    expect([...result.current.pinnedWorkspaceIds]).toEqual([]);
  });

  it.each(['not json', '{"project-a":true}', 'null'])('ignores invalid saved pins: %s', (value) => {
    window.localStorage.setItem(key('alice'), value);
    const { result } = renderHook(() => usePinnedWorkspaces('alice'));
    expect([...result.current.pinnedWorkspaceIds]).toEqual([]);
    act(() => result.current.toggleWorkspacePin('project-a'));
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-a']);
  });

  it('only accepts nonempty string IDs from saved data', () => {
    window.localStorage.setItem(key('alice'), '["project-a",null,23,{},"","project-a"]');
    const { result } = renderHook(() => usePinnedWorkspaces('alice'));
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-a']);
  });

  it('keeps toggling pins during the visit if browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    const { result } = renderHook(() => usePinnedWorkspaces('alice'));
    act(() => {
      result.current.toggleWorkspacePin('project-a');
      result.current.toggleWorkspacePin('project-b');
    });
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-a', 'project-b']);
    act(() => result.current.toggleWorkspacePin('project-a'));
    expect([...result.current.pinnedWorkspaceIds]).toEqual(['project-b']);
  });

  it('never stores or returns pins when signed out', () => {
    const { result, rerender } = renderHook(({ userId }: { userId: string | undefined }) => usePinnedWorkspaces(userId), { initialProps: { userId: 'alice' as string | undefined } });
    act(() => result.current.toggleWorkspacePin('project-a'));
    rerender({ userId: undefined });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    act(() => result.current.toggleWorkspacePin('project-b'));
    expect([...result.current.pinnedWorkspaceIds]).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});
