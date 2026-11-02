// SPDX-License-Identifier: AGPL-3.0-only
import { phoneDigits } from './identity';

/**
 * Phone numbers, one way everywhere: every number typed or heard (a pet's owner, a
 * vet, a request's callback number, a VIP caller, a transfer, an import row, the
 * assistant's `phone` arguments) is stored as E.164, compared as E.164, and shown in
 * the clinic's own national format. "3035550142", "(303) 555-0142", "303-555-0142",
 * "+1 303 555 0142" and "1 303 555 0142" are all +13035550142 at a US clinic.
 */

/** Anything that says which country a clinic is in: its own first number. */
export type PhoneCountry = { phoneNumbers: readonly string[] };

// ITU country calling codes that are one or two digits long; every other code is three
const ONE_DIGIT = ['1', '7'];
const TWO_DIGITS = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58',
  '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98']);
// the prefix people dial at home before a national number ("0" in "020 7946 0123"), by calling code
const TRUNK: Record<string, string> = { '44': '0', '353': '0', '61': '0', '64': '0' };

const E164 = /^\+[1-9]\d{7,14}$/;
/** Whether a number is stored the one way: E.164, like +13035550100. */
export const isE164 = (n: string) => E164.test(n);

/** The country calling code of an E.164 number: "1" for +13035550100, "44" for +442079460123. */
export function callingCode(e164: string): string | null {
  const digits = /^\+(\d{8,15})$/.exec(e164.replace(/^tel:/, ''))?.[1];
  if (!digits) return null;
  if (ONE_DIGIT.includes(digits[0]!)) return digits[0]!;
  return TWO_DIGITS.has(digits.slice(0, 2)) ? digits.slice(0, 2) : digits.slice(0, 3);
}

/** The calling code of the clinic's own country, from its first number; North America when it has none yet. */
export const clinicCallingCode = (clinic: PhoneCountry) => callingCode(clinic.phoneNumbers[0] ?? '') ?? '1';

/**
 * A number however it was typed or said, as E.164: with a leading + or 00 as given; in
 * North America ten digits, or eleven starting with 1, get +1; anywhere else a
 * national number (its home 0 dropped) gets the clinic's own country code, and one
 * that starts with that code already is taken as international. A number that cannot
 * be read as a whole one (too short, letters) is left as it was given, trimmed: it is
 * still kept, and read back to the caller.
 */
export function asE164(clinic: PhoneCountry, typed: string): string {
  const t = typed.trim().replace(/^tel:/, '');
  let digits = t.replace(/\D/g, '');
  if (/^(\+|00)/.test(t.replace(/[\s().-]/g, ''))) {
    if (!t.startsWith('+')) digits = digits.slice(2);
    return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0' ? `+${digits}` : t;
  }
  const code = clinicCallingCode(clinic);
  if (code === '1') return digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : t;
  const trunk = TRUNK[code] ?? '';
  if (!(trunk && digits.startsWith(trunk)) && digits.startsWith(code) && digits.length - code.length >= 8) digits = digits.slice(code.length);
  const national = trunk && digits.startsWith(trunk) ? digits.slice(trunk.length) : digits;
  return national.length >= 7 && national.length + code.length <= 15 ? `+${code}${national}` : t;
}

/**
 * Whether two numbers are the same phone. With the clinic, both are read as E.164
 * first, so every way of writing one number agrees and a number abroad never matches
 * a local one. A number that cannot be read whole falls back to its last digits, as
 * stored keyed lookups do.
 */
export function samePhone(a: string, b: string, clinic?: PhoneCountry): boolean {
  if (clinic) {
    const x = asE164(clinic, a);
    const y = asE164(clinic, b);
    if (isE164(x) && isE164(y)) return x === y;
  }
  return phoneDigits(a) === phoneDigits(b);
}

// how a national number is grouped for reading, by calling code and its first digit
function grouped(code: string, national: string): string {
  const g = (sizes: number[]) => {
    const parts: string[] = [];
    let at = 0;
    for (const n of sizes) { if (at < national.length) parts.push(national.slice(at, at + n)); at += n; }
    if (at < national.length) parts[parts.length - 1] += national.slice(at);
    return parts.join(' ');
  };
  if (code === '44') return national.startsWith('2') ? g([2, 4, 4]) : national.startsWith('7') ? g([4, 6]) : g([4, 6]);
  if (code === '61') return national.startsWith('4') ? g([3, 3, 3]) : g([1, 4, 4]);
  if (code === '353' || code === '64') return national.startsWith('2') ? g([2, 3, 4]) : g([1, 3, 4]);
  return g([3, 3, 4]);
}

/**
 * A stored number for people to read: the clinic's own national format for a number in
 * its country ("(303) 555-0142", "020 7946 0123"), the international one for any other
 * ("+44 20 7946 0123", "+1 303 555 0142"). A number that is not E.164 is shown as it was given.
 */
export function formatPhone(clinic: PhoneCountry, stored: string | null | undefined): string {
  if (!stored) return '';
  const e164 = asE164(clinic, stored);
  const code = callingCode(e164);
  if (!code || !isE164(e164)) return stored;
  const national = e164.slice(1 + code.length);
  const home = code === clinicCallingCode(clinic);
  if (code === '1' && national.length === 10) {
    return home ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : `+1 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  }
  return home ? `${TRUNK[code] ?? ''}${grouped(code, national)}` : `+${code} ${grouped(code, national)}`;
}

type Phoned = { phone?: string | undefined };
type ConfigPhones = PhoneCountry & {
  vipCallers?: Phoned[] | undefined;
  emergencyHospital?: Phoned | undefined;
  moreEmergencyHospitals?: Phoned[] | undefined;
  routing?: { uri: string }[] | undefined;
  providers?: (Phoned & { otherPhones?: string[] | undefined })[] | undefined;
};

/**
 * A clinic's settings with every number in them as E.164 (VIP callers, emergency
 * hospitals, transfer numbers, providers' numbers), however staff typed them. Runs
 * before the settings are checked and saved, so "(303) 555-0100" is never refused for
 * missing its +1. The clinic's own numbers come from the hosting layer and are left alone.
 */
export function withPhonesAsE164<C extends ConfigPhones>(c: C): C {
  const one = (n: string | undefined) => (n?.trim() ? asE164(c, n) : n);
  const fix = <T extends Phoned>(x: T): T => (x.phone === undefined ? x : { ...x, phone: one(x.phone) });
  return {
    ...c,
    ...(c.vipCallers ? { vipCallers: c.vipCallers.map(fix) } : {}),
    ...(c.emergencyHospital ? { emergencyHospital: fix(c.emergencyHospital) } : {}),
    ...(c.moreEmergencyHospitals ? { moreEmergencyHospitals: c.moreEmergencyHospitals.map(fix) } : {}),
    ...(c.routing ? { routing: c.routing.map((r) => (r.uri.startsWith('tel:') ? { ...r, uri: `tel:${asE164(c, r.uri.slice(4))}` } : r)) } : {}),
    ...(c.providers ? { providers: c.providers.map((p) => ({ ...fix(p), ...(p.otherPhones ? { otherPhones: p.otherPhones.map((x) => asE164(c, x)) } : {}) })) } : {}),
  };
}
