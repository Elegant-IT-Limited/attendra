// SPDX-License-Identifier: AGPL-3.0-only
import { bn } from './bn';
import { en } from './en';
import { es } from './es';
import { type Language, LANGUAGES, type LanguagePack, normalise } from './types';

export * from './types';
export { asciiDigits, BN_MONTHS, bnDigits } from './bn';

export const PACKS: Record<Language, LanguagePack> = { en, es, bn };
export const packFor = (code: Language | undefined): LanguagePack => PACKS[code ?? 'en'] ?? en;

/**
 * Which of the clinic's languages the caller is speaking, from what they have said
 * so far. Bengali script counts double: a transcriber that returns it has heard
 * Bangla. Ties and silence go to the clinic's primary language.
 */
export function detectLanguage(callerText: string, offered: readonly Language[], primary: Language): Language {
  const text = normalise(callerText);
  let best: { code: Language; score: number } = { code: primary, score: 0 };
  for (const code of offered) {
    const matches = text.match(PACKS[code].markers) ?? [];
    const score = matches.reduce((n, m) => n + (/[ঀ-৿]/.test(m) ? 2 * m.length : 1), 0);
    if (score > best.score || (score === best.score && code === primary)) best = { code, score };
  }
  return best.code;
}

/** The national emergency number a clinic's scripts use, from its phone numbers, unless the clinic set one. */
export function emergencyNumberFor(clinic: { emergencyNumber?: string | null; phoneNumbers: string[] }): string {
  if (clinic.emergencyNumber) return clinic.emergencyNumber;
  const first = clinic.phoneNumbers[0] ?? '';
  if (first.startsWith('+880')) return '999'; // Bangladesh
  if (first.startsWith('+44')) return '999';
  if (first.startsWith('+61')) return '000';
  return '911';
}

/** The national suicide and crisis line, where there is one the scripts can name. */
export function crisisLineFor(clinic: { phoneNumbers: string[] }): string | null {
  return clinic.phoneNumbers[0]?.startsWith('+1') ? '988' : null;
}

export const isLanguage = (s: string): s is Language => (LANGUAGES as readonly string[]).includes(s);

/** What the assistant is called when the clinic has not named it. */
export const DEFAULT_ASSISTANT_NAME = "the clinic's assistant";
