import { applyOperation, operationFromSplices, type TextEdit } from '../../../../packages/text-ot/index.js';

/** Monaco displays every CRLF or lone CR as one LF. Shared offsets stay raw. */
export function normalizeEditorContent(content: string): string {
  return (content.startsWith('\uFEFF') ? content.slice(1) : content).replace(/\r\n?/g, '\n');
}

function countBefore(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function offsetsFor(content: string) {
  const start = content.startsWith('\uFEFF') ? 1 : 0;
  const documentBreaks: number[] = [];
  const editorBreaks: number[] = [];
  for (let index = start; index < content.length; index++) {
    if (content[index] === '\r' && content[index + 1] === '\n') {
      editorBreaks.push(index - start - documentBreaks.length);
      documentBreaks.push(index + 1);
      index++;
    }
  }
  return { start, documentBreaks, editorBreaks, editorLength: content.length - start - documentBreaks.length };
}

function clampOffset(offset: number, length: number): number {
  return Math.max(0, Math.min(length, Number.isFinite(offset) ? Math.floor(offset) : 0));
}

export function editorOffsetToDocumentOffset(content: string, offset: number): number {
  const { start, editorBreaks, editorLength } = offsetsFor(content);
  const clamped = clampOffset(offset, editorLength);
  return start + clamped + countBefore(editorBreaks, clamped);
}

/** An offset inside CRLF lands after the displayed newline, as its CR prefix does. */
export function documentOffsetToEditorOffset(content: string, offset: number): number {
  const { start, documentBreaks } = offsetsFor(content);
  const clamped = clampOffset(offset, content.length);
  return Math.max(start, clamped) - start - countBefore(documentBreaks, clamped);
}

/**
 * Translate one Monaco event from its LF view into edits of the original shared
 * buffer. All changes use the same original coordinates, including multicursor
 * changes. Untouched raw line endings and an initial BOM are retained.
 */
export function mapEditorChanges(content: string, changes: TextEdit[], nextEditorValue: string): { content: string; edits: TextEdit[] } {
  const editorContent = normalizeEditorContent(content);
  const nextContent = normalizeEditorContent(nextEditorValue);
  // Controlled value updates and EOL normalization are not user edits.
  if (editorContent === nextContent) return { content, edits: [] };

  const normalizedEdits = changes.map(change => ({ ...change, text: change.text.replace(/\r\n?/g, '\n') }));
  const editorOperation = operationFromSplices(editorContent.length, normalizedEdits);
  if (normalizeEditorContent(applyOperation(editorContent, editorOperation)) !== nextContent) {
    throw new Error('Editor changes do not match the current document');
  }

  const { start, editorBreaks } = offsetsFor(content);
  const toDocumentOffset = (offset: number) => start + offset + countBefore(editorBreaks, offset);
  const edits = normalizedEdits.map(change => {
    const start = toDocumentOffset(change.offset);
    const end = toDocumentOffset(change.offset + change.length);
    return { offset: start, length: end - start, text: change.text };
  }).sort((left, right) => left.offset - right.offset);

  // A splice can put a retained lone CR next to LF and accidentally turn two
  // displayed newlines into one CRLF. A boundary CR keeps both newlines without
  // rewriting retained characters; other newly inserted line endings use LF.
  const boundaryEdits: TextEdit[] = [];
  let endsWithCR = false;
  const append = (text: string, offset: number, edit?: TextEdit) => {
    if (!text) return;
    if (endsWithCR && text.startsWith('\n')) {
      if (edit) edit.text = '\r' + edit.text;
      else boundaryEdits.push({ offset, length: 0, text: '\r' });
    }
    endsWithCR = text.endsWith('\r');
  };
  let cursor = 0;
  for (const edit of edits) {
    append(content.slice(cursor, edit.offset), cursor);
    append(edit.text, edit.offset, edit);
    cursor = edit.offset + edit.length;
  }
  append(content.slice(cursor), cursor);
  edits.push(...boundaryEdits);

  const result = applyOperation(content, operationFromSplices(content.length, edits));
  if (normalizeEditorContent(result) !== nextContent) {
    throw new Error('Mapped editor changes do not match the editor value');
  }
  return { content: result, edits };
}
