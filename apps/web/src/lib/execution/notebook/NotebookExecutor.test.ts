import { describe, expect, it } from 'vitest';
import { parseNotebook, serializeNotebook } from './NotebookExecutor';

describe('notebook cell identity during collaboration', () => {
  it('keeps cell identities across incoming updates and a save/reopen', () => {
    const content = JSON.stringify({ cells: [
      { id: 'shared-cell', cell_type: 'code', source: ['print(1)'], outputs: [] },
      { cell_type: 'markdown', source: ['Notes'] },
    ] });
    const cells = parseNotebook(content);
    const edited = cells.map(cell => ({ ...cell, source: cell.source + '\n' }));
    expect(parseNotebook(content).map(cell => cell.id)).toEqual(cells.map(cell => cell.id));
    expect(parseNotebook(serializeNotebook(edited)).map(cell => cell.id)).toEqual(cells.map(cell => cell.id));
    expect(cells[0]!.id).toBe('shared-cell');
  });
});
