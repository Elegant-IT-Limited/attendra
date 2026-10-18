import { describe, expect, it } from 'vitest';
import { changes, merge } from '../lib/merge';

describe('merging two saves of the settings', () => {
  const base = { greeting: 'Hi', hours: { mon: 1 }, faqs: ['a'], retentionDays: 30 };

  it('finds who changed what, by section', () => {
    const mine = { ...base, greeting: 'Hello', hours: { mon: 2 } };
    const theirs = { ...base, faqs: ['a', 'b'], hours: { mon: 3 } };
    expect(changes(base, mine, theirs)).toEqual({ greeting: 'mine', faqs: 'theirs', hours: 'both' });
    expect(changes(base, { ...base, hours: { mon: 2 } }, { ...base, hours: { mon: 2 } })).toEqual({ hours: 'same' });
  });

  it('keeps their save, puts mine on top where only I changed, and my pick where we both did', () => {
    const mine = { ...base, greeting: 'Hello', hours: { mon: 2 } };
    const theirs = { ...base, faqs: ['a', 'b'], hours: { mon: 3 } };
    const found = changes(base, mine, theirs);
    expect(merge(mine, theirs, found, () => true)).toEqual({ greeting: 'Hello', hours: { mon: 2 }, faqs: ['a', 'b'], retentionDays: 30 });
    expect(merge(mine, theirs, found, () => false)).toEqual({ greeting: 'Hello', hours: { mon: 3 }, faqs: ['a', 'b'], retentionDays: 30 });
  });

  it('removes a setting I cleared', () => {
    const withExtra = { ...base, extra: 1 };
    const mine = { ...base } as typeof withExtra;
    expect(merge(mine, withExtra, changes(withExtra, mine, withExtra), () => true)).not.toHaveProperty('extra');
  });
});
