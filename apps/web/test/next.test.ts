import { describe, expect, it } from 'vitest';
import { safeNext } from '../lib/next';

describe('where sign-in goes next', () => {
  it('a page of the dashboard, with its query', () => {
    for (const path of ['/c/clinic_1/schedule', '/account', '/profile', '/c/a?b=1#c']) expect(safeNext(path)).toBe(path);
  });

  it('never another site, however the address is written', () => {
    // a browser drops tabs and line breaks, and reads a backslash as a slash: each of these would open evil.example
    for (const path of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\r\\evil.example', 'https://evil.example', 'evil.example']) {
      expect(safeNext(path), JSON.stringify(path)).toBeNull();
    }
  });

  it('not back to a sign-in step, and nothing at all', () => {
    for (const path of ['/sign-in?next=/x', '/two-factor', '/reset-password?token=t', '', null, undefined]) expect(safeNext(path)).toBeNull();
  });
});
