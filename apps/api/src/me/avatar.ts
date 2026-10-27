// SPDX-License-Identifier: AGPL-3.0-only
import type { AvatarType } from '@attendra/db';

/** The image types a picture may be, as they arrive in the body's content-type. */
export const AVATAR_TYPES: readonly AvatarType[] = ['image/webp', 'image/png', 'image/jpeg'];

/**
 * What the bytes really are, from their first bytes, whatever the content-type said: a
 * WebP (RIFF....WEBP), a PNG (its 8-byte signature) or a JPEG (FF D8 FF). Anything else is null.
 */
export function imageTypeOf(b: Uint8Array): AvatarType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

/** A person's picture on this API, versioned by when it last changed so a new one shows at once; null when there is none. */
export const avatarUrl = (userId: string, at: Date | null | undefined) => (at ? `/api/v1/users/${encodeURIComponent(userId)}/avatar?v=${at.getTime()}` : null);
