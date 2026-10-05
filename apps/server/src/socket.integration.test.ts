import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as SocketServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from './lib/prisma.js';
import { config } from './config/index.js';
import { invalidateAuthz } from './lib/socketAuthz.js';
import { forgetActiveFiles, getActiveFileContent, initSocketServer, replaceFileContent, updateActiveFileName } from './socket.js';
import { operationFromSplices } from '../../../packages/text-ot/index.js';
import { connectedRuntime } from './execution/workspaceRuntime.js';

vi.mock('./execution/executionSocket.js', () => ({ registerExecutionHandlers: vi.fn() }));
vi.mock('./execution/workspaceRuntime.js', async importOriginal => ({
  ...await importOriginal<typeof import('./execution/workspaceRuntime.js')>(),
  connectedRuntime: vi.fn(),
}));
vi.mock('./lib/prisma.js', () => {
  const client = {
    fileSystemItem: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    fileVersion: { count: vi.fn(), create: vi.fn() },
    chatMessage: { create: vi.fn() },
  };
  return { default: client, prisma: client };
});

let server: Server;
let io: SocketServer;
let url: string;
let fileId: string;
let workspaceId: string;
let row: any;
let sequence = 0;
const clients: ClientSocket[] = [];

function event(socket: ClientSocket, name: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 5000);
    socket.once(name, value => { clearTimeout(timer); resolve(value); });
  });
}

async function client(userId = `user-${clients.length}-${sequence}`): Promise<ClientSocket> {
  const socket = connect(url, {
    transports: ['websocket'],
    forceNew: true,
    auth: { token: jwt.sign({ userId, email: `${userId}@example.test`, name: userId }, config.jwt.accessSecret) },
  });
  clients.push(socket);
  await event(socket, 'connect');
  return socket;
}

async function join(socket: ClientSocket, sinceVersion?: number): Promise<any> {
  const response = event(socket, 'file_init');
  socket.emit('join_file', { fileId, sinceVersion });
  return response;
}

async function edit(socket: ClientSocket, baseVersion: number, baseLength: number, offset: number, length: number, text: string, editId?: string): Promise<any> {
  const response = event(socket, 'file_edit_ack');
  socket.emit('edit_file', { fileId, baseVersion, editId, operation: operationFromSplices(baseLength, [{ offset, length, text }]) });
  return response;
}

