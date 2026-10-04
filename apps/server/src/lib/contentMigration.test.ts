import { describe, expect, it, vi } from 'vitest';
import { migrateContentRow } from './contentMigration.js';

describe('D1 content migration', () => {
  it('publishes only after upload and reports concurrent edit conflicts without overwriting', async () => {
    const row = { id: 'file', content: 'old edit', contentKey: null, updatedAt: new Date() };
    const store = { put: vi.fn(async () => 'key'), get: vi.fn(async () => '') };
    const commit = vi.fn(async () => { expect(store.put).toHaveBeenCalledWith('old edit'); return false; });
    expect(await migrateContentRow(row, 'backfill', store, commit)).toBe('raced');
    expect(commit).toHaveBeenCalledWith(row, '', 'key');
  });

  it('leaves SQL untouched when uploads or restore reads fail', async () => {
    const store = { put: vi.fn(async () => { throw new Error('unavailable'); }), get: vi.fn(async () => { throw new Error('missing'); }) };
    const commit = vi.fn(async () => true);
    await expect(migrateContentRow({ id: 'file', content: 'code', contentKey: null }, 'backfill', store, commit)).rejects.toThrow('unavailable');
    await expect(migrateContentRow({ id: 'file', content: '', contentKey: 'key' }, 'restore', store, commit)).rejects.toThrow('missing');
    expect(commit).not.toHaveBeenCalled();
  });

  it('restores the exact blob and clears the key atomically', async () => {
    const row = { id: 'version', content: '', contentKey: 'key' };
    const store = { put: vi.fn(async () => ''), get: vi.fn(async () => 'saved code') };
    const commit = vi.fn(async () => true);
    expect(await migrateContentRow(row, 'restore', store, commit)).toBe('changed');
    expect(commit).toHaveBeenCalledWith(row, 'saved code', null);
  });

  it('is resumable without rewriting rows already in the destination store', async () => {
    const store = { put: vi.fn(async () => ''), get: vi.fn(async () => '') };
    const commit = vi.fn(async () => true);
    expect(await migrateContentRow({ id: 'file', content: '', contentKey: 'key' }, 'backfill', store, commit)).toBe('unchanged');
    expect(await migrateContentRow({ id: 'file', content: 'code', contentKey: null }, 'restore', store, commit)).toBe('unchanged');
    expect(store.put).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});
