// SPDX-License-Identifier: AGPL-3.0-only
import { en } from './en';
import { es } from './es';
import { type Language, LANGUAGES, type LanguagePack, normalise } from './types';

export * from './types';

export const PACKS: Record<Language, LanguagePack> = { en, es };
export const packFor = (code: Language | undefined): LanguagePack => PACKS[code ?? 'en'] ?? en;

/**
 * Which of the clinic's languages the caller is speaking, from what they have said
 * so far: the one whose marker words it used most. Ties and silence go to the
 * clinic's primary language.
 */
export function detectLanguage(callerText: string, offered: readonly Language[], primary: Language): Language {
  const text = normalise(callerText);
  let best: { code: Language; score: number } = { code: primary, score: 0 };
  for (const code of offered) {
    const matches = text.match(PACKS[code].markers) ?? [];
    const score = matches.length;
    if (score > best.score || (score === best.score && code === primary)) best = { code, score };
  }
  return best.code;
}

// the euro area, by calling code
const EURO = ['+30', '+31', '+32', '+33', '+34', '+351', '+352', '+353', '+356', '+357', '+358', '+370', '+371', '+372', '+385', '+386', '+39', '+421', '+43', '+49'];

/** A country Attendra knows the emergency number of: its ISO code, its name as Settings shows it, its calling code and its numbers (ambulance first). */
export interface EmergencyCountry { code: string; name: string; prefix: string; numbers: string[] }

const EU_MEMBERS: [string, string, string][] = [
  ['AT', 'Austria', '+43'], ['BE', 'Belgium', '+32'], ['BG', 'Bulgaria', '+359'], ['HR', 'Croatia', '+385'], ['CY', 'Cyprus', '+357'],
  ['CZ', 'Czechia', '+420'], ['DK', 'Denmark', '+45'], ['EE', 'Estonia', '+372'], ['FI', 'Finland', '+358'], ['FR', 'France', '+33'],
  ['DE', 'Germany', '+49'], ['GR', 'Greece', '+30'], ['HU', 'Hungary', '+36'], ['IT', 'Italy', '+39'], ['LV', 'Latvia', '+371'],
  ['LT', 'Lithuania', '+370'], ['LU', 'Luxembourg', '+352'], ['MT', 'Malta', '+356'], ['NL', 'the Netherlands', '+31'], ['PL', 'Poland', '+48'],
  ['PT', 'Portugal', '+351'], ['RO', 'Romania', '+40'], ['SK', 'Slovakia', '+421'], ['SI', 'Slovenia', '+386'], ['ES', 'Spain', '+34'], ['SE', 'Sweden', '+46'],
];

/**
 * The countries whose emergency numbers the scripts may give, by ISO code. Anything else has none on file, and the
 * assistant says "your local emergency number": never a guess (a test call at a clinic abroad was told 112, a number
 * its country does not use).
 */
export const EMERGENCY_COUNTRIES: EmergencyCountry[] = [
  { code: 'US', name: 'the United States', prefix: '+1', numbers: ['911'] },
  { code: 'CA', name: 'Canada', prefix: '+1', numbers: ['911'] },
  { code: 'MX', name: 'Mexico', prefix: '+52', numbers: ['911'] },
  { code: 'GB', name: 'the United Kingdom', prefix: '+44', numbers: ['999', '112'] },
  { code: 'IE', name: 'Ireland', prefix: '+353', numbers: ['112', '999'] },
  { code: 'AU', name: 'Australia', prefix: '+61', numbers: ['000', '112'] },
  { code: 'NZ', name: 'New Zealand', prefix: '+64', numbers: ['111'] },
  { code: 'HK', name: 'Hong Kong', prefix: '+852', numbers: ['999'] },
  { code: 'SG', name: 'Singapore', prefix: '+65', numbers: ['995', '999'] }, // ambulance, then police
  { code: 'JP', name: 'Japan', prefix: '+81', numbers: ['119', '110'] }, // ambulance, then police
  { code: 'ZA', name: 'South Africa', prefix: '+27', numbers: ['10177', '112'] }, // ambulance, then mobile
  { code: 'IN', name: 'India', prefix: '+91', numbers: ['112', '108'] },
  { code: 'BR', name: 'Brazil', prefix: '+55', numbers: ['192', '190'] }, // ambulance, then police
  ...EU_MEMBERS.map(([code, name, prefix]) => ({ code, name, prefix, numbers: ['112'] })),
];

type CountryOf = { country?: string | null; phoneNumbers: readonly string[] };

/**
 * The clinic's country for its emergency number: the country it set in Settings; without one, the country of its first
 * phone number's calling code (+1 is the United States or Canada, both 911). Null when neither is known.
 */
