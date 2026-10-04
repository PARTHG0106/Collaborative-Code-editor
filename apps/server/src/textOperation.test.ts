import { describe, expect, it } from 'vitest';
import { applyOperation, operationFromSplices, transformOperations, type TextEdit } from '../../../packages/text-ot/index.js';

describe('collaborative text operations', () => {
  it('converges for every pair of insert, delete and replacement ranges in a short document', () => {
    const original = 'abcd';
    const edits: TextEdit[] = [];
    for (let offset = 0; offset <= original.length; offset++) {
      for (let length = 0; length <= original.length - offset; length++) {
        for (const text of ['', 'X', 'YZ']) edits.push({ offset, length, text });
      }
    }
    for (const left of edits) for (const right of edits) {
      const a = operationFromSplices(original.length, [left]);
      const b = operationFromSplices(original.length, [right]);
      const [aPrime, bPrime] = transformOperations(a, b);
      expect(applyOperation(applyOperation(original, a), bPrime), JSON.stringify({ left, right }))
        .toBe(applyOperation(applyOperation(original, b), aPrime));
    }
  });

  it('preserves an insertion inside a concurrently deleted selection', () => {
    const remove = operationFromSplices(6, [{ offset: 1, length: 4, text: '' }]);
    const insert = operationFromSplices(6, [{ offset: 3, length: 0, text: 'new' }]);
    const [removePrime, insertPrime] = transformOperations(remove, insert);
    expect(applyOperation(applyOperation('abcdef', insert), removePrime)).toBe('anewf');
    expect(applyOperation(applyOperation('abcdef', remove), insertPrime)).toBe('anewf');
  });

  it('handles multiple Monaco changes in original document coordinates', () => {
    const operation = operationFromSplices(8, [
      { offset: 6, length: 2, text: 'Z' },
      { offset: 1, length: 2, text: 'XY' },
    ]);
    expect(applyOperation('abcdefgh', operation)).toBe('aXYdefZ');
  });

  it('uses UTF-16 offsets for emoji and multiline content', () => {
    const source = 'a😀\nb';
    expect(applyOperation(source, operationFromSplices(source.length, [{ offset: 3, length: 1, text: '\nnew\n' }]))).toBe('a😀\nnew\nb');
  });

  it('rejects invalid operations instead of silently clamping away edits', () => {
    expect(() => applyOperation('text', [3])).toThrow();
    expect(() => applyOperation('text', [Number.NaN])).toThrow();
    expect(() => transformOperations([4], [3])).toThrow();
    expect(() => operationFromSplices(4, [{ offset: 2, length: 3, text: '' }])).toThrow();
  });
});
