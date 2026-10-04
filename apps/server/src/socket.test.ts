import { describe, it, expect } from 'vitest';
import { transformEdit, clampEdit, type TextEdit } from './socket.js';

/**
 * Unit tests for the operational-transform primitives that back collaborative
 * editing. These are pure functions and were previously untested, despite being
 * the exact place a convergence bug would silently corrupt documents.
 */

const ins = (offset: number, text: string): TextEdit => ({ offset, text, length: 0 });
const del = (offset: number, length: number): TextEdit => ({ offset, text: '', length });

describe('clampEdit', () => {
  it('keeps an in-range edit unchanged', () => {
    expect(clampEdit(ins(3, 'hi'), 10)).toEqual({ offset: 3, length: 0, text: 'hi' });
  });

  it('clamps an offset past the end of the document', () => {
    expect(clampEdit(ins(99, 'x'), 5)).toEqual({ offset: 5, length: 0, text: 'x' });
  });

  it('clamps a delete length that would run past the end', () => {
    expect(clampEdit(del(3, 100), 5)).toEqual({ offset: 3, length: 2, text: '' });
  });

  it('floors negative offset and length to zero', () => {
    expect(clampEdit({ offset: -4, length: -2, text: 'a' }, 10)).toEqual({
      offset: 0,
      length: 0,
      text: 'a',
    });
  });

  it('coerces a non-string text payload to an empty string', () => {
    expect(clampEdit({ offset: 0, length: 0, text: undefined as any }, 10).text).toBe('');
  });
});

describe('transformEdit', () => {
  it('shifts an edit right when a prior insert lands before it', () => {
    // other inserts 3 chars at offset 0; an edit at offset 5 moves to 8.
    const result = transformEdit(ins(5, 'x'), ins(0, 'abc'), true);
    expect(result.offset).toBe(8);
  });

  it('does not shift an edit that lies before the other edit', () => {
    const result = transformEdit(ins(2, 'x'), ins(5, 'abc'), true);
    expect(result.offset).toBe(2);
  });

  it('breaks ties by priority: with priority the edit stays put', () => {
    // Concurrent inserts at the same offset. With priority, this edit is not
    // pushed right by the other.
    const result = transformEdit(ins(4, 'x'), ins(4, 'yy'), true);
    expect(result.offset).toBe(4);
  });

  it('breaks ties by priority: without priority the edit is pushed right', () => {
    const result = transformEdit(ins(4, 'x'), ins(4, 'yy'), false);
    expect(result.offset).toBe(6);
  });

  it('is order-consistent across peers for a same-offset insert pair', () => {
    // The two peers must agree: exactly one of the pair has priority, and the
    // transformed offsets must not collide in a way that diverges.
    const a = transformEdit(ins(4, 'A'), ins(4, 'B'), true);
    const b = transformEdit(ins(4, 'B'), ins(4, 'A'), false);
    // A keeps 4, B moves to 5 — distinct insertion points, deterministic order.
    expect(a.offset).toBe(4);
    expect(b.offset).toBe(5);
  });

  it('lands at the end of replacement text when a prior delete overlaps', () => {
    // other deletes [0,6); an edit at offset 3 falls inside the removed range
    // and is repositioned to the end of other.text (offset 0 + 0 = 0 here).
    const result = transformEdit(ins(3, 'x'), del(0, 6), false);
    expect(result.offset).toBe(0);
  });

  it('preserves the edit text and length fields', () => {
    const result = transformEdit(del(5, 2), ins(0, 'abc'), true);
    expect(result.text).toBe('');
    expect(result.length).toBe(2);
  });
});