export function emergencyCountryOf(clinic: CountryOf): EmergencyCountry | null {
  if (clinic.country) return EMERGENCY_COUNTRIES.find((c) => c.code === clinic.country) ?? null;
  const first = clinic.phoneNumbers[0] ?? '';
  // the longest calling code that fits: +353 before +35..., +1 last
  const byPrefix = [...EMERGENCY_COUNTRIES].sort((a, b) => b.prefix.length - a.prefix.length).find((c) => first.startsWith(c.prefix));
  if (!byPrefix) return null;
  return byPrefix.prefix === '+1' ? { code: 'US', name: 'the United States or Canada', prefix: '+1', numbers: ['911'] } : byPrefix;
}

/** The country Settings names for the emergency number ("the United Kingdom"), or null when it isn't known. */
export function emergencyCountry(phoneNumbers: readonly string[], country?: string | null): string | null {
  return emergencyCountryOf({ phoneNumbers, country })?.name ?? null;
}

/**
 * The emergency numbers a clinic may give callers, by its country; the first is the default. A clinic may pick another
 * number only from its country's list, so a typo ("91") can never be what a caller in danger is told to ring. None for a
 * country not on file.
 */
export function allowedEmergencyNumbers(phoneNumbers: readonly string[], country?: string | null): string[] {
  return emergencyCountryOf({ phoneNumbers, country })?.numbers ?? [];
}

/** Said instead of a number when the clinic's country isn't known: never a guess. Spanish reads after "llame al". */
export const LOCAL_EMERGENCY_NUMBER: Record<Language, string> = { en: 'your local emergency number', es: 'número local de emergencias' };

/**
 * The emergency number a clinic's scripts use: the one it set, if its country allows it, otherwise the country's;
 * "your local emergency number" (in the call's language) when the country isn't known.
 */
export function emergencyNumberFor(clinic: { emergencyNumber?: string | null; country?: string | null; phoneNumbers: string[] }, language: Language = 'en'): string {
  const allowed = allowedEmergencyNumbers(clinic.phoneNumbers, clinic.country);
  if (!allowed.length) return LOCAL_EMERGENCY_NUMBER[language];
  return clinic.emergencyNumber && allowed.includes(clinic.emergencyNumber) ? clinic.emergencyNumber : allowed[0]!;
}

/** Why a clinic's emergency number cannot be saved, or null when it can. */
export function emergencyNumberProblem(clinic: { emergencyNumber?: string | null; country?: string | null; phoneNumbers: string[] }): string | null {
  const allowed = allowedEmergencyNumbers(clinic.phoneNumbers, clinic.country);
  if (!clinic.emergencyNumber || allowed.includes(clinic.emergencyNumber)) return null;
  if (!allowed.length) return 'we don\'t know the emergency number for this clinic\'s country yet, so leave it empty: the assistant says "your local emergency number"';
  return `the emergency number must be ${allowed.join(' or ')} for this clinic's country`;
}

/** The national suicide and crisis line, where there is one the scripts can name. */
export function crisisLineFor(clinic: { phoneNumbers: string[] }): string | null {
  return clinic.phoneNumbers[0]?.startsWith('+1') ? '988' : null;
}

export const isLanguage = (s: string): s is Language => (LANGUAGES as readonly string[]).includes(s);

/** What the assistant is called when the clinic has not named it. */
export const DEFAULT_ASSISTANT_NAME = "the clinic's assistant";

/**
 * Wording that depends on the clinic's country: example numbers from ranges kept for
 * fiction, the order dates are written in, and the recording note. North America keeps
 * its own; everyone else gets the country's, or wording that assumes no country.
 */
export function countryCopy(clinic: { phoneNumbers: string[] }) {
  const first = clinic.phoneNumbers[0] ?? '';
  const us = first.startsWith('+1');
  const phone = us ? { e164: '+13035550123', local: '(303) 555-0100' }
    : first.startsWith('+44') ? { e164: '+442079460123', local: '020 7946 0123' } // Ofcom's range for drama
        : first.startsWith('+61') ? { e164: '+61491570123', local: '0491 570 123' } // ACMA's range for fiction
          : { e164: '+<country code><number>', local: '' };
  // the symbol money is shown with: the visit value in Settings, the weekly report
  const currency = us ? '$' : first.startsWith('+44') ? '£' : first.startsWith('+61') ? 'A$' : first.startsWith('+64') ? 'NZ$'
    : EURO.some((c) => first.startsWith(c)) ? '€' : '';
  return {
    us,
    phone,
    currency,
    exampleDob: us ? '03/04/1985' : '04/03/1985',
    recordingHint: us
      ? 'Off by default. Several US states require every party to consent, so a notice plays first.'
      : 'Off by default. Check the law where you are before recording calls. A notice plays first.',
  };
}
