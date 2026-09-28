// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for PHI columns.
 *
 * One 32-byte master key (ATTENDRA_DATA_KEY, base64) is expanded with HKDF into an
 * encryption key and a separate MAC key, so the lookup hashes cannot be used to
 * attack the ciphertext. Values are AES-256-GCM with a random 96-bit IV, stored as
 * "v1.<iv>.<tag>.<ciphertext>" in base64url. In Elegant Cloud the master key is a
 * KMS data key; self-hosters keep it in their secret store, never in the database.
 *
 * Every value is bound to where it lives (clinic, table, column) as GCM associated
 * data, so a ciphertext copied into another row or another clinic fails to decrypt
 * instead of quietly showing the wrong patient's details.
 */
export interface PhiCipher {
  encrypt(plain: string, context: string): string;
  decrypt(stored: string, context: string): string;
  /** Deterministic keyed hash for equality lookups. Include the clinic id in the input. */
  hash(value: string): string;
}

/** The associated-data string for one column of one clinic's table. */
export const phiContext = (clinicId: string, column: string) => `${clinicId}:${column}`;

export function createPhiCipher(masterKeyBase64: string): PhiCipher {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length !== 32) throw new Error('ATTENDRA_DATA_KEY must be 32 bytes, base64 encoded');
  const encKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'attendra/phi/enc/v1', 32));
  const macKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'attendra/phi/mac/v1', 32));
  const b64 = (b: Buffer) => b.toString('base64url');

  return {
    encrypt(plain, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
    },
    decrypt(stored, context) {
      const [version, iv, tag, body] = stored.split('.');
      if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('unrecognised ciphertext format');
      const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    },
    hash(value) {
      return createHmac('sha256', macKey).update(value).digest('base64url');
    },
  };
}
