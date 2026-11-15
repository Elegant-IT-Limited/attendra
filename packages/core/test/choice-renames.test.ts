import { describe, expect, it } from 'vitest';
import { carriedRenames, type CustomField, withRenamedChoices } from '../src';

// Note 2026-11-16 F1: a test clinic renamed a dropdown choice; the pets saved with it kept the old name, their Details
// showed "Not filled in" and saving Details would have erased it. A rename now reaches every record.
const insurer: CustomField = { id: 'insurer', label: 'Pet insurance', kind: 'choice', options: ['Acme Pet Cover Plus', 'Northwind Pet Plan'] };
const extras: CustomField = { id: 'extras', label: 'Extras', kind: 'multi', options: ['Nail trim', 'Bath', 'Ear clean'] };
const note: CustomField = { id: 'note', label: 'Note', kind: 'text' };

describe('renamed dropdown choices on a record', () => {
  it('renames a choice, whatever its case, and leaves every other value as it is', () => {
    const renamed = { insurer: { 'Acme Pet Cover': 'Acme Pet Cover Plus' } };
    expect(withRenamedChoices([insurer, note], { insurer: 'acme pet cover', note: 'Acme Pet Cover' }, renamed)).toEqual({ insurer: 'Acme Pet Cover Plus', note: 'Acme Pet Cover' });
    expect(withRenamedChoices([insurer], { insurer: 'Northwind Pet Plan' }, renamed)).toBeNull();
    expect(withRenamedChoices([insurer], {}, renamed)).toBeNull();
  });

  it('renames each choice of a multi-choice value, in the order the clinic lists them', () => {
    const renamed = { extras: { Shampoo: 'Bath' } };
    expect(withRenamedChoices([extras], { extras: 'Nail trim | Shampoo' }, renamed)).toEqual({ extras: 'Nail trim | Bath' });
    expect(withRenamedChoices([extras], { extras: 'Shampoo | Ear clean' }, renamed)).toEqual({ extras: 'Bath | Ear clean' });
  });

  it('keeps a removed choice on the record, as before: removing is not renaming', () => {
    expect(withRenamedChoices([insurer], { insurer: 'Old Insurer' }, {})).toBeNull();
  });

  it('carries only renames to a choice the field still lists, as it lists it', () => {
    expect(carriedRenames([insurer, note], {
      insurer: { 'Acme Pet Cover': 'acme pet cover plus', Gone: 'Not listed', 'Northwind Pet Plan': 'Northwind Pet Plan' },
      note: { a: 'b' },
      removed: { a: 'b' },
    })).toEqual({ insurer: { 'Acme Pet Cover': 'Acme Pet Cover Plus' } });
  });
});
