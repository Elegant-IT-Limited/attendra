// SPDX-License-Identifier: AGPL-3.0-only

/** Who changed one top-level setting since the copy both people started from. */
export type Change = 'mine' | 'theirs' | 'both' | 'same';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A three-way comparison by top-level key: what was loaded (`base`), my draft, and the
 * save someone made since. Keys nobody changed are left out.
 */
export function changes<T extends object>(base: T, mine: T, theirs: T): Record<string, Change> {
  const out: Record<string, Change> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  for (const k of keys) {
    const b = (base as Record<string, unknown>)[k], m = (mine as Record<string, unknown>)[k], t = (theirs as Record<string, unknown>)[k];
    const byMe = !same(b, m), byThem = !same(b, t);
    if (byMe && byThem) out[k] = same(m, t) ? 'same' : 'both';
    else if (byMe) out[k] = 'mine';
    else if (byThem) out[k] = 'theirs';
  }
  return out;
}

/** Theirs, with my changes on top where only I changed something, and my pick where we both did. */
export function merge<T extends object>(mine: T, theirs: T, found: Record<string, Change>, keepMine: (key: string) => boolean): T {
  const out = { ...theirs } as Record<string, unknown>;
  for (const [k, c] of Object.entries(found)) {
    if (c === 'mine' || (c === 'both' && keepMine(k))) {
      const v = (mine as Record<string, unknown>)[k];
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
  }
  return out as T;
}
