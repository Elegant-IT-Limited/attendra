// SPDX-License-Identifier: AGPL-3.0-only
import type { AvatarType } from '@attendra/db';

/** The image types a picture may be, as they arrive in the body's content-type. */
export const AVATAR_TYPES: readonly AvatarType[] = ['image/webp', 'image/png', 'image/jpeg'];

/**
 * What the bytes really are, from their first bytes, whatever the content-type said: a
 * WebP (RIFF....WEBP), a PNG (its 8-byte signature) or a JPEG (FF D8 FF). Anything else is null.
 */
export function imageTypeOf(b: Buffer): AvatarType | null {
  if (!Buffer.isBuffer(b)) return null;
  const starts = (bytes: number[], at = 0) => b.byteLength >= at + bytes.length && bytes.every((x, i) => b.readUInt8(at + i) === x);
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'; // RIFF....WEBP
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

/** A person's picture on this API, versioned by when it last changed so a new one shows at once; null when there is none. */
export const avatarUrl = (userId: string, at: Date | null | undefined) => (at ? `/api/v1/users/${encodeURIComponent(userId)}/avatar?v=${at.getTime()}` : null);
