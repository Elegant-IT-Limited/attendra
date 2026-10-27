// SPDX-License-Identifier: AGPL-3.0-only

/** The pictures a person can pick, and how large, before the browser makes them small. */
export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
/** The side of the square that is uploaded, in pixels. */
export const AVATAR_SIDE = 256;

/** What is wrong with a picked file, in words for under the field; null when it can be used. */
export function pictureProblem(file: { type: string; size: number }): string | null {
  if (!PICTURE_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or WebP picture.';
  if (file.size > PICTURE_MAX_BYTES) return 'Choose a picture of 5 MB or less.';
  return null;
}

/** The centred square of a width by height picture: where to cut it from. */
export function centredSquare(width: number, height: number) {
  const side = Math.min(width, height);
  return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), side };
}

/**
 * The picture as the server keeps it: cut to its centred square and drawn at 256 by 256 on a
 * canvas, then a WebP (about 30 KB). A browser that cannot make WebP sends a JPEG instead.
 * No library: the browser decodes and encodes. Throws when the file cannot be read as an image.
 */
export async function avatarFrom(file: Blob): Promise<Blob> {
  const image = await createImageBitmap(file);
  const { x, y, side } = centredSquare(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIDE;
  canvas.height = AVATAR_SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, x, y, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
  image.close();
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  const webp = await encode('image/webp');
  // an older browser hands back a PNG when asked for WebP: a JPEG is smaller
  if (webp?.type === 'image/webp') return webp;
  const jpeg = await encode('image/jpeg');
  if (!jpeg) throw new Error('could not encode');
  return jpeg;
}
