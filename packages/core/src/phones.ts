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
/** The emergency setting's numbers: its line, and each hospital's phone. */
type EmergencyPhones = { number?: string | undefined; hospital?: Phoned | undefined; backupHospital?: Phoned | undefined; afterHoursHospital?: Phoned | undefined; moreHospitals?: Phoned[] | undefined };
const EMERGENCY_HOSPITAL_KEYS = ['hospital', 'backupHospital', 'afterHoursHospital'] as const;
type ConfigPhones = PhoneCountry & {
  vipCallers?: Phoned[] | undefined;
  emergencies?: EmergencyPhones | undefined;
  routing?: { uri: string }[] | undefined;
  providers?: (Phoned & { otherPhones?: string[] | undefined })[] | undefined;
};

/**
 * A clinic's settings with every number in them as E.164 (VIP callers, the emergency
 * setting's line and hospitals, transfer numbers, providers' numbers), however staff typed them. Runs
 * before the settings are checked and saved, so "(303) 555-0100" is never refused for
 * missing its +1. The clinic's own numbers come from the hosting layer and are left alone.
 */
export function withPhonesAsE164<C extends ConfigPhones>(c: C): C {
  const one = (n: string | undefined) => (n?.trim() ? asE164(c, n) : n);
  const fix = <T extends Phoned>(x: T): T => (x.phone === undefined ? x : { ...x, phone: one(x.phone) });
  return {
    ...c,
    ...(c.vipCallers ? { vipCallers: c.vipCallers.map(fix) } : {}),
    ...(c.emergencies ? { emergencies: emergencyPhonesAsE164(c.emergencies, one, fix) } : {}),
    ...(c.routing ? { routing: c.routing.map((r) => (r.uri.startsWith('tel:') ? { ...r, uri: `tel:${asE164(c, r.uri.slice(4))}` } : r)) } : {}),
    ...(c.providers ? { providers: c.providers.map((p) => ({ ...fix(p), ...(p.otherPhones ? { otherPhones: p.otherPhones.map((x) => asE164(c, x)) } : {}) })) } : {}),
  };
}

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  cero: '0', uno: '1', un: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};
const REPEAT: Record<string, number> = { double: 2, doble: 2, triple: 3 };

/**
 * A number as people say it, as digits: "double eight, zero three, triple five, oh one three oh" is "8803555 0130"
 * (spaces kept between pieces). "double"/"triple" (Spanish "doble"/"triple") repeat the next digit, even when that digit
 * comes in the next piece of speech or as a written digit ("triple 5"). Words that aren't digits are left as they are,
 * so a number with letters is still refused where letters are refused.
 */
