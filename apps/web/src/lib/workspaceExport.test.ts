import { afterEach, describe, expect, it, vi } from 'vitest';
import { Unzip, unzipSync, strFromU8 } from 'fflate';
import type { FileSystemItem } from '../components/ide/hooks/useFileSystem';
import { createFileDownload, createWorkspaceArchive, downloadBlob, MAX_EXPORT_BYTES, MAX_EXPORT_ITEMS, workspaceArchiveName } from './workspaceExport';

function file(id: string, name: string, content = '', parentId: string | null = null, type: FileSystemItem['type'] = 'FILE'): FileSystemItem {
  return { id, name, content, parentId, type, workspaceId: 'workspace', createdAt: '', updatedAt: '' };
}

function bytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('workspace downloads', () => {
  it('extracts nested Unicode files, empty folders, dotfiles, and a literal __proto__ filename', async () => {
    const archive = await createWorkspaceArchive([
      file('code', 'こんにちは.py', 'print("Hello 🌍")\r\n', 'nested'),
      file('empty', 'empty', '', 'nested', 'FOLDER'),
      file('nested', '日本語', '', 'src', 'FOLDER'),
      file('src', 'src', '', null, 'FOLDER'),
      file('env', '.env', 'NAME=value\n'),
      file('ignore', '.gitignore', 'node_modules/\n'),
      file('proto', '__proto__', 'a regular file'),
    ]);
    expect(archive.type).toBe('application/zip');
    // The object returned by unzipSync cannot represent __proto__ as an own
    // property, so use the streaming reader to inspect every actual ZIP entry.
    const extracted = new Map<string, Uint8Array>();
    const reader = new Unzip(entry => {
      const data: number[] = [];
      entry.ondata = (error, chunk, final) => {
        if (error) throw error;
        data.push(...chunk);
        if (final) extracted.set(entry.name, new Uint8Array(data));
      };
      entry.start();
    });
    reader.push(await bytes(archive), true);
    expect([...extracted.keys()].sort()).toEqual(['.env', '.gitignore', '__proto__', 'src/', 'src/日本語/', 'src/日本語/empty/', 'src/日本語/こんにちは.py'].sort());
    expect(strFromU8(extracted.get('src/日本語/こんにちは.py')!)).toBe('print("Hello 🌍")\r\n');
    expect(strFromU8(extracted.get('.env')!)).toBe('NAME=value\n');
    expect(strFromU8(extracted.get('__proto__')!)).toBe('a regular file');
    expect(extracted.get('src/日本語/empty/')).toHaveLength(0);
  });

  it('uses a snapshot of unsaved editor contents, including an intentionally empty buffer', async () => {
    const source = [file('a', 'app.ts', 'saved'), file('b', 'empty.txt', 'old')];
    const overrides = new Map([['a', 'unsaved'], ['b', '']]);
    const pending = createWorkspaceArchive(source, { contentOverrides: overrides });
    overrides.set('a', 'later edit');
    const extracted = unzipSync(await bytes(await pending));
    expect(strFromU8(extracted['app.ts']!)).toBe('unsaved');
    expect(extracted['empty.txt']).toHaveLength(0);
    expect(source[0]!.content).toBe('saved');
  });

  it('restores binary upload bytes in both ZIPs and individual downloads', async () => {
    const binary = file('image', 'picture.png', 'data:image/png;base64,AAECA/7/');
    const expected = [0, 1, 2, 3, 254, 255];
    const extracted = unzipSync(await bytes(await createWorkspaceArchive([binary])));
    expect([...extracted['picture.png']!]).toEqual(expected);
    const download = createFileDownload(binary);
    expect(download.type).toBe('application/octet-stream');
    expect([...await bytes(download)]).toEqual(expected);
  });

  it.each(['sample.txt', 'sample.ts', 'sample.ipynb', '.env', '.env.local', '.gitignore', 'Dockerfile'])('keeps literal data URLs in text file %s unchanged', async name => {
    const content = 'data:image/png;base64,AAECA/7/';
    expect(strFromU8(await bytes(createFileDownload(file('text', name, content))))).toBe(content);
  });

  it('preserves text MIME data URLs in files without a recognized extension', async () => {
    const content = 'data:text/plain;base64,SGVsbG8=';
    expect(strFromU8(await bytes(createFileDownload(file('text', 'notes', content))))).toBe(content);
  });

  it.each(['config.custom', 'notes', 'png'])('preserves a literal binary data URL in unknown or extensionless file %s', async name => {
    const content = 'data:image/png;base64,AAECA/7/';
    const source = file('unknown', name, content);
    expect(strFromU8(await bytes(createFileDownload(source)))).toBe(content);
    const extracted = unzipSync(await bytes(await createWorkspaceArchive([source])));
    expect(strFromU8(extracted[name]!)).toBe(content);
  });

  it('preserves a data URL when its MIME does not match a recognized binary extension', async () => {
    const content = 'data:application/pdf;base64,AAECA/7/';
    const source = file('mismatch', 'picture.png', content);
    expect(strFromU8(await bytes(createFileDownload(source)))).toBe(content);
    const extracted = unzipSync(await bytes(await createWorkspaceArchive([source])));
    expect(strFromU8(extracted['picture.png']!)).toBe(content);
  });

  it.each([
    ['document.pdf', 'application/pdf'],
    ['archive.zip', 'application/zip'],
    ['payload.bin', 'application/octet-stream'],
    ['image.PNG', 'application/octet-stream'],
  ])('restores recognized upload %s with compatible MIME %s', async (name, mime) => {
    const source = file('binary', name, `data:${mime};base64,AAECA/7/`);
    const expected = [0, 1, 2, 3, 254, 255];
    expect([...await bytes(createFileDownload(source))]).toEqual(expected);
    const extracted = unzipSync(await bytes(await createWorkspaceArchive([source])));
    expect([...extracted[name]!]).toEqual(expected);
  });

  it('preserves SVG upload bytes and serves downloads without an executable MIME type', async () => {
    const source = '<svg><text>hello</text></svg>';
    const download = createFileDownload(file('svg', 'icon.svg', `data:image/svg+xml;base64,${btoa(source)}`));
    expect(strFromU8(await bytes(download))).toBe(source);
    expect(download.type).toBe('application/octet-stream');
  });

  it.each(['AA=A', '!', 'AAA', 'A==='])('rejects malformed binary base64 %s', async value => {
    const source = file('bad', 'bad.png', `data:image/png;base64,${value}`);
    expect(() => createFileDownload(source)).toThrow('invalid binary upload');
    await expect(createWorkspaceArchive([source])).rejects.toThrow('invalid binary upload');
  });

  it.each(['', '.', '..', '../outside', '/absolute', 'dir/file', 'dir\\file', 'C:drive', 'bad\u0000name', 'line\nname', 'trailing.', 'trailing ', 'CON', 'aux.txt'])('rejects unsafe filenames %j without changing them', async name => {
    const source = file('bad', name);
    await expect(createWorkspaceArchive([source])).rejects.toThrow('filename');
    expect(() => createFileDownload(source)).toThrow('filename');
  });

  it.each([
    [file('a', 'same.txt'), file('b', 'same.txt')],
    [file('a', 'README.md'), file('b', 'readme.md')],
    [file('a', 'café.txt'), file('b', 'cafe\u0301.txt')],
    [file('a', 'src', '', null, 'FOLDER'), file('b', 'src')],
  ])('rejects paths that would overwrite each other when extracted', async (...source) => {
    await expect(createWorkspaceArchive(source)).rejects.toThrow('overwrite each other');
  });

  it('allows identically named files in different directories', async () => {
    const extracted = unzipSync(await bytes(await createWorkspaceArchive([
      file('src', 'src', '', null, 'FOLDER'), file('test', 'test', '', null, 'FOLDER'),
      file('a', 'index.ts', 'source', 'src'), file('b', 'index.ts', 'test', 'test'),
    ])));
    expect(strFromU8(extracted['src/index.ts']!)).toBe('source');
    expect(strFromU8(extracted['test/index.ts']!)).toBe('test');
  });

  it('rejects duplicate IDs, missing parents, file parents, and cycles rather than silently dropping files', async () => {
    await expect(createWorkspaceArchive([file('a', 'a'), file('a', 'b')])).rejects.toThrow('identifiers');
    await expect(createWorkspaceArchive([file('a', 'a', '', 'missing')])).rejects.toThrow('parent folder');
    await expect(createWorkspaceArchive([file('a', 'a'), file('b', 'b', '', 'a')])).rejects.toThrow('parent folder');
    await expect(createWorkspaceArchive([file('a', 'a', '', 'b', 'FOLDER'), file('b', 'b', '', 'a', 'FOLDER')])).rejects.toThrow('cycle');
  });

  it('enforces download size and entry limits before allocating an archive', async () => {
    const hugeFile = file('large', 'large.txt', 'x'.repeat(MAX_EXPORT_BYTES + 1));
    expect(() => createFileDownload(hugeFile)).toThrow('50 MiB');
    await expect(createWorkspaceArchive([hugeFile])).rejects.toThrow('50 MiB');
    await expect(createWorkspaceArchive(Array.from({ length: MAX_EXPORT_ITEMS + 1 }, (_, index) => file(String(index), String(index))))).rejects.toThrow('5,000');
  });

  it('produces an empty but valid ZIP for an empty workspace', async () => {
    expect(unzipSync(await bytes(await createWorkspaceArchive([])))).toEqual({});
  });

  it('generates portable ZIP labels while retaining meaningful Unicode titles', () => {
    expect(workspaceArchiveName('  Team / project: one  ')).toBe('Team - project- one.zip');
    expect(workspaceArchiveName('日本語')).toBe('日本語.zip');
    expect(workspaceArchiveName('CON')).toBe('workspace.zip');
    expect(workspaceArchiveName('...')).toBe('workspace.zip');
    expect(new TextEncoder().encode(workspaceArchiveName('日'.repeat(100))).length).toBeLessThanOrEqual(255);
  });

  it('starts a browser save, removes the temporary link, and releases the object URL afterward', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('code.ts');
      expect(this.href).toBe('blob:download');
      expect(this.isConnected).toBe(true);
    });
    const blob = createFileDownload(file('code', 'code.ts', 'const x = 1;'));
    downloadBlob(blob, 'code.ts');
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download');
  });
});
