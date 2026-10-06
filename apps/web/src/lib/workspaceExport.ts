import type { FileSystemItem } from '../components/ide/hooks/useFileSystem';

export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
export const MAX_EXPORT_ITEMS = 5_000;

interface ArchiveOptions {
  /** A snapshot of editor buffers, keyed by file ID, including unsaved edits. */
  contentOverrides?: ReadonlyMap<string, string>;
}

const binaryMimeTypes = new Map<string, readonly string[]>([
  ['png', ['image/png']], ['jpg', ['image/jpeg']], ['jpeg', ['image/jpeg']],
  ['gif', ['image/gif']], ['webp', ['image/webp']], ['avif', ['image/avif']],
  ['bmp', ['image/bmp', 'image/x-ms-bmp']], ['ico', ['image/x-icon', 'image/vnd.microsoft.icon']],
  ['svg', ['image/svg+xml']], ['tif', ['image/tiff']], ['tiff', ['image/tiff']],
  ['heic', ['image/heic']], ['heif', ['image/heif']], ['pdf', ['application/pdf']],
  ['zip', ['application/zip', 'application/x-zip-compressed']],
  ['gz', ['application/gzip', 'application/x-gzip']],
  ['tgz', ['application/gzip', 'application/x-gzip', 'application/x-compressed-tar']],
  ['tar', ['application/x-tar']], ['7z', ['application/x-7z-compressed']],
  ['rar', ['application/vnd.rar', 'application/x-rar-compressed', 'application/x-rar']],
  ['bz2', ['application/x-bzip2']], ['xz', ['application/x-xz']], ['zst', ['application/zstd']],
  ['bin', []], ['wasm', ['application/wasm']],
  ['woff', ['font/woff', 'application/font-woff']], ['woff2', ['font/woff2']],
  ['ttf', ['font/ttf', 'application/x-font-ttf']], ['otf', ['font/otf', 'application/x-font-opentype']],
  ['mp3', ['audio/mpeg']], ['wav', ['audio/wav', 'audio/x-wav']], ['flac', ['audio/flac']],
  ['ogg', ['audio/ogg', 'video/ogg', 'application/ogg']], ['mp4', ['video/mp4', 'audio/mp4']],
  ['webm', ['video/webm', 'audio/webm']], ['mov', ['video/quicktime']],
]);
const encoder = new TextEncoder();

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function hasBrokenUnicode(value: string): boolean {
  return [...value].some(character => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff);
}

function validateName(name: string): void {
  // Keep names intact. A failed export is preferable to an extraction that
  // changes paths, escapes the target folder, or overwrites another file.
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name) || hasControlCharacter(name) || hasBrokenUnicode(name)
    || /[. ]$/.test(name) || /^\s+$/.test(name)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error(`“${name}” is not a safe download filename. Rename it before downloading.`);
  }
  if (encoder.encode(name).length > 255) {
    throw new Error(`“${name.slice(0, 60)}…” is too long to extract safely. Shorten its name before downloading.`);
  }
}

function sizeError(): Error {
  return new Error('Downloads support up to 50 MiB of file contents. Download individual files or a smaller workspace.');
}

function fileBytes(file: FileSystemItem, content: string, byteLimit: number): Uint8Array<ArrayBuffer> {
  const name = file.name.toLowerCase();
  const extensionStart = name.lastIndexOf('.');
  const compatibleMimes = extensionStart > 0 ? binaryMimeTypes.get(name.slice(extensionStart + 1)) : undefined;

  // Uploads use FileReader.readAsDataURL for non-text MIME types. There is no
  // encoding field in existing records. Decode only recognized binary names
  // with a matching MIME; keep source, text, and unknown names exactly as stored.
  const dataHeader = compatibleMimes ? /^data:([^;,]+)(?:;[^,;]*)*;base64,/i.exec(content) : null;
  const mime = dataHeader?.[1]?.toLowerCase();
  if (dataHeader && mime && compatibleMimes && (mime === 'application/octet-stream' || compatibleMimes.includes(mime))) {
    const encoded = content.slice(dataHeader[0].length);
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.length / 4 * 3 - padding > byteLimit) throw sizeError();
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error(`“${file.name}” contains an invalid binary upload. Upload it again before downloading.`);
    }
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    // Index directly: TypedArray.from(string) first expands its iterator into
    // a temporary character list, which can multiply memory use for uploads.
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  // UTF-8 takes at least as many bytes as UTF-16 code units. Check before
  // allocating, then check the encoded size to account for non-ASCII text.
  if (content.length > byteLimit) throw sizeError();
  const bytes = encoder.encode(content);
  if (bytes.length > byteLimit) throw sizeError();
  return bytes;
}

