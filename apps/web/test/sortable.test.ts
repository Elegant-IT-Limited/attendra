import { describe, expect, it } from 'vitest';
import { moved } from '../lib/order';

describe('putting a list in order', () => {
  it('moves one item to its new place and keeps the rest in order', () => {
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('leaves the list it was given as it was', () => {
    const list = ['a', 'b', 'c'];
    moved(list, 0, 2);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});
