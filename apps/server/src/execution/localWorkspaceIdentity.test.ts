import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareIdentity, workspaceJailKey } from './localWorkspaceRuntime.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

type Entry = { kind: 'directory' | 'file' | 'symlink'; uid: number; gid: number; mode: number; content?: string };
const state = '/var/lib/syncscript/workspaces';
const normalize = (value: unknown) => String(value).replaceAll('\\', '/');
const directory = (uid = 0, mode = 0o711): Entry => ({ kind: 'directory', uid, gid: uid, mode });
const failure = (code: string) => Object.assign(new Error(code), { code });

describe('Landlock workspace identity preparation', () => {
  let entries: Map<string, Entry>;
  let platform: PropertyDescriptor | undefined;
  let getuid: PropertyDescriptor | undefined;

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
    getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 });
    entries = new Map([
      ['/var', directory(0, 0o755)], ['/var/lib', directory(0, 0o755)],
      ['/var/lib/syncscript', directory(0, 0o700)], [state, directory(0, 0o700)],
      ['/usr/local/bin/syncscript-sandbox', { kind: 'file', uid: 0, gid: 0, mode: 0o755 }],
    ]);
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    vi.spyOn(fs, 'lstat').mockImplementation(async target => {
      const item = entries.get(normalize(target));
      if (!item) throw failure('ENOENT');
      return { ...item, isDirectory: () => item.kind === 'directory', isFile: () => item.kind === 'file', isSymbolicLink: () => item.kind === 'symlink' } as never;
    });
    vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
      const name = normalize(target);
      if (entries.has(name)) throw failure('EEXIST');
      const mode = typeof options === 'object' ? Number(options?.mode ?? 0o777) : Number(options ?? 0o777);
      entries.set(name, directory(0, mode));
      return undefined;
    });
    vi.spyOn(fs, 'chmod').mockImplementation(async (target, mode) => { entries.get(normalize(target))!.mode = Number(mode); });
    vi.spyOn(fs, 'chown').mockImplementation(async (target, uid, gid) => { Object.assign(entries.get(normalize(target))!, { uid, gid }); });
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, content) => {
      entries.set(normalize(target), { kind: 'file', uid: 0, gid: 0, mode: 0o600, content: String(content) });
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async target => entries.get(normalize(target))!.content as never);
    vi.spyOn(fs, 'readdir').mockImplementation(async target => {
      const prefix = normalize(target) + '/';
      return [...entries.keys()].filter(name => name.startsWith(prefix) && !name.slice(prefix.length).includes('/')).map(name => name.slice(prefix.length)) as never;
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      const oldName = normalize(oldPath);
      const newName = normalize(newPath);
      for (const [name, item] of [...entries]) if (name === oldName || name.startsWith(oldName + '/')) {
        entries.delete(name);
        entries.set(newName + name.slice(oldName.length), item);
      }
    });
    vi.spyOn(fs, 'rmdir').mockImplementation(async target => { entries.delete(normalize(target)); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (platform) Object.defineProperty(process, 'platform', platform);
    if (getuid) Object.defineProperty(process, 'getuid', getuid);
    else Reflect.deleteProperty(process, 'getuid');
  });

  it('creates only the two private writable directories and keeps ancestors traversable without copying tools', async () => {
    const identity = await prepareIdentity('minimal-workspace');
    const root = normalize(identity.root);
    expect(identity.uid).toBe(10000);
    expect(root).toBe(state + '/' + workspaceJailKey('minimal-workspace'));
    expect([...entries.keys()].filter(name => name.startsWith(root + '/'))).toEqual([root + '/workspace', root + '/tmp']);
    expect(entries.get(root)).toMatchObject({ kind: 'directory', uid: 0, mode: 0o711 });
    for (const leaf of ['workspace', 'tmp']) expect(entries.get(root + '/' + leaf)).toMatchObject({ uid: 10000, gid: 10000, mode: 0o700 });
    for (const ancestor of ['/var/lib/syncscript', state]) expect(entries.get(ancestor)?.mode).toBe(0o711);
    expect(entries.get(state + '/identities.json')?.mode).toBe(0o600);
    expect(mocks.spawn.mock.calls.every(([command]) => command === '/usr/local/bin/syncscript-sandbox')).toBe(true);
    expect(vi.mocked(fs.lstat).mock.calls.some(([target]) => normalize(target).includes('rootfs'))).toBe(false);
    expect(await prepareIdentity('minimal-workspace')).toEqual(identity);
    expect(mocks.spawn).toHaveBeenLastCalledWith('/usr/local/bin/syncscript-sandbox', ['--kill-workspace', '--uid', '10000', '--gid', '10000'], expect.any(Object));
  });

  it.each(['owner', 'writable', 'symlink'])('rejects an unsafe %s ancestor before changing its mode or allocating an identity', async reason => {
    const unsafe = entries.get('/var/lib/syncscript')!;
    if (reason === 'owner') unsafe.uid = 1000;
    if (reason === 'writable') unsafe.mode = 0o777;
    if (reason === 'symlink') unsafe.kind = 'symlink';
    await expect(prepareIdentity('unsafe-ancestor')).rejects.toThrow('root-owned');
    expect(fs.chmod).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(['owner', 'writable', 'symlink'])('rejects an existing %s writable leaf without following or repairing it', async reason => {
    const identity = await prepareIdentity('existing-workspace');
    const leaf = entries.get(normalize(identity.root) + '/workspace')!;
    if (reason === 'owner') leaf.uid = 10001;
    if (reason === 'writable') leaf.mode = 0o777;
    if (reason === 'symlink') leaf.kind = 'symlink';
    vi.mocked(fs.chown).mockClear();
    mocks.spawn.mockClear();
    await expect(prepareIdentity('existing-workspace')).rejects.toThrow('do not match');
    expect(fs.chown).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses an unrecorded identity directory instead of risking UID reuse', async () => {
    entries.set(state + '/' + workspaceJailKey('orphan'), directory());
    await expect(prepareIdentity('new-workspace')).rejects.toThrow('without a recorded identity');
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