export function spokenDigits(said: string): string {
  const tokens = said.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/(\s+|,|-|\.)/);
  const out: string[] = [];
  let repeat = 1;
  for (const token of tokens) {
    const t = token.trim();
    if (!t || /^[,.-]$/.test(t)) { out.push(token); continue; }
    if (REPEAT[t]) { repeat = REPEAT[t]!; continue; }
    const digit = NUMBER_WORDS[t] ?? (/^\d+$/.test(t) ? t : null);
    if (digit === null) { out.push(token); repeat = 1; continue; }
    out.push(digit[0]!.repeat(repeat) + digit.slice(1));
    repeat = 1;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

// how many digits a national number has where that is fixed (its home 0 apart), by calling code: what is left after a
// spoken prefix must be exactly one whole number
const NATIONAL_DIGITS: Record<string, number> = { '1': 10, '44': 10, '61': 9, '353': 9 };
/** A North American number: an area code and an exchange that do not start with 0 or 1. */
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;
const isCallingCode = (digits: string) => digits.length >= 1 && digits.length <= 3 && digits[0] !== '0' && callingCode(`+${digits}0000000`) === digits;

/**
 * A number the caller said, with a country prefix they said aloud dropped: "52 303 555 0130" is (303) 555-0130 at a
 * clinic in the United States, and so is "1 303 555 0130" (a test call, 2026-11-03, was read back with its prefix three
 * times). Only when the digits after the prefix are one whole national number for the clinic's country and the prefix is
 * a country calling code (or 011, dialled out of North America); otherwise, or with a + or 00 said, as it was given.
 * The read-back that follows lets the caller correct it.
 */
export function withoutSpokenPrefix(clinic: PhoneCountry, said: string): string {
  const t = said.trim();
  if (/^(\+|00)/.test(t.replace(/[\s().-]/g, ''))) return t;
  const digits = t.replace(/\D/g, '');
  const code = clinicCallingCode(clinic);
  const length = NATIONAL_DIGITS[code];
  if (!length || digits.length <= length) return t;
  const national = digits.slice(-length);
  if (code === '1' ? !NANP.test(national) : national.startsWith('0')) return t;
  // the prefix as said, without the home 0 a caller may say before the national number ("52 020 7946 0123")
  const prefix = digits.slice(0, -length);
  const trunk = TRUNK[code];
  const plain = trunk && prefix.length > trunk.length && prefix.endsWith(trunk) ? prefix.slice(0, -trunk.length) : null;
  return isCallingCode(prefix) || (plain !== null && isCallingCode(plain)) || (code === '1' && prefix === '011') ? national : t;
}

/** A number as the caller said it (words or digits, a spoken prefix and all), as E.164 the way every number on file is. */
export const heardNumber = (clinic: PhoneCountry, said: string) => asE164(clinic, withoutSpokenPrefix(clinic, spokenDigits(said)));

/** A number read back in groups, as people say it: 303-555-0130 in North America, the national digits in threes and the rest elsewhere. */
export function groupedNumber(clinic: PhoneCountry, number: string): string {
  const e164 = asE164(clinic, number);
  const code = callingCode(e164);
  const national = code ? e164.slice(code.length + 1) : number.replace(/\D/g, '');
  if (code === '1' && national.length === 10) return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
  const d = national.replace(/\D/g, '');
  return d.length > 7 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d.length > 4 ? `${d.slice(0, d.length - 4)}-${d.slice(-4)}` : d;
}

/** What a phone field takes: digits and the phone characters (a leading +, spaces, -, (, ), .). No letters, ever. */
export const PHONE_TYPED = /^\+?[\d\s().-]*$/;
/** The one message for a phone typed with anything else, in the browser and from the API. */
export const PHONE_NUMBERS_ONLY = 'Use numbers only, for example (555) 555-0123.';

/** Why a typed phone is refused, or null: letters, or a + anywhere but first. Empty is for the field's own rule. */
export const phoneProblem = (typed: string): string | null => (PHONE_TYPED.test(typed.trim()) ? null : PHONE_NUMBERS_ONLY);

/**
 * A phone as it is being typed or pasted, cleaned: letters and other symbols dropped, a + kept only first.
 * `dropped` says something was taken out, so the field can say why instead of changing silently.
 */
export function cleanPhoneTyping(typed: string): { value: string; dropped: boolean } {
  const plus = typed.trimStart().startsWith('+');
  const kept = typed.replace(/[^\d\s().-]/g, '');
  const value = (plus ? '+' : '') + kept.replace(/^\s+/, plus ? '' : '');
  return { value: plus ? value : kept, dropped: value.replace(/^\+/, '').length + (plus ? 1 : 0) !== typed.length };
}

/** How a phone field cleans what is typed: one number, several separated by commas, or a transfer (a number or a SIP address). */
export type PhoneTypingMode = 'one' | 'several' | 'transfer';

/** A SIP address, or the start of one being typed ("s", "si", "sip", "sip:…"): a transfer keeps its letters. */
const SIP_TYPED = /^sips?:/i;
const sipStart = (typed: string) => SIP_TYPED.test(typed.trim()) || (!!typed.trim() && 'sips:'.startsWith(typed.trim().toLowerCase()));

/**
 * cleanPhoneTyping for every kind of phone field: several numbers are cleaned one by one (each may start with +),
 * keeping the commas between them; a transfer that is a SIP address, or is becoming one, is kept as typed.
 */
export function cleanPhoneField(typed: string, mode: PhoneTypingMode = 'one'): { value: string; dropped: boolean } {
  if (mode === 'transfer' && sipStart(typed)) return { value: typed, dropped: false };
  if (mode !== 'several') return cleanPhoneTyping(typed);
  // the space after a comma stays where it was typed
  const one = (part: string) => { const lead = /^\s*/.exec(part)![0]; const c = cleanPhoneTyping(part.slice(lead.length)); return { value: lead + c.value, dropped: c.dropped }; };
  const parts = typed.split(/([,;])/).map((part, i) => (i % 2 ? { value: part, dropped: false } : one(part)));
  return { value: parts.map((p) => p.value).join(''), dropped: parts.some((p) => p.dropped) };
}

/** The short digits-only number a person in danger is told to call (911, 999, 112): what a typed one keeps, and whether anything was dropped. */
export function cleanDigitsTyping(typed: string): { value: string; dropped: boolean } {
  const value = typed.replace(/\D/g, '');
  return { value, dropped: value.length !== typed.length };
}
/** The one message for an emergency number typed with anything but digits. */
export const DIGITS_ONLY = 'Digits only, like 911.';

/** The emergency setting with its line and every hospital's phone as E.164. */
function emergencyPhonesAsE164<E extends EmergencyPhones>(e: E, one: (n: string | undefined) => string | undefined, fix: <T extends Phoned>(x: T) => T): E {
  const out: E = { ...e, ...(typeof e.number === 'string' ? { number: one(e.number) } : {}) };
  for (const k of EMERGENCY_HOSPITAL_KEYS) if (e[k]) out[k] = fix(e[k]!) as E[typeof k];
  if (e.moreHospitals) out.moreHospitals = e.moreHospitals.map(fix);
  return out;
}

/**
 * Every phone typed into Settings that isn't numbers only, by its path ("vipCallers.0.phone"), before anything is
 * normalised: the normaliser keeps only the digits, so "303 CALL NOW" would otherwise be saved as a number.
 */
export function phoneTypingIssues(body: unknown): { path: string; message: string }[] {
  if (!body || typeof body !== 'object') return [];
  const c = body as { phoneNumbers?: unknown; vipCallers?: unknown; emergencies?: unknown; routing?: unknown };
  const out: { path: string; message: string }[] = [];
  const check = (path: string, v: unknown) => { if (typeof v === 'string' && phoneProblem(v.replace(/^tel:/, ''))) out.push({ path, message: PHONE_NUMBERS_ONLY }); };
  if (Array.isArray(c.phoneNumbers)) c.phoneNumbers.forEach((n, i) => check(`phoneNumbers.${i}`, n));
  if (Array.isArray(c.vipCallers)) c.vipCallers.forEach((v, i) => check(`vipCallers.${i}.phone`, (v as { phone?: unknown })?.phone));
  if (c.emergencies && typeof c.emergencies === 'object') {
    const e = c.emergencies as Record<string, unknown>;
    check('emergencies.number', e.number);
    for (const k of EMERGENCY_HOSPITAL_KEYS) if (e[k] && typeof e[k] === 'object') check(`emergencies.${k}.phone`, (e[k] as { phone?: unknown }).phone);
    if (Array.isArray(e.moreHospitals)) e.moreHospitals.forEach((h, i) => check(`emergencies.moreHospitals.${i}.phone`, (h as { phone?: unknown })?.phone));
  }
  // a transfer is a phone (tel:) or a SIP address; only the phone ones are numbers only
  if (Array.isArray(c.routing)) c.routing.forEach((r, i) => { const uri = (r as { uri?: unknown })?.uri; if (typeof uri === 'string' && uri.startsWith('tel:')) check(`routing.${i}.uri`, uri); });
  return out;
}
