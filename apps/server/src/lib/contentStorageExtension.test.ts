import { describe, expect, it, vi } from 'vitest';
import { createContentQuery } from './contentStorageExtension.js';
import { contentKey } from './d1ContentStore.js';

function setup(writeToD1 = true) {
  const contents = new Map<string, string>();
  const store = {
    put: vi.fn(async (content: string) => { const key = contentKey(content); contents.set(key, content); return key; }),
    get: vi.fn(async (key: string) => { if (!contents.has(key)) throw new Error('Missing blob'); return contents.get(key)!; }),
  };
  return { store, run: createContentQuery({ writeToD1, store }) };
}

describe('Prisma content storage boundary', () => {
  it('persists the D1 blob before the SQL reference, then returns hydrated contents', async () => {
    const { store, run } = setup();
    const query = vi.fn(async (args: Record<string, unknown>) => {
      expect(store.put).toHaveBeenCalledWith('new code');
      expect(args.data).toEqual({ content: '', contentKey: contentKey('new code') });
      return { id: 'file', ...(args.data as object) };
    });
    const result = await run({ model: 'FileSystemItem', operation: 'update', args: { where: { id: 'file' }, data: { content: 'new code' } }, query });
    expect(result).toEqual({ id: 'file', content: 'new code' });
  });

  it('never updates SQL when D1 fails and never falls back to an empty SQL placeholder', async () => {
    const { store, run } = setup();
    store.put.mockRejectedValueOnce(new Error('D1 unavailable'));
    const query = vi.fn(async () => ({}));
    await expect(run({ model: 'FileVersion', operation: 'create', args: { data: { content: 'snapshot' } }, query })).rejects.toThrow('D1 unavailable');
    expect(query).not.toHaveBeenCalled();
    await expect(run({ model: 'FileSystemItem', operation: 'findUnique', args: {}, query: async () => ({ content: '', contentKey: 'missing' }) })).rejects.toThrow('Missing blob');
  });

  it('supports partial content selections and nested relation reads', async () => {
    const { store, run } = setup();
    const key = await store.put('snapshot');
    const query = vi.fn(async () => ({ versions: [{ content: '', contentKey: key }] }));
    expect(await run({ model: 'FileSystemItem', operation: 'findUnique', args: { select: { versions: { select: { content: true } } } }, query }))
      .toEqual({ versions: [{ content: 'snapshot' }] });
    expect(query).toHaveBeenCalledWith({ select: { versions: { select: { content: true, contentKey: true } } } });
  });

  it('handles deep mixed include/select/omit relations without losing the storage key', async () => {
    const { store, run } = setup();
    const key = await store.put('deep code');
    const query = vi.fn(async () => ({ workspace: { fileSystemItems: [{ content: '', contentKey: key, versions: [{ content: '', contentKey: key }] }] } }));
    const result = await run({ model: 'WorkspaceMember', operation: 'findUnique', args: { include: { workspace: { select: {
      fileSystemItems: { omit: { contentKey: true }, include: { versions: { select: { content: true, contentKey: false } } } },
    } } } }, query });
    expect(result).toEqual({ workspace: { fileSystemItems: [{ content: 'deep code', versions: [{ content: 'deep code' }] }] } });
    expect(query).toHaveBeenCalledWith({ include: { workspace: { select: {
      fileSystemItems: { omit: { contentKey: false }, include: { versions: { select: { content: true, contentKey: true } } } },
    } } } });
  });

  it('does not interpret user JSON as model relations or a content pointer', async () => {
    const { store, run } = setup();
    const outputs = { content: 'literal text', contentKey: 'literal user JSON', nested: { content: 'also literal' } };
    const query = vi.fn(async () => ({ outputs }));
    expect(await run({ model: 'NotebookSession', operation: 'update', args: { data: { outputs } }, query })).toEqual({ outputs });
    expect(query).toHaveBeenCalledWith({ data: { outputs } });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('preserves metadata-only rename and avoids reading blobs for metadata-only lists', async () => {
    const { store, run } = setup();
    const query = vi.fn(async () => ({ id: 'version', version: 2 }));
    await run({ model: 'FileSystemItem', operation: 'update', args: { data: { name: 'renamed.py' }, select: { id: true } }, query });
    expect(query).toHaveBeenCalledWith({ data: { name: 'renamed.py' }, select: { id: true } });
    expect(store.put).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('keeps legacy inline contents and null folders readable without D1 configured', async () => {
    const run = createContentQuery({ writeToD1: false });
    expect(await run({ model: 'FileSystemItem', operation: 'findMany', args: {}, query: async () => [
      { content: 'old code', contentKey: null }, { content: null, contentKey: null },
    ] })).toEqual([{ content: 'old code' }, { content: null }]);
    await expect(run({ model: 'FileSystemItem', operation: 'findUnique', args: {}, query: async () => ({ content: '', contentKey: 'remote' }) }))
      .rejects.toThrow('restore D1 configuration');
  });

  it('rollback mode reads existing D1 keys and clears them on subsequent inline writes', async () => {
    const { store, run } = setup(false);
    const key = await store.put('remote');
    expect(await run({ model: 'FileVersion', operation: 'findUnique', args: {}, query: async () => ({ content: '', contentKey: key }) })).toEqual({ content: 'remote' });
    const query = vi.fn(async (args: Record<string, unknown>) => args.data);
    expect(await run({ model: 'FileSystemItem', operation: 'update', args: { data: { content: { set: 'inline' } } }, query })).toEqual({ content: 'inline' });
    expect(query).toHaveBeenCalledWith({ data: { content: 'inline', contentKey: null } });
  });

  it('rejects application-supplied keys and unsupported nested content writes', async () => {
    const { run } = setup();
    const query = vi.fn(async () => ({}));
    await expect(run({ model: 'FileVersion', operation: 'create', args: { data: { contentKey: 'other-file', content: '' } }, query })).rejects.toThrow('managed');
    await expect(run({ model: 'Workspace', operation: 'create', args: { data: { fileSystemItems: { create: { content: 'nested' } } } }, query })).rejects.toThrow('directly');
    expect(query).not.toHaveBeenCalled();
  });
});