beforeEach(async () => {
  vi.resetAllMocks();
  sequence++;
  fileId = `file-${sequence}`;
  workspaceId = `workspace-${sequence}`;
  row = { id: fileId, workspaceId, type: 'FILE', name: 'main.txt', content: 'abcdef' };
  vi.mocked(prisma.fileSystemItem.findUnique).mockImplementation((async () => ({ ...row })) as any);
  vi.mocked(prisma.fileSystemItem.update).mockImplementation((async ({ data }: any) => { Object.assign(row, data); return { ...row }; }) as any);
  vi.mocked(prisma.fileSystemItem.findMany).mockResolvedValue([]);
  vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({ role: 'EDITOR' } as any);
  vi.mocked(prisma.fileVersion.count).mockResolvedValue(0);
  vi.mocked(prisma.fileVersion.create).mockResolvedValue({} as any);
  server = createServer();
  io = initSocketServer(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  clients.splice(0).forEach(socket => socket.disconnect());
  forgetActiveFiles([fileId]);
  await new Promise<void>(resolve => io.close(() => resolve()));
});

describe('collaboration socket sessions', () => {
  it('allows viewers to chat and acknowledges only after the message is saved', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({ role: 'VIEWER' } as any);
    const a = await client();
    const joined = event(a, 'workspace_users');
    a.emit('join_workspace', { workspaceId });
    await joined;
    let finishSave!: () => void;
    const saving = new Promise<void>(resolve => { finishSave = resolve; });
    const savedMessage = { id: 'chat-1', workspaceId, message: 'A question', userId: 'viewer', createdAt: new Date() };
    vi.mocked(prisma.chatMessage.create).mockImplementation((async () => {
      await saving;
      return savedMessage;
    }) as any);
    const received = event(a, 'chat_message');
    const acknowledged = vi.fn();
    const response = new Promise(resolve => a.emit('chat_message', { workspaceId, message: ' A question ' }, (reply: unknown) => {
      acknowledged(reply);
      resolve(reply);
    }));
    await vi.waitFor(() => expect(prisma.chatMessage.create).toHaveBeenCalled());
    expect(acknowledged).not.toHaveBeenCalled();
    finishSave();
    expect(await response).toEqual({ success: true });
    expect(await received).toMatchObject({ id: 'chat-1', message: 'A question' });
    expect(prisma.chatMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ message: 'A question' }) }));
  });

  it('acknowledges chat permission failures without saving a message', async () => {
    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);
    const a = await client();
    const reply = await new Promise(resolve => a.emit('chat_message', { workspaceId, message: 'Hello' }, resolve));
    expect(reply).toMatchObject({ success: false, error: expect.any(String) });
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('acknowledges storage failures so the sender can retain their draft', async () => {
    vi.mocked(prisma.chatMessage.create).mockRejectedValue(new Error('Storage unavailable'));
    const a = await client();
    const received = vi.fn();
    a.on('chat_message', received);
    const reply = await new Promise(resolve => a.emit('chat_message', { workspaceId, message: 'Keep this draft' }, resolve));
    expect(reply).toEqual({ success: false, error: 'Request failed. Please try again.' });
    expect(received).not.toHaveBeenCalled();
  });

  it.each(['   ', 'x'.repeat(4001)])('rejects invalid chat content instead of silently discarding or truncating it', async message => {
    const a = await client();
    const reply = await new Promise(resolve => a.emit('chat_message', { workspaceId, message }, resolve));
    expect(reply).toMatchObject({ success: false, error: expect.any(String) });
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('still accepts chat messages from clients without acknowledgment callbacks', async () => {
    const a = await client();
    const joined = event(a, 'workspace_users');
    a.emit('join_workspace', { workspaceId });
    await joined;
    vi.mocked(prisma.chatMessage.create).mockResolvedValue({ id: 'legacy-chat', message: 'Hello' } as any);
    const received = event(a, 'chat_message');
    a.emit('chat_message', { workspaceId, message: 'Hello' });
    expect(await received).toMatchObject({ id: 'legacy-chat', message: 'Hello' });
  });

  it('initializes simultaneous joins only once', async () => {
    const a = await client();
    const b = await client();
    let release!: () => void;
    const loaded = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    vi.mocked(prisma.fileSystemItem.findUnique).mockImplementation((async (query: any) => {
      if (!query.select) { reads++; await loaded; }
      return { ...row };
    }) as any);
    const first = join(a);
    const second = join(b);
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
    expect(reads).toBe(1);
    release();
    const inits = await Promise.all([first, second]);
    expect(inits.map(value => value.fileId)).toEqual([fileId, fileId]);
    expect(inits.map(value => value.content)).toEqual(['abcdef', 'abcdef']);
  });

  it('keeps edits behind their pending join even while authorization and initialization await', async () => {
    const a = await client();
    let release!: () => void;
    const loaded = new Promise<void>(resolve => { release = resolve; });
    let reading = false;
    vi.mocked(prisma.fileSystemItem.findUnique).mockImplementation((async (query: any) => {
      if (!query.select) { reading = true; await loaded; }
      return { ...row };
    }) as any);
    const initial = join(a);
    const ack = edit(a, 0, 6, 6, 0, '!', 'queued-edit');
    await vi.waitFor(() => expect(reading).toBe(true));
    release();
    await initial;
    expect((await ack).content).toBe('abcdef!');
  });

  it('does not resurrect a deleted file when its initialization read finishes late', async () => {
    const a = await client();
    let release!: () => void;
    const loaded = new Promise<void>(resolve => { release = resolve; });
    let reading = false;
    vi.mocked(prisma.fileSystemItem.findUnique).mockImplementation((async (query: any) => {
      if (!query.select) { reading = true; await loaded; }
      return { ...row };
    }) as any);
    const denied = event(a, 'authz_error');
    a.emit('join_file', { fileId });
    await vi.waitFor(() => expect(reading).toBe(true));
    forgetActiveFiles([fileId]);
    release();
    expect(await denied).toMatchObject({ event: 'join_file', fileId, message: 'File not found' });
    expect(getActiveFileContent(fileId)).toBeUndefined();
  });

  it('does not let a slow cursor authorization block content edits', async () => {
    const userId = `cursor-user-${sequence}`;
    const a = await client(userId);
    await join(a);
    invalidateAuthz({ userId, workspaceId });
    let release!: () => void;
    const authorization = new Promise<void>(resolve => { release = resolve; });
    let reading = false;
    vi.mocked(prisma.workspaceMember.findUnique).mockImplementationOnce((async () => {
      reading = true;
      await authorization;
      return { role: 'EDITOR' };
    }) as any);
    a.emit('cursor_move', { fileId, cursor: { offset: 0 } });
    await vi.waitFor(() => expect(reading).toBe(true));
    try {
      expect((await edit(a, 0, 6, 6, 0, '!')).content).toBe('abcdef!');
    } finally {
      release();
    }
  });

  it('transforms concurrent overlapping deletion and insertion without deleting new text', async () => {
    const a = await client();
    const b = await client();
    await Promise.all([join(a), join(b)]);
    await edit(a, 0, 6, 1, 4, '');
    const ack = await edit(b, 0, 6, 3, 0, 'new');
    expect(ack.content).toBe('anewf');
    expect(ack.version).toBe(2);
    expect((await join(a)).content).toBe('anewf');
  });

  it('transforms unseen operations from another session of the same account', async () => {
    const a = await client('same-account');
    const b = await client('same-account');
    await Promise.all([join(a), join(b)]);
    await edit(a, 0, 6, 1, 0, 'X');
    expect((await edit(b, 0, 6, 3, 0, 'Y')).content).toBe('aXbcYdef');
  });

  it('rejects concurrent notebook cell additions that would produce invalid JSON', async () => {
    row.name = 'example.ipynb';
    row.content = '{"nbformat":4,"cells":[]}';
    const source = row.content as string;
    const offset = source.indexOf('[]') + 1;
    const firstCell = '{"cell_type":"code","source":["print(1)"]}';
    const secondCell = '{"cell_type":"code","source":["print(2)"]}';
    const a = await client();
    const b = await client();
    await Promise.all([join(a), join(b)]);
    const accepted = await edit(a, 0, source.length, offset, 0, firstCell);
    const response = event(b, 'file_resync');
    b.emit('edit_file', {
      fileId, baseVersion: 0, editId: 'second-cell',
      operation: operationFromSplices(source.length, [{ offset, length: 0, text: secondCell }]),
    });

    expect(await response).toMatchObject({ fileId, conflict: true, content: accepted.content, version: 1 });
    expect(JSON.parse(getActiveFileContent(fileId)!)).toMatchObject({ cells: [{ source: ['print(1)'] }] });
    const saved = event(a, 'file_saved');
    a.emit('save_file', { fileId });
    await saved;
    expect(row.content).toBe(accepted.content);
  });

  it('guards transformed notebook buffers even when they are sent at the current version', async () => {
    row.name = 'example.ipynb';
    row.content = '{"nbformat":4,"cells":[{"source":["first"]}]}';
    const source = row.content as string;
    const offset = source.lastIndexOf(']}');
    const a = await client();
    await join(a);
    const response = event(a, 'file_resync');
    a.emit('edit_file', {
      fileId, baseVersion: 0,
      operation: operationFromSplices(source.length, [{ offset, length: 0, text: '{"source":["second"]}' }]),
    });
    expect(await response).toMatchObject({ conflict: true, content: source, version: 0 });
  });

  it('accepts concurrent notebook source text edits that preserve its JSON structure', async () => {
    row.name = 'example.ipynb';
    row.content = '{"nbformat":4,"cells":[{"source":["hello"]}]}';
    const source = row.content as string;
    const a = await client();
    const b = await client();
    await Promise.all([join(a), join(b)]);
    await edit(a, 0, source.length, source.indexOf('hello'), 0, 'a');
    const accepted = await edit(b, 0, source.length, source.indexOf('hello') + 5, 0, 'b');
    expect(JSON.parse(accepted.content).cells[0].source).toEqual(['ahellob']);
  });

  it('applies notebook validation after an already-open file is renamed', async () => {
    row.content = '{"nbformat":4,"cells":[]}';
    const a = await client();
    await join(a);
    updateActiveFileName(fileId, 'renamed.ipynb');
    const response = event(a, 'file_resync');
    a.emit('edit_file', { fileId, baseVersion: 0, operation: [row.content.length, '!'] });
    expect(await response).toMatchObject({ conflict: true, content: row.content, version: 0 });
    updateActiveFileName(fileId, 'renamed.txt');
    expect((await edit(a, 0, row.content.length, row.content.length, 0, '!')).content).toBe(`${row.content}!`);
  });

  it('replays retained operations after reconnect and acknowledges a retry only once', async () => {
    const a = await client('reconnecting-account');
    await join(a);
    await edit(a, 0, 6, 6, 0, '!', 'stable-edit-id');
    a.disconnect();
    const reconnected = await client('reconnecting-account');
    const init = await join(reconnected, 0);
    expect(init.operations).toHaveLength(1);
    expect(init.operations[0].editId).toBe('stable-edit-id');
    const retry = await edit(reconnected, 0, 6, 6, 0, '!', 'stable-edit-id');
    expect(retry.version).toBe(1);
    expect(retry.content).toBe('abcdef!');
  });

  it('resynchronizes invalid versions instead of applying a wrongly based operation', async () => {
    const a = await client();
    await join(a);
    const response = event(a, 'file_resync');
    a.emit('edit_file', { fileId, baseVersion: 20, operation: [6, '!'] });
    expect(await response).toMatchObject({ fileId, version: 0, content: 'abcdef' });
  });

  it('reports saved only after the accepted content reaches persistence', async () => {
    const a = await client();
    await join(a);
    const saved = event(a, 'file_saved');
    await edit(a, 0, 6, 6, 0, '!');
    expect(await saved).toMatchObject({ fileId, version: 1 });
    expect(row.content).toBe('abcdef!');
  });

  it('retains edits after a persistence failure and supports an immediate save retry', async () => {
    const a = await client();
    await join(a);
    vi.mocked(prisma.fileSystemItem.update).mockRejectedValueOnce(new Error('Temporary storage failure'));
    const failure = event(a, 'file_save_error');
    await edit(a, 0, 6, 6, 0, '!');
    await failure;
    const state = await join(a);
    expect(state).toMatchObject({ content: 'abcdef!', version: 1, persistedVersion: 0 });
    const saved = event(a, 'file_saved');
    a.emit('save_file', { fileId });
    expect(await saved).toMatchObject({ version: 1 });
    expect(row.content).toBe('abcdef!');
  });

  it('serializes slow writes so an older save cannot overwrite newer text', async () => {
    const a = await client();
    const b = await client();
    await Promise.all([join(a), join(b)]);
    let finishFirst!: () => void;
    const firstWrite = new Promise<void>(resolve => { finishFirst = resolve; });
    vi.mocked(prisma.fileSystemItem.update).mockImplementationOnce((async ({ data }: any) => {
      await firstWrite;
      Object.assign(row, data);
      return { ...row };
    }) as any);
    await edit(a, 0, 6, 6, 0, '1');
    a.emit('save_file', { fileId });
    await vi.waitFor(() => expect(prisma.fileSystemItem.update).toHaveBeenCalledTimes(1));
    await edit(b, 1, 7, 7, 0, '2');
    b.emit('save_file', { fileId });
    const saved = new Promise<void>(resolve => {
      b.on('file_saved', value => { if (value.version === 2) resolve(); });
    });
    finishFirst();
    await saved;
    expect(row.content).toBe('abcdef12');
    expect(prisma.fileSystemItem.update).toHaveBeenCalledTimes(2);
  });

  it('broadcasts HTTP replacements through the active history and persists subsequent edits', async () => {
    const a = await client();
    await join(a);
    const replacement = event(a, 'file_edit');
    await replaceFileContent(fileId, workspaceId, 'restored', 'http-user');
    expect(await replacement).toMatchObject({ fileId, version: 1, socketId: 'http:http-user' });
    expect((await join(a)).content).toBe('restored');
    const saved = event(a, 'file_saved');
    await edit(a, 1, 8, 8, 0, '!');
    expect(await saved).toMatchObject({ version: 2 });
    expect(row.content).toBe('restored!');
  });

  it('initializes a joining editor from an HTTP replacement whose first save is still pending', async () => {
    const a = await client();
    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>(resolve => { finishWrite = resolve; });
    vi.mocked(prisma.fileSystemItem.update).mockImplementationOnce((async ({ data }: any) => {
      await pendingWrite;
      Object.assign(row, data);
      return { ...row };
    }) as any);

    const replacement = replaceFileContent(fileId, workspaceId, 'restored', 'http-user');
    try {
      await vi.waitFor(() => expect(prisma.fileSystemItem.update).toHaveBeenCalledTimes(1));
      expect(await join(a)).toMatchObject({ content: 'restored', version: 1, persistedVersion: 0 });
    } finally {
      finishWrite();
      await replacement;
    }

    await edit(a, 1, 8, 8, 0, '!');
    const saved = event(a, 'file_saved');
    a.emit('save_file', { fileId });
    expect(await saved).toMatchObject({ version: 2 });
    expect(row.content).toBe('restored!');
  });

  it('broadcasts and mirrors an HTTP replacement before any editor has joined the file', async () => {
    const a = await client();
    const users = event(a, 'workspace_users');
    a.emit('join_workspace', { workspaceId });
    await users;
    const changes: unknown[] = [];
    a.on('workspace_files_changed', change => changes.push(change));
    const runtimeRequest = vi.fn().mockResolvedValue({});
    vi.mocked(connectedRuntime).mockReturnValue({ request: runtimeRequest } as unknown as ReturnType<typeof connectedRuntime>);
    vi.mocked(prisma.fileSystemItem.findMany).mockResolvedValue([{ ...row }] as any);

    await replaceFileContent(fileId, workspaceId, 'restored', 'http-user');
    expect(connectedRuntime).toHaveBeenCalledWith(workspaceId);
    expect(runtimeRequest).toHaveBeenCalledWith('write-file', { path: row.name, content: 'restored' });
    await vi.waitFor(() => expect(changes).toEqual([{ workspaceId }]));
  });

  it('keeps a newer HTTP replacement in memory while an older eviction save finishes', async () => {
    const timers = vi.spyOn(global, 'setTimeout');
    let finishEviction!: () => void;
    let finishReplacement!: () => void;
    const evictionWrite = new Promise<void>(resolve => { finishEviction = resolve; });
    const replacementWrite = new Promise<void>(resolve => { finishReplacement = resolve; });
    let eviction: Promise<void> | undefined;
    let replacement: Promise<unknown> | undefined;
    try {
      await replaceFileContent(fileId, workspaceId, 'first', 'http-user');
      const evict = timers.mock.calls.find(([, delay]) => delay === 60_000)?.[0] as (() => Promise<void>) | undefined;
      expect(evict).toBeDefined();
      vi.mocked(prisma.fileSystemItem.update)
        .mockImplementationOnce((async ({ data }: any) => {
          await evictionWrite;
          Object.assign(row, data);
          return { ...row };
        }) as any)
        .mockImplementationOnce((async ({ data }: any) => {
          await replacementWrite;
          Object.assign(row, data);
          return { ...row };
        }) as any);

      eviction = evict!();
      await vi.waitFor(() => expect(prisma.fileSystemItem.update).toHaveBeenCalledTimes(2));
      replacement = replaceFileContent(fileId, workspaceId, 'second', 'http-user');
      finishEviction();
      await eviction;
      expect(getActiveFileContent(fileId)).toBe('second');
    } finally {
      finishEviction();
      finishReplacement();
      await Promise.all([eviction, replacement]);
      timers.mockRestore();
    }
    expect(row.content).toBe('second');
  });

  it('retries persistence when an HTTP replacement fails after its operation was accepted', async () => {
    const a = await client();
    await join(a);
    vi.mocked(prisma.fileSystemItem.update).mockRejectedValueOnce(new Error('Temporary storage failure'));
    const saved = event(a, 'file_saved');
    await expect(replaceFileContent(fileId, workspaceId, 'restored', 'http-user')).rejects.toThrow('Temporary storage failure');
    expect(getActiveFileContent(fileId)).toBe('restored');
    expect(await saved).toMatchObject({ fileId, version: 1 });
    expect(row.content).toBe('restored');
  });
});
