import { describe, expect, it } from 'vitest';
import { applyOperation, operationFromSplices, transformOperations } from '../../../../packages/text-ot/index.js';
import { documentOffsetToEditorOffset, editorOffsetToDocumentOffset, mapEditorChanges, normalizeEditorContent } from './EditorText';

describe('Monaco LF view over raw collaboration content', () => {
  it('normalizes CRLF, lone CR, and LF without changing UTF-16 text', () => {
    expect(normalizeEditorContent('one\r\ntwo\rthree\nfour😀')).toBe('one\ntwo\nthree\nfour😀');
  });

  it('hides and preserves an initial BOM while keeping interior BOM characters', () => {
    const raw = '\uFEFFa\r\nb\uFEFFc';
    expect(normalizeEditorContent(raw)).toBe('a\nb\uFEFFc');
    expect(editorOffsetToDocumentOffset(raw, 0)).toBe(1);
    expect(documentOffsetToEditorOffset(raw, 0)).toBe(0);
    expect(documentOffsetToEditorOffset(raw, 1)).toBe(0);
    expect(mapEditorChanges(raw, [{ offset: 0, length: 1, text: 'A' }], 'A\nb\uFEFFc').content).toBe('\uFEFFA\r\nb\uFEFFc');
    expect(mapEditorChanges('\uFEFF', [], '')).toEqual({ content: '\uFEFF', edits: [] });
  });

  it('maps cursor boundaries consistently, including a raw offset inside CRLF', () => {
    const raw = 'a\r\nb\rc\nd😀';
    const normalized = normalizeEditorContent(raw);
    for (let offset = 0; offset <= normalized.length; offset++) {
      const documentOffset = editorOffsetToDocumentOffset(raw, offset);
      expect(documentOffsetToEditorOffset(raw, documentOffset)).toBe(offset);
    }
    expect(editorOffsetToDocumentOffset(raw, 1)).toBe(1);
    expect(editorOffsetToDocumentOffset(raw, 2)).toBe(3);
    expect(documentOffsetToEditorOffset(raw, 2)).toBe(2);
    expect(documentOffsetToEditorOffset(raw, -1)).toBe(0);
    expect(documentOffsetToEditorOffset(raw, 100)).toBe(normalized.length);
    expect(editorOffsetToDocumentOffset(raw, 100)).toBe(raw.length);
  });

  it('appends to a mixed-EOL shared buffer without rewriting its existing endings', () => {
    const raw = 'first\r\nsecond\nthird\rfourth';
    const before = normalizeEditorContent(raw);
    const result = mapEditorChanges(raw, [{ offset: before.length, length: 0, text: '!' }], before + '!');
    expect(result.content).toBe(raw + '!');
    expect(result.edits).toEqual([{ offset: raw.length, length: 0, text: '!' }]);
  });

  it('maps multiple descending changes from the same original buffer', () => {
    const raw = 'a\r\nb\nc\rd😀';
    const result = mapEditorChanges(raw, [
      { offset: 7, length: 2, text: '🙂' },
      { offset: 4, length: 1, text: 'C\r\nnew' },
      { offset: 2, length: 1, text: 'B' },
    ], 'a\nB\nC\nnew\nd🙂');
    expect(result.content).toBe('a\r\nB\nC\nnew\rd🙂');
    expect(result.edits).toEqual([
      { offset: 3, length: 1, text: 'B' },
      { offset: 5, length: 1, text: 'C\nnew' },
      { offset: 8, length: 2, text: '🙂' },
    ]);
  });

  it('preserves a concurrent peer insertion between separate local edits', () => {
    const raw = 'a\r\nb\rc\n';
    const local = mapEditorChanges(raw, [
      { offset: 4, length: 1, text: 'C' },
      { offset: 0, length: 1, text: 'A' },
    ], 'A\nb\nC\n');
    const localOperation = operationFromSplices(raw.length, local.edits);
    const peerOperation = operationFromSplices(raw.length, [{ offset: 4, length: 0, text: 'peer' }]);
    const [peerAfterLocal, localAfterPeer] = transformOperations(peerOperation, localOperation);
    const merged = applyOperation(applyOperation(raw, peerOperation), localAfterPeer);
    expect(merged).toBe('A\r\nbpeer\rC\n');
    expect(applyOperation(local.content, peerAfterLocal)).toBe(merged);
  });

  it('deletes complete raw line endings when selection crosses displayed lines', () => {
    const result = mapEditorChanges('ab\r\ncd\ref', [{ offset: 1, length: 6, text: '' }], 'af');
    expect(result.content).toBe('af');
    expect(result.edits).toEqual([{ offset: 1, length: 7, text: '' }]);
  });

  it('keeps newline insertions on either side of a CRLF at the correct boundary', () => {
    expect(mapEditorChanges('a\r\nb', [{ offset: 1, length: 0, text: '\n' }], 'a\n\nb').content).toBe('a\n\r\nb');
    expect(mapEditorChanges('a\r\nb', [{ offset: 2, length: 0, text: '\n' }], 'a\n\nb').content).toBe('a\r\n\nb');
  });

  it('keeps two visible newlines when an insertion touches a lone CR', () => {
    const result = mapEditorChanges('a\rb', [{ offset: 2, length: 0, text: '\n' }], 'a\n\nb');
    expect(result.content).toBe('a\r\r\nb');
    expect(result.edits).toEqual([{ offset: 2, length: 0, text: '\r\n' }]);
  });

  it('does not combine retained CR and LF after deleting the text between them', () => {
    const result = mapEditorChanges('a\rX\nb', [{ offset: 2, length: 1, text: '' }], 'a\n\nb');
    expect(result.content).toBe('a\r\r\nb');
  });

  it('treats a controlled EOL-only value update as a no-op', () => {
    expect(mapEditorChanges('a\r\nb\rc', [{ offset: 0, length: 99, text: 'a\nb\nc' }], 'a\nb\nc')).toEqual({ content: 'a\r\nb\rc', edits: [] });
  });

  it('rejects stale values and overlapping edits rather than replacing unrelated text', () => {
    expect(() => mapEditorChanges('a\r\nb', [{ offset: 3, length: 0, text: '!' }], 'different')).toThrow('Editor changes do not match');
    expect(() => mapEditorChanges('a\r\nb', [{ offset: 4, length: 0, text: '!' }], 'a\nb!')).toThrow('Invalid or overlapping');
    expect(() => mapEditorChanges('abc', [{ offset: 0, length: 2, text: 'X' }, { offset: 1, length: 1, text: 'Y' }], 'XYc')).toThrow('Invalid or overlapping');
  });

  it('maps generated non-overlapping edits to the exact normalized output', () => {
    let seed = 741;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    const tokens = ['x', '\r', '\n', '\r\n', '😀'];
    for (let run = 0; run < 150; run++) {
      const raw = (run % 2 ? '\uFEFF' : '') + Array.from({ length: 12 }, () => tokens[random(tokens.length)]).join('');
      const normalized = normalizeEditorContent(raw);
      const first = random(Math.floor(normalized.length / 2) + 1);
      const second = Math.max(first + 1, Math.floor(normalized.length / 2) + 1);
      const edits = [
        { offset: first, length: Math.min(random(2), second - first), text: normalizeEditorContent(tokens[random(tokens.length)]!) },
        { offset: second, length: Math.min(random(3), normalized.length - second), text: '\nZ' },
      ];
      const expected = applyOperation(normalized, operationFromSplices(normalized.length, edits));
      let result;
      try { result = mapEditorChanges(raw, edits, expected); }
      catch (error) { throw new Error(JSON.stringify({ run, raw, edits, expected, error: String(error) })); }
      expect(normalizeEditorContent(result.content)).toBe(expected);
      expect(applyOperation(raw, operationFromSplices(raw.length, result.edits))).toBe(result.content);
    }
  });
});
