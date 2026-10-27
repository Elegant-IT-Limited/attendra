import { describe, expect, it } from 'vitest';
import { centredSquare, pictureProblem } from '../lib/avatar';

describe('a picture for Your profile', () => {
  it('takes a JPEG, PNG or WebP up to 5 MB, and says what is wrong with anything else', () => {
    expect(pictureProblem({ type: 'image/png', size: 5 * 1024 * 1024 })).toBeNull();
    expect(pictureProblem({ type: 'image/webp', size: 1 })).toBeNull();
    expect(pictureProblem({ type: 'image/gif', size: 1 })).toBe('Choose a JPEG, PNG or WebP picture.');
    expect(pictureProblem({ type: 'image/svg+xml', size: 1 })).toBe('Choose a JPEG, PNG or WebP picture.');
    expect(pictureProblem({ type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 })).toBe('Choose a picture of 5 MB or less.');
  });

  it('is cut to its centred square', () => {
    expect(centredSquare(600, 400)).toEqual({ x: 100, y: 0, side: 400 });
    expect(centredSquare(300, 500)).toEqual({ x: 0, y: 100, side: 300 });
    expect(centredSquare(256, 256)).toEqual({ x: 0, y: 0, side: 256 });
  });
});