function archivePaths(files: readonly FileSystemItem[]): Map<string, string> {
  const byId = new Map<string, FileSystemItem>();
  for (const file of files) {
    if (!file.id || byId.has(file.id)) throw new Error('The file list contains duplicate or missing identifiers. Refresh the workspace and try again.');
    if (file.type !== 'FILE' && file.type !== 'FOLDER') throw new Error('The file list contains an unsupported item. Refresh the workspace and try again.');
    validateName(file.name);
    byId.set(file.id, file);
  }

  const paths = new Map<string, string>();
  for (const file of files) {
    const chain: FileSystemItem[] = [];
    const seen = new Set<string>();
    let current: FileSystemItem | undefined = file;
    while (current && !paths.has(current.id)) {
      if (seen.has(current.id)) throw new Error('The folder tree contains a cycle. Fix the folder structure before downloading.');
      seen.add(current.id);
      chain.push(current);
      if (current.parentId === null) break;
      const parent = byId.get(current.parentId);
      if (!parent || parent.type !== 'FOLDER' || parent.workspaceId !== current.workspaceId) {
        throw new Error(`The parent folder for “${current.name}” is missing or invalid. Refresh the workspace and try again.`);
      }
      current = parent;
    }
    let prefix = current && paths.get(current.id) || '';
    for (const entry of chain.reverse()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (encoder.encode(path).length > 4096) throw new Error('A folder path is too long to extract safely. Move its files into a shallower folder before downloading.');
      paths.set(entry.id, path);
      prefix = path;
    }
  }

  const used = new Map<string, string>();
  for (const path of paths.values()) {
    // Windows and macOS commonly extract onto case-insensitive filesystems.
    const key = path.normalize('NFC').toLowerCase();
    const duplicate = used.get(key);
    if (duplicate !== undefined) {
      throw new Error(`“${duplicate}” and “${path}” would overwrite each other when extracted on a case-insensitive system. Rename one before downloading a ZIP.`);
    }
    used.set(key, path);
  }
  return paths;
}

/** Builds an archive from this browser's workspace snapshot, including empty folders. */
export async function createWorkspaceArchive(files: readonly FileSystemItem[], options: ArchiveOptions = {}): Promise<Blob> {
  if (files.length > MAX_EXPORT_ITEMS) throw new Error('ZIP downloads support up to 5,000 files and folders. Download individual files or a smaller workspace.');
  const paths = archivePaths(files);
  const entries: Array<[string, Uint8Array]> = [];
  let total = 0;
  for (const file of files) {
    const path = paths.get(file.id)!;
    if (file.type === 'FOLDER') {
      entries.push([`${path}/`, new Uint8Array()]);
    } else {
      const content = options.contentOverrides?.get(file.id) ?? file.content ?? '';
      const bytes = fileBytes(file, content, MAX_EXPORT_BYTES - total);
      total += bytes.length;
      entries.push([path, bytes]);
    }
  }
  // Load ZIP support only when used. Stored ZIP avoids worker/CSP requirements
  // and expensive compression on the UI thread; memory is bounded above.
  const { Zip, ZipPassThrough } = await import('fflate');
  const chunks: BlobPart[] = [];
  const archive = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  // The streaming API preserves names like __proto__; object-based archive
  // helpers can mistake these filenames for inherited JavaScript properties.
  for (const [path, bytes] of entries) {
    const entry = new ZipPassThrough(path);
    archive.add(entry);
    entry.push(bytes, true);
  }
  archive.end();
  return new Blob(chunks, { type: 'application/zip' });
}

/** Download bytes are inert; the browser saves HTML/SVG instead of navigating to it. */
export function createFileDownload(file: FileSystemItem, contentOverride?: string): Blob {
  if (file.type !== 'FILE') throw new Error('Choose a file to download. Use Download ZIP for folders.');
  validateName(file.name);
  return new Blob([fileBytes(file, contentOverride ?? file.content ?? '', MAX_EXPORT_BYTES)], { type: 'application/octet-stream' });
}

/** Workspace titles are labels, so make only the generated outer ZIP name portable. */
export function workspaceArchiveName(workspaceName: string): string {
  const characters = [...workspaceName].map(character => /[<>:"/\\|?*]/.test(character) || hasControlCharacter(character) || hasBrokenUnicode(character) ? '-' : character);
  let name = '';
  for (const character of characters) {
    if (encoder.encode(name + character).length > 240) break;
    name += character;
  }
  name = name.trim().replace(/[. ]+$/, '');
  const safeName = !name || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? 'workspace' : name;
  return `${safeName}.zip`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  validateName(filename);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser consume the URL before releasing its retained data.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
