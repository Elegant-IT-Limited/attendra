import { describe, expect, it } from 'vitest';
import { requestKindRenames } from '../src';

// Note 2026-11-16 (demo findings 3, item 3): a renamed kind of request is carried to its requests, matched by the kind's id.
describe('renamed kinds of request', () => {
  const board = { id: 'topic_board', name: 'Boarding booking' };
  const groom = { id: 'topic_groom', name: 'Grooming' };
  it('a kind with the same id and a new name is a rename; one removed or added is not', () => {
    expect(requestKindRenames([board, groom], [{ ...board, name: 'Boarding stay' }, groom])).toEqual({ 'Boarding booking': 'Boarding stay' });
    expect(requestKindRenames([board, groom], [groom])).toEqual({});
    expect(requestKindRenames([groom], [groom, board])).toEqual({});
    expect(requestKindRenames(undefined, [board])).toEqual({});
    // spaces around a name are no rename
    expect(requestKindRenames([board], [{ ...board, name: ' Boarding booking ' }])).toEqual({});
  });
});
