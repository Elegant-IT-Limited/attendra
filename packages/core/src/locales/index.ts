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

// European Union country codes, where 112 is the emergency number
const EU = ['+30', '+31', '+32', '+33', '+34', '+351', '+352', '+353', '+356', '+357', '+358', '+359', '+36', '+370', '+371', '+372', '+385', '+386', '+39', '+40', '+420', '+421', '+43', '+45', '+46', '+48', '+49'];

/**
 * The emergency numbers a clinic may give callers, by the country of its first phone
 * number; the first is the default. A clinic may pick another number only from its
 * country's list, so a typo ("91") can never be what a caller in danger is told to
 * ring. A country not listed gets 112, which mobile networks route everywhere.
 */
export function allowedEmergencyNumbers(phoneNumbers: readonly string[]): string[] {
  const first = phoneNumbers[0] ?? '';
  if (first.startsWith('+1')) return ['911']; // the United States and Canada
  if (first.startsWith('+880')) return ['999']; // Bangladesh
  if (first.startsWith('+44')) return ['999', '112']; // the United Kingdom
  if (first.startsWith('+61')) return ['000', '112']; // Australia
  if (EU.some((c) => first.startsWith(c))) return ['112'];
  return ['112'];
}

/** The emergency number a clinic's scripts use: the one it set, if its country allows it, otherwise the country's. */
export function emergencyNumberFor(clinic: { emergencyNumber?: string | null; phoneNumbers: string[] }): string {
  const allowed = allowedEmergencyNumbers(clinic.phoneNumbers);
  return clinic.emergencyNumber && allowed.includes(clinic.emergencyNumber) ? clinic.emergencyNumber : allowed[0]!;
}

/** Why a clinic's emergency number cannot be saved, or null when it can. */
export function emergencyNumberProblem(clinic: { emergencyNumber?: string | null; phoneNumbers: string[] }): string | null {
  const allowed = allowedEmergencyNumbers(clinic.phoneNumbers);
  if (!clinic.emergencyNumber || allowed.includes(clinic.emergencyNumber)) return null;
  return `the emergency number must be ${allowed.join(' or ')} for this clinic's country`;
}

/** The national suicide and crisis line, where there is one the scripts can name. */
export function crisisLineFor(clinic: { phoneNumbers: string[] }): string | null {
  return clinic.phoneNumbers[0]?.startsWith('+1') ? '988' : null;
}

export const isLanguage = (s: string): s is Language => (LANGUAGES as readonly string[]).includes(s);

/** What the assistant is called when the clinic has not named it. */
export const DEFAULT_ASSISTANT_NAME = "the clinic's assistant";
