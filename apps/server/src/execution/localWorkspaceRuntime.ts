import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeFile, WorkspaceRuntime } from './workspaceRuntime.js';

const LAUNCHER = '/usr/local/bin/syncscript-sandbox';
const ROOTFS = '/opt/syncscript/rootfs';
const STATE = '/var/lib/syncscript/workspaces';
const FILE_HELPER = '/usr/local/lib/syncscript/safe-files.py';
const CLEAN_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MIN_UID = 200_000;
const MAX_UID = 2_000_000_000;
// Runs under the workspace UID, inside chroot, with Python -I. Atomic exchange
// retains the displaced inode until it is verified or named as a recovery copy.
export const LOCAL_MIRROR_SCRIPT = String.raw`
import ctypes, fcntl, hashlib, json, os, runpy, signal, stat, sys, uuid
safe = runpy.run_path('/usr/local/lib/syncscript/safe-files.py')
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
signal.signal(signal.SIGIO, lambda *_: None)
def rename(parent, source, target, flags):
    if renameat2(parent, os.fsencode(source), parent, os.fsencode(target), flags) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
def fingerprint(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        data = os.read(fd, 65536)
        if not data: return digest.hexdigest()
        digest.update(data)
def inode(metadata): return (metadata.st_dev, metadata.st_ino)
def update(root, item, expected):
    parts = safe['parts_for'](item['path'])
    parent = os.open(root, directory_flags)
    original = None
    temporary = None
    published = False
    try:
        for segment in parts[:-1]:
            try: os.mkdir(segment, 0o755, dir_fd=parent)
            except FileExistsError: pass
            child = os.open(segment, directory_flags, dir_fd=parent)
            os.close(parent)
            parent = child
        name = parts[-1]
        desired = item.get('content', '').encode('utf-8')
        try: original = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError: pass
        if original is not None:
            previous = os.fstat(original)
            if not stat.S_ISREG(previous.st_mode) or previous.st_nlink != 1:
                raise ValueError('Mirror destinations must be regular files without hard links')
            if fingerprint(original) == hashlib.sha256(desired).hexdigest(): return None
        temporary = '.syncscript-edit-' + uuid.uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        with os.fdopen(fd, 'wb') as output: output.write(desired)
        if original is None:
            rename(parent, temporary, name, 1)
            temporary = None
            return None
        rename(parent, temporary, name, 2)
        published = True
        displaced = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
        # Only discard an unchanged editor version, and only while the temp
        # name still identifies the inode opened before the exchange.
        if inode(displaced) == inode(previous) and fingerprint(original) == expected:
            leased = False
            try:
                # A write lease fails if another process still has this inode
                # open. Keep it as a recovery copy in that case, including
                # terminal writers that will append after this update returns.
                fcntl.fcntl(original, fcntl.F_SETLEASE, fcntl.F_WRLCK)
                leased = True
                if fingerprint(original) == expected and inode(os.stat(temporary, dir_fd=parent, follow_symlinks=False)) == inode(previous):
                    os.unlink(temporary, dir_fd=parent)
                    temporary = None
                    return None
            except OSError:
                pass
            finally:
                if leased: fcntl.fcntl(original, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        suffix = '.syncscript-backup-' + uuid.uuid4().hex
        maximum = os.fpathconf(parent, 'PC_NAME_MAX') - len(suffix)
        backup = os.fsdecode(os.fsencode(name)[:maximum].decode('utf-8', 'ignore')) + suffix
        rename(parent, temporary, backup, 1)
        temporary = None
        return '/'.join(parts[:-1] + [backup])
    except Exception:
        # Once exchanged, never delete the displaced original on a failure.
        # The recovery path remains discoverable even if publication completed.
        if published and temporary:
            sys.stderr.write('Previous file retained at ' + '/'.join(parts[:-1] + [temporary]) + '\n')
        raise
    finally:
        if original is not None: os.close(original)
        os.close(parent)
try:
    request = json.load(sys.stdin)
    backups = []
    count = 0
    for item in request['files']:
        if item['type'] == 'FOLDER': safe['apply']('/workspace', [item], True)
        else:
            backup = update('/workspace', item, request.get('expected', {}).get(item['path']))
            if backup:
                count += 1
                if len(backups) < 40: backups.append(backup)
    print(json.dumps({'ok': True, 'backups': backups, 'backupCount': count}))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}))
    sys.exit(1)
`;
type Identity = { root: string; uid: number; gid: number };
type Registry = { version: 1; workspaces: Record<string, number> };
type Pty = {
  pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void;
  onData(callback: (data: string) => void): unknown;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): unknown;
};
type PtySpawn = (command: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => Pty;
type Terminal = { id: string; pty?: Pty; closed: boolean; bytes: number; window: number; lifetime?: ReturnType<typeof setTimeout> };
type Job = { id: string; closed: boolean; bytes: number; temporary: string; snapshot?: string; process?: ChildProcessWithoutNullStreams; timer?: ReturnType<typeof setTimeout> };
type Stage = [command: string, args: string[]];
type RuntimeOptions = {
  loadPty?: () => Promise<PtySpawn>;
  usage?: () => Promise<{ rss: number; disk: number }>;
  idleMs?: number; monitorMs?: number; executionMs?: number; outputLimit?: number;
};

const localRuntimes = new Map<string, LocalWorkspaceRuntime>();
let allocationQueue: Promise<unknown> = Promise.resolve();

function validId(value: unknown, kind: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${kind}.`);
  return value;
}
function relativePath(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || !value || value.length > maximum) throw new Error('Invalid workspace file path.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || [...part].some(character => character.charCodeAt(0) < 32))) throw new Error('Invalid workspace file path.');
  return parts.join('/');
}
export function workspaceJailKey(workspaceId: string): string {
  validId(workspaceId, 'workspace ID');
  return createHash('sha256').update(`syncscript-workspace:${workspaceId}`).digest('hex');
}
export function allocateWorkspaceUid(registry: Registry, key: string): number {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid sandbox registry key.');
  if (registry.version !== 1 || !registry.workspaces || typeof registry.workspaces !== 'object' || Array.isArray(registry.workspaces)) throw new Error('Invalid sandbox identity registry.');
  const used = new Set<number>();
  for (const [name, uid] of Object.entries(registry.workspaces)) {
    if (!/^[a-f0-9]{64}$/.test(name) || !Number.isInteger(uid) || uid < MIN_UID || uid >= MAX_UID || used.has(uid)) {
      throw new Error('Sandbox identity registry contains invalid or duplicate identities.');
    }
    used.add(uid);
  }
  if (Object.hasOwn(registry.workspaces, key)) return registry.workspaces[key];
  let next = MIN_UID;
  for (const uid of used) next = Math.max(next, uid + 1);
  if (next >= MAX_UID) throw new Error('Sandbox identity space exhausted.');
  registry.workspaces[key] = next;
  return next;
}

async function trustedDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('Sandbox directories must be root-owned and not writable by other users.');
  }
}

function trustedCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: '/', env: CLEAN_ENV, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Sandbox setup or cleanup could not start.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Sandbox setup or cleanup failed.')));
  });
}

async function prepareIdentity(workspaceId: string): Promise<Identity> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('The local workspace sandbox requires Linux and its root-owned OS launcher.');
  }
  const launcher = await fs.lstat(LAUNCHER);
  if (!launcher.isFile() || launcher.isSymbolicLink() || launcher.uid !== 0 || (launcher.mode & 0o022) !== 0 || !(launcher.mode & 0o111)) {
    throw new Error('The OS sandbox launcher is missing or unsafe.');
  }
  await trustedDirectory(ROOTFS);
  await fs.mkdir(STATE, { recursive: true, mode: 0o700 });
  for (const directory of ['/var', '/var/lib', '/var/lib/syncscript', STATE]) await trustedDirectory(directory);
  const lock = path.join(STATE, '.allocation-lock');
  // Fail closed on another allocator or an interrupted allocation. A stale
  // lock can be reviewed by an operator; guessing could reuse a live UID.
  await fs.mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Sandbox identity allocation is already in progress or needs recovery.'); });
  try {
    const registryPath = path.join(STATE, 'identities.json');
    let registry: Registry = { version: 1, workspaces: {} };
    try {
      const stat = await fs.lstat(registryPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) throw new Error('Unsafe sandbox identity registry.');
      registry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Registry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const entry of await fs.readdir(STATE)) {
      if (/^[a-f0-9]{64}$/.test(entry) && !Object.hasOwn(registry.workspaces || {}, entry)) {
        throw new Error('A sandbox exists without a recorded identity. Restore the registry before allocating any UID.');
      }
    }
    const key = workspaceJailKey(workspaceId);
    const uid = allocateWorkspaceUid(registry, key);
    const pendingRegistry = path.join(STATE, `.identities-${randomUUID()}.json`);
    await fs.writeFile(pendingRegistry, JSON.stringify(registry), { mode: 0o600, flag: 'wx' });
    await fs.rename(pendingRegistry, registryPath);
    const root = path.join(STATE, key);
    let exists = false;
    try { await fs.lstat(root); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists) {
      // Only copy into a new root-owned staging directory. Never traverse an
      // existing user-controlled workspace tree from the privileged broker.
      const staging = path.join(STATE, `.jail-${randomUUID()}`);
      await fs.mkdir(staging, { mode: 0o755 });
      await trustedCommand('/bin/cp', ['-al', ROOTFS + '/.', staging]);
      for (const leaf of ['workspace', 'tmp']) {
        const directory = path.join(staging, leaf);
        await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const leafStat = await fs.lstat(directory);
        if (!leafStat.isDirectory() || leafStat.isSymbolicLink() || leafStat.uid !== 0) throw new Error('Unsafe sandbox writable directory template.');
        await fs.chown(directory, uid, uid);
        await fs.chmod(directory, 0o700);
      }
      await fs.rename(staging, root);
    }
    await trustedDirectory(root);
    for (const leaf of ['workspace', 'tmp']) {
      const stat = await fs.lstat(path.join(root, leaf));
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== uid || (stat.mode & 0o077) !== 0) {
        throw new Error('Sandbox writable directories do not match their workspace identity.');
      }
    }
    // Reap descendants left by a previous API process before reusing this UID.
    await trustedCommand(LAUNCHER, ['--kill-workspace', '--uid', String(uid), '--gid', String(uid)]);
    return { root, uid, gid: uid };
  } finally { await fs.rmdir(lock); }
}

export async function getLocalRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
  const current = localRuntimes.get(workspaceId);
  if (current?.connected) return current;
  const allocation = allocationQueue.catch(() => {}).then(async () => {
    const existing = localRuntimes.get(workspaceId);
    if (existing?.connected) return existing;
    if (existing) await existing.close();
    if (localRuntimes.size >= 16) throw new Error('The server already has sixteen active workspace sandboxes. Try again after an idle workspace closes.');
    const identity = await prepareIdentity(workspaceId);
    const runtime = new LocalWorkspaceRuntime(workspaceId, identity);
    localRuntimes.set(workspaceId, runtime);
    runtime.once('disconnected', () => {
      // Keep the retiring instance until native UID cleanup completes. A new
      // runtime must never start while an older cleanup can still kill its UID.
      void runtime.close().then(() => {
        if (localRuntimes.get(workspaceId) === runtime) localRuntimes.delete(workspaceId);
      }).catch(() => { console.error('Workspace sandbox cleanup failed; this identity will not be reused.'); });
    });
    return runtime;
  });
  allocationQueue = allocation;
  return allocation;
}

export async function closeAllLocalRuntimes(): Promise<void> {
  await Promise.all([...localRuntimes.values()].map(runtime => runtime.close()));
}

export class LocalWorkspaceRuntime extends EventEmitter implements WorkspaceRuntime {
  private alive = true;
  private readonly terminals = new Map<string, Terminal>();
  private readonly jobs = new Map<string, Job>();
  private readonly closedTerminals = new Set<string>();
  private readonly closedExecutions = new Set<string>();
  private fileQueue: Promise<unknown> = Promise.resolve();
  private readonly editorHashes = new Map<string, string>();
  private readonly notices: string[] = [];
  private pending = 0;
  private used = false;
  private idle?: ReturnType<typeof setTimeout>;
  private readonly monitor: ReturnType<typeof setInterval>;
  private checking = false;
  private closing?: Promise<void>;

  constructor(readonly workspaceId: string, private readonly identity: Identity, private readonly options: RuntimeOptions = {}) {
    super();
    if (!Number.isInteger(identity.uid) || identity.uid < MIN_UID || identity.gid !== identity.uid || !path.isAbsolute(identity.root)) {
      throw new Error('Invalid local workspace sandbox identity.');
    }
    this.monitor = setInterval(() => { void this.checkUsage().catch(() => {}); }, options.monitorMs ?? 5_000);
    this.monitor.unref();
    this.scheduleIdle();
  }
  get connected(): boolean { return this.alive; }

  private launcherArgs(command: string, args: string[]): string[] {
    if (!command.startsWith('/')) throw new Error('Sandbox commands must use absolute paths.');
    return ['--root', this.identity.root, '--uid', String(this.identity.uid), '--gid', String(this.identity.gid), '--cwd', '/workspace', '--', command, ...args];
  }
  private launch(command: string, args: string[]): ChildProcessWithoutNullStreams {
    if (!this.alive) throw new Error('Workspace sandbox is closed.');
    return spawn(LAUNCHER, this.launcherArgs(command, args), { cwd: '/', env: CLEAN_ENV, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  }
  private async killGroup(pid?: number): Promise<void> {
    if (!pid) return;
    await trustedCommand(LAUNCHER, ['--kill-workspace', '--uid', String(this.identity.uid), '--gid', String(this.identity.gid), '--process-group', String(pid)]).catch(() => {});
  }
  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > 8192) set.delete(set.values().next().value!);
  }
  private scheduleIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    if (!this.alive || this.pending || this.terminals.size || this.jobs.size) return;
    this.idle = setTimeout(() => { void this.close().catch(() => {}); }, this.options.idleMs ?? (this.used ? 0 : 30_000));
    this.idle.unref();
  }

  async request(action: string, raw: object = {}): Promise<unknown> {
    if (!this.alive) throw new Error('Workspace sandbox is closed.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid runtime payload.');
    const payload = raw as Record<string, unknown>;
    this.pending++;
    if (this.idle) clearTimeout(this.idle);
    try {
      switch (action) {
        case 'sync': return await this.mirrorFiles(payload.files, true);
        case 'write-file': return await this.mirrorFiles([{ path: payload.path, type: 'FILE', content: payload.content }]);
        case 'terminal:spawn': return await this.spawnTerminal(payload);
        case 'terminal:data': {
          const entry = this.terminals.get(validId(payload.terminalId, 'terminal ID'));
          if (!entry?.pty || entry.closed) throw new Error('Terminal is not ready.');
          if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 64 * 1024) throw new Error('Terminal input exceeds 64 KiB.');
          entry.pty.write(payload.data);
          return {};
        }
        case 'terminal:resize': {
          const entry = this.terminals.get(validId(payload.terminalId, 'terminal ID'));
          if (!entry?.pty || entry.closed) throw new Error('Terminal is not ready.');
          entry.pty.resize(this.dimension(payload.cols, 80, 500), this.dimension(payload.rows, 24, 200));
          return {};
        }
        case 'terminal:close': this.closeTerminal(validId(payload.terminalId, 'terminal ID')); return {};
        case 'execution:start': return await this.startExecution(payload);
        case 'execution:stdin': {
          const job = this.jobs.get(validId(payload.executionId, 'execution ID'));
          if (!job?.process?.stdin.writable || job.closed) throw new Error('Execution is not accepting input.');
          if (typeof payload.data !== 'string' || Buffer.byteLength(payload.data) > 8192) throw new Error('Execution input exceeds 8 KiB.');
          job.process.stdin.write(payload.data);
          return {};
        }
        case 'execution:cancel': {
          const id = validId(payload.executionId, 'execution ID');
          this.remember(this.closedExecutions, id);
          const job = this.jobs.get(id);
          if (job) this.finishJob(job, 130);
          return {};
        }
        default: throw new Error('Unknown runtime action.');
      }
    } finally { this.pending--; this.scheduleIdle(); }
  }

  private dimension(value: unknown, fallback: number, maximum: number): number {
    return typeof value === 'number' && Number.isInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
  }
  private async tool(command: string, args: string[], input = '', timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.launch(command, args); } catch (error) { reject(error); return; }
      let output = '';
      let errorOutput = '';
      let finished = false;
      const done = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void this.killGroup(child.pid);
        if (error) reject(error); else resolve(output);
      };
      const timer = setTimeout(() => done(new Error('Sandbox helper timed out.')), timeoutMs);
      child.stdout.on('data', chunk => { if (output.length < 64 * 1024) output += chunk.toString().slice(0, 64 * 1024 - output.length); });
      child.stderr.on('data', chunk => { if (errorOutput.length < 2048) errorOutput += chunk.toString().slice(0, 2048 - errorOutput.length); });
      child.once('error', () => done(new Error('The OS sandbox launcher could not start.')));
      child.once('close', code => done(code === 0 ? undefined : new Error(errorOutput || 'Sandbox helper failed.')));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  private validateFiles(raw: unknown): RuntimeFile[] {
    if (!Array.isArray(raw) || raw.length > 5000) throw new Error('Invalid workspace file list.');
    let bytes = 0;
    const files = raw.map((item: Partial<RuntimeFile>) => {
      if (!item || !['FILE', 'FOLDER'].includes(item.type || '') || typeof item.path !== 'string') throw new Error('Invalid workspace file.');
      const filePath = relativePath(item.path);
      if (item.type === 'FILE' && typeof item.content !== 'string') throw new Error('Invalid file content.');
      bytes += Buffer.byteLength(item.content || '');
      if (bytes > 20 * 1024 * 1024) throw new Error('Workspace synchronization exceeds 20 MiB.');
      return { path: filePath, type: item.type as RuntimeFile['type'], content: item.content || '' };
    });
    return files;
  }
  private mirrorFiles(raw: unknown, sync = false): Promise<unknown> {
    const files = this.validateFiles(raw);
    const work = this.fileQueue.catch(() => {}).then(async () => {
      const changed = files.filter(file => file.type === 'FOLDER' || !sync || this.editorHashes.get(file.path) !== createHash('sha256').update(file.content || '').digest('hex'));
      if (!changed.length) return { count: 0 };
      const expected = Object.fromEntries(changed.filter(file => file.type === 'FILE').map(file => [file.path, this.editorHashes.get(file.path) ?? null]));
      const output = await this.tool('/usr/bin/python3', ['-I', '-c', LOCAL_MIRROR_SCRIPT], JSON.stringify({ files: changed, expected }));
      const reply = JSON.parse(output) as { ok?: boolean; backups?: unknown; backupCount?: number };
      if (!reply.ok) throw new Error('Workspace file synchronization failed.');
      for (const file of changed) if (file.type === 'FILE') this.editorHashes.set(file.path, createHash('sha256').update(file.content || '').digest('hex'));
      if (Array.isArray(reply.backups)) for (const backup of reply.backups) {
        if (typeof backup === 'string' && this.notices.length < 40) this.notices.push(`\r\n[Preserved terminal changes at /workspace/${relativePath(backup, 2048)} before updating the editor file.]\r\n`);
      }
      if ((reply.backupCount || 0) > 40) this.notices.push(`\r\n[Preserved ${reply.backupCount} files. Recovery copies use the .syncscript-backup- suffix.]\r\n`);
      this.flushNotices();
      return { count: changed.length };
    });
    this.fileQueue = work;
    return work;
  }
  private flushNotices(): void {
    const terminals = [...this.terminals.values()].filter(entry => entry.pty && !entry.closed);
    if (!terminals.length) return;
    for (const data of this.notices.splice(0)) for (const terminal of terminals) this.emit('terminal-output', { terminalId: terminal.id, data });
  }
  private writeFiles(raw: unknown, preserveExisting = false, root = '/workspace'): Promise<unknown> {
    const files = this.validateFiles(raw);
    const work = this.fileQueue.catch(() => {}).then(async () => {
      const result = await this.tool('/usr/bin/python3', ['-I', FILE_HELPER, root], JSON.stringify({ files, preserveExisting }));
      let reply: { ok?: boolean };
      try { reply = JSON.parse(result) as { ok?: boolean }; } catch { throw new Error('Sandbox file helper returned an invalid response.'); }
      if (!reply.ok) throw new Error('Sandbox file update failed.');
      return { count: files.length };
    });
    this.fileQueue = work;
    return work;
  }

  private async spawnTerminal(payload: Record<string, unknown>): Promise<{ terminalId: string }> {
    const id = validId(payload.terminalId, 'terminal ID');
    if (this.closedTerminals.has(id)) throw new Error('Terminal has been closed.');
    if (this.terminals.has(id)) throw new Error('Terminal is already open or starting.');
    if (this.terminals.size >= 8) throw new Error('This workspace already has eight terminals.');
    const entry: Terminal = { id, closed: false, bytes: 0, window: Date.now() };
    this.used = true;
    this.terminals.set(id, entry);
    try {
      const spawnPty = await (this.options.loadPty ? this.options.loadPty() : import('node-pty').then(module => module.spawn as PtySpawn));
      if (entry.closed || !this.alive) throw new Error('Terminal closed while starting.');
      entry.pty = spawnPty(LAUNCHER, this.launcherArgs('/bin/bash', ['--noprofile', '--norc', '-i']), {
        name: 'xterm-256color', cols: this.dimension(payload.cols, 80, 500), rows: this.dimension(payload.rows, 24, 200), cwd: '/', env: CLEAN_ENV,
      });
      entry.pty.onData(data => {
        if (entry.closed) return;
        if (Date.now() - entry.window >= 1000) { entry.window = Date.now(); entry.bytes = 0; }
        entry.bytes += Buffer.byteLength(data);
        if (entry.bytes > 1024 * 1024) { this.closeTerminal(id, 1); return; }
        this.emit('terminal-output', { terminalId: id, data });
      });
      entry.pty.onExit(({ exitCode, signal }) => this.closeTerminal(id, exitCode, signal));
      this.flushNotices();
      entry.lifetime = setTimeout(() => this.closeTerminal(id, 124), 60 * 60 * 1000);
      entry.lifetime.unref();
      return { terminalId: id };
    } catch (error) { this.closeTerminal(id, 1); throw error; }
  }
  private closeTerminal(id: string, exitCode = 130, signal?: number): void {
    this.remember(this.closedTerminals, id);
    const entry = this.terminals.get(id);
    if (!entry || entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.lifetime);
    this.terminals.delete(id);
    void this.killGroup(entry.pty?.pid);
    this.emit('terminal-exit', { terminalId: id, exitCode, signal });
    this.scheduleIdle();
  }

  private async startExecution(payload: Record<string, unknown>): Promise<{ executionId: string }> {
    const id = validId(payload.executionId, 'execution ID');
    if (this.closedExecutions.has(id)) throw new Error('Execution has been cancelled or completed.');
    if (this.jobs.has(id)) throw new Error('Execution is already active.');
    if (this.jobs.size >= 4) throw new Error('This workspace already has four executions.');
    const extensions: Record<string, string> = { python: 'py', javascript: 'js', typescript: 'ts', c: 'c', cpp: 'cpp', java: 'java' };
    const language = typeof payload.language === 'string' ? payload.language : '';
    if (!Object.hasOwn(extensions, language)) throw new Error('Unsupported execution language.');
    if (typeof payload.code !== 'string' || Buffer.byteLength(payload.code) > 256 * 1024) throw new Error('Source exceeds 256 KiB.');
    const temporaryName = `run-${randomUUID()}`;
    const job: Job = { id, temporary: `/tmp/${temporaryName}`, closed: false, bytes: 0 };
    this.used = true;
    this.jobs.set(id, job);
    job.timer = setTimeout(() => this.finishJob(job, 124), this.options.executionMs ?? 20_000);
    try {
      const requested = payload.path === undefined ? (language === 'java' ? 'Main.java' : `main.${extensions[language]}`) : relativePath(payload.path);
      const directory = path.posix.dirname(requested);
      const sourceDirectory = directory === '.' ? '' : directory + '/';
      const snapshotName = `.syncscript-${randomUUID()}`;
      const snapshotPath = sourceDirectory + (language === 'java' ? `${snapshotName}/${path.posix.basename(requested)}` : `${snapshotName}.${extensions[language]}`);
      job.snapshot = '/workspace/' + (language === 'java' ? sourceDirectory + snapshotName : snapshotPath);
      await this.writeFiles([{ path: temporaryName, type: 'FOLDER' }], false, '/tmp');
      if (job.closed || !this.alive) throw new Error('Execution cancelled while preparing files.');
      // Execute the submitted editor snapshot beside its source so relative
      // imports/includes still work. Never overwrite terminal-only file edits.
      await this.writeFiles([{ path: snapshotPath, type: 'FILE', content: payload.code }]);
      if (job.closed || !this.alive) throw new Error('Execution cancelled while preparing files.');
      const source = '/workspace/' + snapshotPath;
      const binary = `${job.temporary}/program`;
      const stages: Record<string, Stage[]> = {
        python: [['/usr/bin/python3', [source]]],
        javascript: [['/usr/local/bin/node', [source]]],
        typescript: [['/usr/local/bin/tsx', [source]]],
        c: [['/usr/bin/gcc', [source, '-o', binary]], [binary, []]],
        cpp: [['/usr/bin/g++', [source, '-o', binary]], [binary, []]],
        java: [['/usr/bin/javac', ['-J-Xmx256m', '-sourcepath', '/workspace/' + sourceDirectory, '-d', job.temporary, source]], ['/usr/bin/java', ['-Xmx256m', '-cp', job.temporary, path.posix.basename(source, '.java')]]],
      };
      await this.launchStage(job, stages[language], 0);
      return { executionId: id };
    } catch (error) {
      const alreadyClosed = job.closed;
      this.finishJob(job, 1);
      if (alreadyClosed) this.cleanupJobFiles(job);
      throw error;
    }
  }
  private launchStage(job: Job, stages: Stage[], index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (job.closed || !this.alive) { reject(new Error('Execution is closed.')); return; }
      let child: ChildProcessWithoutNullStreams;
      try { child = this.launch(...stages[index]); } catch (error) { reject(error); return; }
      job.process = child;
      child.once('spawn', resolve);
      child.once('error', () => { this.finishJob(job, 1); reject(new Error('The OS sandbox launcher could not start.')); });
      child.stdin.on('error', () => {});
      for (const channel of ['stdout', 'stderr'] as const) child[channel].on('data', (chunk: Buffer) => {
        if (job.closed) return;
        const remaining = (this.options.outputLimit ?? 512 * 1024) - job.bytes;
        if (remaining > 0) {
          const data = chunk.subarray(0, remaining);
          job.bytes += data.length;
          this.emit('execution-output', { executionId: job.id, channel, data: data.toString('utf8') });
        }
        if (chunk.length > remaining) this.finishJob(job, 1);
      });
      child.once('close', (code, signal) => {
        if (job.closed) return;
        void this.killGroup(child.pid);
        if (code === 0 && !signal && index + 1 < stages.length) {
          void this.launchStage(job, stages, index + 1).catch(() => this.finishJob(job, 1));
        } else this.finishJob(job, signal ? 1 : (code ?? 1));
      });
    });
  }
  private finishJob(job: Job, exitCode: number): void {
    if (job.closed) return;
    job.closed = true;
    this.remember(this.closedExecutions, job.id);
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    void this.killGroup(job.process?.pid);
    this.emit('execution-exit', { executionId: job.id, exitCode });
    this.cleanupJobFiles(job);
    this.scheduleIdle();
  }
  private cleanupJobFiles(job: Job): void {
    // Cleanup itself is unprivileged and chrooted; never fs.rm a user path
    // from the root broker, even for a directory originally created by it.
    if (this.alive) {
      this.pending++;
      const script = 'import os,shutil,sys\nfor p in sys.argv[1:]:\n try:\n  if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p)\n  else: os.unlink(p)\n except FileNotFoundError: pass';
      void this.tool('/usr/bin/python3', ['-I', '-c', script, job.temporary, ...(job.snapshot ? [job.snapshot] : [])])
        .catch(() => {}).finally(() => { this.pending--; this.scheduleIdle(); });
    }
    this.scheduleIdle();
  }

  private async readUsage(): Promise<{ rss: number; disk: number }> {
    let rss = 0;
    for (const item of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(item)) continue;
      try {
        const status = await fs.readFile(`/proc/${item}/status`, 'utf8');
        const uid = /^Uid:\s+(\d+)/m.exec(status);
        if (uid && Number(uid[1]) === this.identity.uid) rss += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024;
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    }
    // Files can disappear during normal editor saves and process cleanup.
    // Count through directory FDs without following symlinks; tolerate only
    // disappeared entries, while permission/accounting failures close the jail.
    const script = 'import json,os\nseen=set(); total=0\ndef failure(error):\n if not isinstance(error,FileNotFoundError): raise error\ndef count(info):\n global total\n key=(info.st_dev,info.st_ino)\n if key not in seen: seen.add(key); total+=info.st_blocks*512\nfor root in ("/workspace","/tmp"):\n for current,dirs,files,fd in os.fwalk(root,onerror=failure,follow_symlinks=False):\n  count(os.fstat(fd))\n  for name in dirs+files:\n   try: count(os.stat(name,dir_fd=fd,follow_symlinks=False))\n   except FileNotFoundError: pass\nprint(json.dumps({"bytes":total}))';
    const output = await this.tool('/usr/bin/python3', ['-I', '-c', script], '', 5000);
    const disk = (JSON.parse(output) as { bytes?: number }).bytes;
    if (typeof disk !== 'number' || !Number.isSafeInteger(disk) || disk < 0) throw new Error('Sandbox disk accounting failed.');
    return { rss, disk };
  }
  private async checkUsage(): Promise<void> {
    if (this.checking || !this.alive || (!this.terminals.size && !this.jobs.size)) return;
    this.checking = true;
    try {
      const usage = await (this.options.usage ? this.options.usage() : this.readUsage());
      if (usage.rss > 512 * 1024 * 1024 || usage.disk > 256 * 1024 * 1024) { this.emit('resource-limit', usage); await this.close(); }
    } catch (error) {
      if (this.alive) { this.emit('accounting-error', error instanceof Error ? error.message : 'Resource accounting failed.'); await this.close(); }
    }
    finally { this.checking = false; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.alive = false;
    clearInterval(this.monitor);
    clearTimeout(this.idle);
    for (const id of [...this.terminals.keys()]) this.closeTerminal(id);
    for (const job of [...this.jobs.values()]) this.finishJob(job, 130);
    this.closing = trustedCommand(LAUNCHER, ['--kill-workspace', '--uid', String(this.identity.uid), '--gid', String(this.identity.gid)]);
    this.emit('disconnected');
    return this.closing;
  }
}
