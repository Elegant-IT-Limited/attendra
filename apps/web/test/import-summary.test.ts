import { describe, expect, it } from 'vitest';
import { checkedLine, importedLine, rowsWord } from '../lib/import-summary';

// Note 2026-11-16 (demo findings 3, item 6): "Checked 1 rows". One row, two rows, in the pets and vets imports alike.
describe('the import result', () => {
  it('counts one row and many', () => {
    expect([0, 1, 2, 12].map(rowsWord)).toEqual(['0 rows', '1 row', '2 rows', '12 rows']);
  });
  it('says what the check found, and only speaks of rows left out when there are some', () => {
    expect(checkedLine(1, { add: 1, update: 0, skip: 0, error: 0 })).toBe('Checked 1 row: 1 new, 0 to update, 0 already on file, 0 with a problem.');
    expect(checkedLine(2, { add: 1, update: 0, skip: 0, error: 1 })).toBe('Checked 2 rows: 1 new, 0 to update, 0 already on file, 1 with a problem. The row with a problem is left out; fix it in the file and upload it again.');
    expect(checkedLine(5, { add: 2, update: 1, skip: 0, error: 2 })).toContain('Rows with a problem are left out; fix them in the file');
    expect(importedLine({ add: 3, update: 1, skip: 2, error: 0 })).toBe('Imported: 3 new, 1 updated, 2 already on file, 0 not imported.');
  });
});
