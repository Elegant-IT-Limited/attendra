// SPDX-License-Identifier: AGPL-3.0-only
import {
  bookableProviders,
  addDays, EMERGENCY_LINES, saysSlot, ageOn, asE164, groupedNumber, heardNumber, providerName, noticeWords, relatedBookable, spokenDigits, callUsNumber, declinesText, describesPet, pointsAtPet, withoutTextRefusal, type AuditLog, dobProblem, type Gender, genderWord, type ClinicConfig, type DomainEvent, emergencyNumberFor, type EventSink, findSlots, isClearYes, isMedicalQuestion, type KnowledgeBase, localDateOf, localName, MEDICAL_REFUSAL,
  fold, industryPack, isOpen, isPetEmergency, LANGUAGES, normalise, localParts, matchesSpecialty, toMinutes, type Messenger, NO_INFORMATION, PACKS, parseDob, parsePetBirth, saidGoodbye, samePhone,
  type PatientDirectory, providerFacts, resolveTransfer, type SchedulerAdapter, seesAge, type Slot, speakSlot, specialtyFacts, type TaskQueue,
  toolArgsFor, type ToolName, todaysHoursLine, visitTypeFacts, currentOffers, requestTopicFacts, weekHours, zonedInstant, dayShift, offerTimesLine,
  bookableWindows, emergencyHospitalsOf, hospitalNow, hoursSummary, textAskOf, textRoute, textSituationOf, type AskedTextKind, type TextTableRefusal, type TextSource, type NearDirection, type Provider, type SmsTemplate, textableNumber, textingOf, bookingOf, seesAnimal, soundsLike, usualProviderOf, awayOn, specialDayOf, weekdayOf, windowsOnDate,
} from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { createHash } from 'node:crypto';
import { fillFromMemory } from './call-memory';
import { dayReason, doesntDoType, frontDeskLine, nothingFound, vetHoursLine } from './slot-answer';
import type { CallState } from './call-state';
import { answerFromFaqs } from './knowledge';
import { asksWhichVet } from './flow/guards';
import { outOfScopeLine } from '@attendra/knowledge/scope';

export interface Backend {
  patients: PatientDirectory;
  scheduler: SchedulerAdapter;
  tasks: TaskQueue;
  audit: AuditLog;
  messenger: Messenger;
  /** The clinic's own documents. Without it, the assistant answers from the FAQ alone. */
  knowledge?: KnowledgeBase;
  /** The clinic's webhooks hear about bookings, cancellations and requests. */
  events?: EventSink;
}

export interface CallContext {
  /** The clinic's settings as of the latest request: reloaded before each one, so a doctor added mid-call is known. */
  clinic: ClinicConfig;
  /** Reads the clinic's current settings. Null keeps the ones the call has. */
  reloadClinic?: () => Promise<ClinicConfig | null>;
  callId: string;
  callerNumber: string | null;
  /** This number's last calls to the clinic, from our records, for picking up where the caller left off. */
  history?: string | null;
  now: () => Date;
  log?: Logger;
  /** A browser test call cannot be transferred: the assistant says where it would have connected the caller. */
  channel?: 'phone' | 'web';
  /** Told when a caller waited this many milliseconds for an answer (the voice service alerts on it). */
  onSlow?: (ms: number) => void;
  /** Told when an answer ran past the 60 s limit and the caller was offered a callback instead (the voice service alerts on it). */
  onTimeout?: (ms: number) => void;
}

/** What a tool hands back: data for the planner, and optionally a call-control action. */
export interface ToolResult {
  ok: boolean;
  data: Record<string, unknown>;
  action?: { type: 'transfer'; uri: string } | { type: 'hangup' };
}

const MAX_VERIFY_ATTEMPTS = 3;
/** Calls whose caller has heard the confirmation-text note with a read-back: it is said once a call. */
const TEXT_NOTE_SAID = new WeakSet<CallState>();
/** Said with every miss: once the tries run out, nobody can be found or added on this call. */
const triesLeft = (state: CallState) => {
  const left = MAX_VERIFY_ATTEMPTS - state.verifyAttempts;
  return left > 0 ? `${left} ${left === 1 ? 'try is' : 'tries are'} left; after that nobody can be found or added on this call.` : 'No tries are left.';
};
const MAX_REGISTRATIONS = 3;
/** The details of one identity check, as the same words and digits whatever their case, spacing or punctuation. */
const identityKey = (...parts: string[]) => parts.map((p) => p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).join('|');
/** The same details again: nothing new to look up, so no try is used, and the planner is told to move on. */
const triedAgain = (state: CallState, who: string) => refuse('not_verified', `These same details were already looked up on this call and nothing was found: do not look them up again. If the caller has not said whether ${who} is new to the clinic, ask that; if new, add them with register_patient. Otherwise ask only for the detail that may be wrong. ${triesLeft(state)}`);
const PATIENT_TOOLS = new Set<ToolName>(['list_appointments', 'propose_booking', 'propose_cancellation', 'commit_pending', 'create_refill_request', 'set_reminder_consent']);
// tools that change something; they refuse to run for an outdated request
const WRITE_TOOLS = new Set<ToolName>(['register_patient', 'propose_booking', 'propose_cancellation', 'commit_pending', 'create_refill_request', 'create_callback', 'send_text', 'set_reminder_consent', 'transfer_call', 'end_call']);
// after an emergency the only things left to do are to hand the caller to a person
// (send_text narrows itself: in an emergency, only the hospital's details)
const EMERGENCY_ALLOWED = new Set<ToolName>(['transfer_call', 'create_callback', 'end_call', 'get_clinic_info', 'send_text']);
/** What waits for the caller's answer to the emergency question, for the pet it is about: looking for times and booking. */
const WAITS_FOR_ANSWER = new Set<ToolName>(['find_slots', 'propose_booking', 'commit_pending']);

/** The note on a booking for the team: who booked it (when not the owner on file), and what an emergency the caller cleared reported. */
function bookingNote(state: CallState, byCaller: string | null, clinic: ClinicConfig): { note?: string } {
  const pack = PACKS[clinic.primaryLanguage];
  const notes = [byCaller ? pack.bookedByCallerNote({ name: byCaller }) : state.foundByLastFour ? pack.foundByLastFourNote : null, ...state.emergencyNotes].filter((n): n is string => !!n);
  return notes.length ? { note: notes.join(' ') } : {};
}
/**
 * After an animal's emergency script: no routine visit for the pet in danger, and the next step instead, the team now
 * (a front-desk line that takes calls while the clinic is open) or an urgent request. The hospital only if asked.
 */
function petEmergencyNextStep(state: CallState, ctx: CallContext): ToolResult {
  const pet = state.emergencyPet?.name ?? null;
  const transfer = resolveTransfer(ctx.clinic, 'front_desk', ctx.now()).ok && isOpen(ctx.clinic, ctx.now());
  return refuse('emergency_in_progress', `The caller already heard where to take the animal: do not say it again unless they ask where to go. No routine visit for ${pet ?? 'this pet'} can be booked on this call. Say, in these words: "${PACKS[state.language].petEmergencyNext({ pet, transfer })}" `
    + (transfer ? 'On a yes, call transfer_call with front_desk. ' : 'On a yes, call create_callback with what they want and the best number: the team gets it as urgent. ')
    + 'A question about another pet is answered as usual.');
}

/**
 * Whether a tool, after an animal's emergency script, is about the pet in danger: its routine visit stays refused. Finding
 * a pet is never refused (it may be another one, or the one a request is for); the rest is about the pet found or being
 * talked about, which counts as another pet only when its name, or else its kind, differs from the one in danger. When the
 * call cannot tell, it is the same pet.
 */
function aboutPetInDanger(name: ToolName, args: Record<string, unknown>, state: CallState, flagged?: { name: string | null; species: string | null } | null): boolean {
  if (name === 'verify_caller') return false;
  const danger = flagged ?? state.emergencyPet;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const pet = name === 'register_patient' ? { name: text(args.pet_name), species: text(args.species) }
    : state.verifiedPatient ? { name: state.verifiedPatient.firstName, species: state.verifiedPatient.species ?? null }
      : { name: state.memory.get('petName') ?? null, species: state.memory.get('species') ?? null };
  if (!danger) return true;
  if (danger.name && pet.name) return soundsLike(danger.name, pet.name);
  if (danger.species && pet.species) return danger.species.toLowerCase() === pet.species.toLowerCase();
  return true;
}
/** Texts the assistant may send on one call after a yes. Confirmations do not count. */
export const MAX_TEXTS_PER_CALL = 3;
/** The assistant's own words that offered a text: "I can text you…", "…por mensaje". */
const TEXT_OFFER_MARKER = /\btext|mensaje/i;
/** What a search is about: "does Maple Street Family Medicine do X" is about X, since the clinic's own name matches every document. */
function topicOf(question: string, clinicName: string): string {
  const name = clinicName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const topic = name ? question.replace(new RegExp(name, 'gi'), ' ').replace(/\s+/g, ' ').trim() : question;
  return topic.length >= 2 ? topic : question;
}
/** The number to call back: the one the caller gave, or else the number they are calling from. */
/** What to say when a number can't get texts: once, out loud instead, and never a hunt for another number. */
const NOT_TEXTABLE = 'This number can\'t get texts: it isn\'t a mobile number in the clinic\'s country. Say so in a few words and read it out slowly instead. Don\'t offer a text again on this call, and never ask for another number to text.';

const callbackNumber = (args: Record<string, unknown>, ctx: { callerNumber: string | null; clinic: ClinicConfig }, state?: CallState) =>
  heardPhone(ctx.clinic, args.callback_number) ?? ctx.callerNumber ?? rememberedNumber(state, ctx.clinic);
/** A number the caller already gave on this call, read back or said for the call back: never asked for again (11-16). */
const rememberedNumber = (state: CallState | undefined, clinic: ClinicConfig): string | null => {
  const n = state?.memory.get('number');
  return n && n.digits.length >= 7 ? heardNumber(clinic, n.digits) : null;
};
/** A number the caller said, as E.164 like every number on file (as said when it isn't a whole one); null when none was said. */
const heardPhone = (clinic: ClinicConfig, said: unknown): string | null =>
  typeof said === 'string' && said.trim() ? heardNumber(clinic, said) : null;

/**
 * A number the caller said is read back in groups before it is searched, and searched only after their yes: one said
 * number was found only on the second try (a test call), and "double eight, triple five" is easy to mishear. The number
 * they are calling from needs no read-back. Null when the search may go ahead.
 */
function readBackFirst(said: unknown, phone: string, state: CallState, ctx: CallContext, lang: CallState['language']): ToolResult | null {
  if (typeof said !== 'string' || !said.trim()) return null;
  // a number that isn't a whole one here is read back once as given, and kept (withPhoneAsGiven)
  if (!wholeNumber(ctx.clinic, phone)) return null;
  const digits = phone.replace(/\D/g, '');
  if (ctx.callerNumber && samePhone(phone, ctx.callerNumber, ctx.clinic)) return null;
  if (state.phonesConfirmed.has(digits)) return null;
  if (state.confirmedReadback(digits)) { state.phonesConfirmed.add(digits); state.memory.confirmNumber(digits); state.phoneReadback = null; return null; }
  // a read-back the caller said was wrong: another number after it, or a no to it. After two, the second way (2026-11-15:
  // a number said with its country prefix was read back three times and the call gave up)
  // (each read-back counts once: a no to it starts a fresh one, even of the same digits)
  countWrongReadback(state, digits);
  if (state.readbacksWrong >= WRONG_READBACKS && !state.lastFourAsked && industryPack(ctx.clinic.industry).identity === 'pet') return askLastFour(state, lang, 'wrong_readbacks');
  const asked = state.phoneReadback?.digits === digits && state.phoneReadback.askedAtMs !== null;
  if (!asked) state.phoneReadback = { digits, atMs: state.lastMs(), askedAtMs: null };
  return refuse('confirm_number', `Before searching, read the number back once, in these words: "${PACKS[lang].phoneReadback({ grouped: groupedNumber(ctx.clinic, phone) })}" On a yes, call this again with the same number. On a no, ask for the number again and call this with the new one.${asked ? ' They have not said yes to it yet.' : ''}`);
}
/** Read-backs the caller says are wrong before the second way to find the profile is asked. */
export const WRONG_READBACKS = 2;
/** A no, first, to a read-back: "no", "nope", "that's wrong", "no, es otro". */
const SAID_NO = /^(?:no|nope|nah|wrong|that'?s (?:not (?:it|right)|wrong)|incorrect|incorrecto|esta mal|ese no)\b/;
/**
 * Counts the read-back waiting for an answer as wrong when the caller's answer says so: a no to it, or (when `digits`, a
 * number given since, differs from it) anything but a clear yes. Each read-back counts once: a no starts a fresh one.
 */
function countWrongReadback(state: CallState, digits: string | null) {
  const last = state.phoneReadback;
  if (!last || last.askedAtMs === null) return;
  // the caller's first words after it are the answer to it ("No, that one neither.", then "0174, Luna.")
  const answer = normalise(state.turns.find((t) => t.speaker === 'caller' && t.startMs > last.askedAtMs!)?.text ?? '');
  if (digits !== null && last.digits !== digits ? answer !== '' && !isClearYes(answer, LANGUAGES) : SAID_NO.test(answer)) { state.readbacksWrong++; state.phoneReadback = null; }
}
/** The second way to find a pet's profile, asked once: the last four digits of the number on file and the pet's name. */
function askLastFour(state: CallState, lang: CallState['language'], after: 'wrong_readbacks' | 'no_profile'): ToolResult {
  state.lastFourAsked = after;
  state.phoneReadback = null;
  return refuse('ask_last_four', `Ask, in these words: "${PACKS[lang].lastFourQuestion({ after })}" When they answer, call verify_caller with phone_last4 (the four digits as they said them), pet_name, and phone null. Never say a number or a name from the records.`);
}
const NO_CALLBACK_NUMBER = (lang: CallState['language']) => refuse('no_callback_number', `Say you can't see the number they're calling from, and ask, in these words: "${PACKS[lang].callbackNumberQuestion}" Then call this again with it.`);
const MEDICAL = () => refuse('medical_question', `Do not answer it, and do not read anything from the clinic's documents. Say: "${MEDICAL_REFUSAL}" Offer to take a callback.`);

const refuse = (code: string, say: string): ToolResult => ({ ok: false, data: { error: code, say } });
/** The animals a vet lists, for the caller ("dogs and cats"), in the call's language where the clinic gave one. */
const seesAnimals = (p: { categories: string[]; categoryNames?: Record<string, string> | undefined }, lang: CallState['language']): string | null => {
  const names = p.categories.map((c) => (lang !== 'en' && p.categoryNames?.[c]) || c).map((c) => c.toLowerCase());
  return names.length ? names.join(lang === 'es' ? ' y ' : ' and ') : null;
};

/**
 * No caller ID (a browser test call, a hidden number): the one question for a number, in the caller's language, asked
 * once. At a clinic for animals it is the number the pet's profile is under, for a new pet too (its profile will be
 * under it); the best number to reach someone is for callbacks only (2026-11-14).
 */
const askPhone = (lang: CallState['language'], pets = true) => `Ask once, in these words: "${pets ? PACKS[lang].profileNumberQuestion({ last4: null }) : PACKS[lang].callbackNumberQuestion}" Keep everything else they already gave; do not ask for it again.`;
/** A time the caller chose, as the planner hears it: when, and with whom. */
const choiceOf = (slot: Slot, clinic: ClinicConfig, lang: CallState['language'], now?: Date) => {
  const provider = clinic.providers.find((p) => p.id === slot.providerId);
  return `${speakSlot(slot.start, clinic.timezone, lang, now)}${provider ? ` with ${providerName(provider, lang)}` : ''}`;
};
/**
 * Once the pet or patient is found or added: the time they chose before, looked for again (it may have gone meanwhile, and
 * the visit may now be a new patient's) and read back as a question, never dropped and never said to be done.
 */
const chosenNote = (state: CallState, clinic: ClinicConfig, lang: CallState['language'], now?: Date): { say?: string } => {
  const slot = state.chosen;
  if (!slot) return {};
  const local = localParts(slot.start, clinic.timezone);
  const time = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
  return { say: ` Before this, the caller chose ${choiceOf(slot, clinic, lang, now)}. Look for it again now with find_slots (from_date ${local.date}, from_time ${time}, provider_id ${slot.providerId}); if it is still free, propose_booking it, so it is read back as a question for their yes. If it was taken meanwhile, say so and offer the times find_slots returns.` };
};

/** What to ask when a date of birth is refused: the one part that is wrong, keeping everything else the caller said. */
function dobAgain(said: string, now: Date, monthFirst: boolean): string {
  const problem = dobProblem(said, now, monthFirst ? 'mdy' : 'dmy');
  return problem
    ? `Say that ${problem}, and ask them to check the date of birth. Keep the name and phone they already gave; do not ask for them again.`
    : 'Ask for the date of birth again, month, day and year. Keep the name and phone they already gave; do not ask for them again.';
}

const northAmerica = (clinic: ClinicConfig) => clinic.phoneNumbers[0]!.startsWith('+1');
/** A whole phone number for the clinic's country: ten digits in North America, at least seven elsewhere. */
const wholeNumber = (clinic: ClinicConfig, phone: string) => phone.replace(/\D/g, '').length >= (northAmerica(clinic) ? 10 : 7);
/** A number for the team as the caller gave it, marked when it may not be enough to call. */
const asGiven = (clinic: ClinicConfig, phone: string) => (wholeNumber(clinic, phone) ? phone : `${phone} (as given, may be incomplete)`);
/**
 * A number given for an identity check or a new record that is not a whole number for the clinic's country (a number
 * abroad, one without its area code) is read back once, as given, and kept: the call goes on with it. A caller abroad
 * was asked for "the full number with the area code" again and again (a test call, 2026-10-26).
 */
function withPhoneAsGiven(result: ToolResult, rawArgs: unknown, state: CallState, ctx: CallContext): ToolResult {
  const given = (rawArgs as { phone?: unknown } | null)?.phone;
  // as digits ("seven two oh, triple five" is 720555): words are not "not a whole number"
  const phone = typeof given === 'string' && given.trim() ? spokenDigits(given.trim()) : null;
  if (!phone || wholeNumber(ctx.clinic, phone) || result.data.error === 'invalid_arguments') return result;
  const digits = phone.replace(/\D/g, '');
  if (state.phoneAsGiven === digits) return result;
  state.phoneAsGiven = digits;
  const line = `The number they gave is not a whole number here, so it is kept as they gave it. Read it back once, in these words: "${PACKS[state.language].phoneAsGiven({ digits: phone })}" Then carry on; never ask for the number again or for its area code.`;
  return { ...result, data: { ...result.data, say: [line, typeof result.data.say === 'string' ? result.data.say : ''].filter(Boolean).join(' ') } };
}
const sameFirstWord = (spoken: string, firstName: string) => fold(spoken).toLowerCase().split(/\s+/)[0] === fold(firstName).toLowerCase().split(/\s+/)[0];
const key = (...parts: (string | number)[]) => createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 32);

/**
 * Runs one tool call for the planner. The rules the product promises are enforced
 * here, in code, whatever the model asks for:
 *  - nothing patient-specific before the patient is verified by name, DOB and phone;
 *  - a new patient is added only after the check found nobody, and books new-patient visits;
 *  - only doctors who see the patient's age, and take new patients when they are new, are offered;
 *  - a booking can only use a slot the caller was actually offered;
 *  - no write without a spoken read-back and a clear yes to it in the caller's own words;
 *  - every write carries an idempotency key, so a retry cannot book twice;
 *  - work for an outdated request, or after an emergency, is refused;
 *  - refills and callbacks become staff tasks, never decisions.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hoursText = (w: { open: string; close: string }[]) => w.map((x) => `${x.open} to ${x.close}`).join(' and ');

/**
 * What else about the day or the provider the caller asked for the assistant says before the times: a closed day (a
 * holiday or a special day with a reason) when nobody searched works it, a day with shorter hours, a provider away
 * until a date, or notice needed. The provider's own days and hours are find_slots' reason and say_as (dayReason,
 * vetHoursLine), from the same hours the search used. Null when the day and the provider asked for are fine.
 */
export function whyNot(clinic: ClinicConfig, q: { date: string | null; provider?: Provider; providers?: Provider[]; noticeHours?: number; now: Date; today: string }): string | null {
  const reasons: string[] = [];
  const date = q.date && q.date > q.today ? q.date : null;
  if (date) {
    const special = specialDayOf(clinic, date);
    const open = windowsOnDate(clinic, date);
    const name = DAY_NAMES[weekdayOf(date)]!;
    const searched = q.providers ?? (q.provider ? [q.provider] : clinic.providers);
    // a vet who keeps their own hours that day (a Sunday, a holiday the special day lists them for) is no closed day
    const someoneIn = searched.some((p) => bookableWindows(clinic, p, date).windows.length);
    const closedDay = special ? !special.windows.length : clinic.holidays.includes(date);
    if (!open.length && (closedDay || !someoneIn)) reasons.push(`The clinic is closed on ${name} ${date}${special?.note ? ` (${special.note})` : clinic.holidays.includes(date) ? ' (a holiday)' : ''}.`);
    else if (special && open.length) reasons.push(`On ${name} ${date} the clinic is open ${hoursText(open)} only${special.note ? ` (${special.note})` : ''}.`);
    if (q.provider) {
      const off = q.provider.timeOff.find((t) => !t.start && date >= t.from && date <= t.to);
      if (off) reasons.push(`${providerName(q.provider)} is away ${off.from === off.to ? `on ${off.from}` : `from ${off.from} to ${off.to}`}${off.note ? ` (${off.note})` : ''}, back on ${addDays(off.to, 1)}.`);
    }
  } else if (q.provider && awayOn(q.provider, q.today)) {
    const off = q.provider.timeOff.find((t) => !t.start && q.today >= t.from && q.today <= t.to)!;
    reasons.push(`${providerName(q.provider)} is away until ${off.to}${off.note ? ` (${off.note})` : ''}, back on ${addDays(off.to, 1)}.`);
  }
  if (q.noticeHours && q.noticeHours > 2) {
    const earliest = new Date(q.now.getTime() + q.noticeHours * 3_600_000);
    const first = localDateOf(earliest, clinic.timezone);
    if (!date || date < first) reasons.push(`This visit needs ${q.noticeHours} hours' notice, so the first day it can be booked for is ${first}.`);
  }
  return reasons.length ? `${reasons.join(' ')} Say this in a few words before the times.` : null;
}

/** The one listed vet a name fits (titles and articles dropped, accents folded): "Dr. Khan", "Vance", "la doctora Mara Vance". Null when none or several fit. */
export function providerNamed<P extends { id: string; name: string; placeholder?: boolean }>(providers: P[], said: string): P | null {
  const words = (t: string) => normalise(t).replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter((w) => w && !TITLES.has(w));
  const want = words(said);
  if (!want.length) return null;
  const fits = providers.filter((p) => !p.placeholder && want.every((w) => words(p.name).includes(w)));
  return fits.length === 1 ? fits[0]! : null;
}
const TITLES = new Set(['dr', 'dra', 'doctor', 'doctora', 'doc', 'the', 'la', 'el', 'vet', 'veterinarian', 'veterinaria', 'veterinario']);

/** A listed vet named with a day ("Dr. Vance on Tuesday", "la doctora Vance el martes"), in the caller's words or the question. */
const DAY_WORD = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|weekend|lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana)\b/;
export function vetDayAsked(clinic: Pick<ClinicConfig, 'providers'>, text: string): boolean {
  const t = normalise(text);
  if (!DAY_WORD.test(t)) return false;
  const words = new Set(t.replace(/[^a-z\s'-]/g, ' ').split(/\s+/));
  return bookableProviders(clinic.providers).some((p) => normalise(p.name).replace(/[^a-z\s'-]/g, ' ').split(/\s+/).some((w) => w.length > 2 && !TITLES.has(w) && words.has(w)));
}
export const VET_DAY_NOTE = 'Whether this vet is in, away, fully booked or free on that day comes only from find_slots with their provider_id and that from_date: call it now and say its say_as. Never work it out from these hours, and never say the clinic is closed on a day the vet works.';

/** Words that ask where the clinic is, or for its address or directions (EN/ES). */
const WHERE = /\b(?:address|where (?:are you|exactly|is the clinic|is your clinic)|where's the clinic|located|location|directions|find you|get there|direcci[oó]n|d[oó]nde (?:est[aá]n|queda|est[aá] la cl[ií]nica)|ubicaci[oó]n|ubicad[oa]s?|c[oó]mo llego|c[oó]mo llegar)\b/i;
export const asksWhere = (text: string) => WHERE.test(text);

/** A "specialty" the model passed that names a visit type (any language) or no specialty at all ("general practice"). */
export function specialtyIsTheVisit(specialty: string, clinic: Pick<ClinicConfig, 'visitTypes'>): boolean {
  const t = normalise(specialty).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /^(?:general|general practice|general medicine|primary care|any|medicina general|general practitioner|gp|consulta general)$/.test(t)) return true;
  // an animal is who the pet is, not a vet's specialty (the pet's kind already picks the vets who see it)
  if (/^(?:dogs?|cats?|puppy|puppies|kittens?|rabbits?|birds?|perros?|gatos?|conejos?|aves?|cachorros?)$/.test(t)) return true;
  return clinic.visitTypes.some((v) => [v.name, ...Object.values(v.names ?? {})].some((n) => {
    const name = normalise(n ?? '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return !!name && (name === t || name.includes(t) || t.includes(name));
  }));
}

export async function runTool(
  name: ToolName, rawArgs: unknown, state: CallState, ctx: CallContext, backend: Backend, revision = state.revision,
): Promise<ToolResult> {
  // what the call already established fills an argument the planner left out, so the caller is never asked for it again
  const { args, filled } = fillFromMemory(name, rawArgs, state.memory, { industry: ctx.clinic.industry, verifiedPatient: !!state.verifiedPatient, callerNumber: ctx.callerNumber, ownerOnFile: state.memory.verified ? state.memory.owner : null, timeZone: ctx.clinic.timezone });
  if (filled.length) ctx.log?.info({ call_id: ctx.callId, tool: name, filled_from_memory: filled }, 'arguments filled from the call memory');
  if (args && typeof args === 'object') state.memory.fromToolArgs(name, args as Record<string, unknown>, ctx.clinic, ctx.callerNumber, state.turns.length);
  const done = await toolCall(name, args, state, ctx, backend, revision);
  // what the tools said, for "why?" and for the claim guard (flow/guards.ts)
  const error = done.ok ? null : String((done.data as { error?: unknown }).error ?? 'refused');
  state.toolLog.push({ name, ok: done.ok, error });
  if (error) state.lastRefusal = { code: error, atTurn: state.turns.length };
  const result = filled.length ? { ...done, data: { ...done.data, filled_from_memory: filled } } : done;
  return name === 'verify_caller' || name === 'register_patient' ? withPhoneAsGiven(result, args, state, ctx) : result;
}

async function toolCall(name: ToolName, rawArgs: unknown, state: CallState, ctx: CallContext, backend: Backend, revision: number): Promise<ToolResult> {
  // the arguments the clinic's industry takes: a veterinary clinic finds a pet by its owner's name and its own
  const trade = industryPack(ctx.clinic.industry);
  const parsed = toolArgsFor(ctx.clinic.industry)[name].safeParse(rawArgs);
  // the arguments were the model's mistake, not the caller's: they are never asked to say it again for it
  if (!parsed.success) return refuse('invalid_arguments', `These arguments do not fit the tool (${parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean).join(', ') || 'their shape'}). Call it again with what the caller already said; ask the caller only for a detail they have not given yet.`);
  // an animal's red flag waits for the caller's answer to the one question: no times or booking for that pet until then
  const flagged = state.emergencyCase;
  // (a sign that may be mild, like limping, never holds a booking: a sick visit is often exactly what the caller wants)
  if (trade.identity === 'pet' && flagged && flagged.kind !== 'borderline' && (flagged.stage === 'flagged' || flagged.stage === 'asked') && WAITS_FOR_ANSWER.has(name)
    && aboutPetInDanger(name, parsed.data as Record<string, unknown>, state, flagged.pet)) {
    return refuse('pet_flagged', `The caller has not yet answered whether this is still an emergency. Do not look for times or book for ${flagged.pet?.name ?? 'this pet'}. If the question has not been asked, ask it now, word for word: "${EMERGENCY_LINES.question(state.language)}" and wait for the answer.`);
  }
  if (state.emergencyLocked && !EMERGENCY_ALLOWED.has(name)) {
    if (trade.identity !== 'pet') return refuse('emergency_in_progress', `Do not continue the task. Repeat that if this is an emergency they should call ${emergencyNumberFor(ctx.clinic, state.language)}.`);
    // where to take the animal comes first, and is said once (two test calls repeated the hospital four times)
    if (!state.emergencyScriptSaid) return refuse('emergency_in_progress', 'Do not continue the task yet. Say where to take the animal now, once, and that a person in danger should call ' + emergencyNumberFor(ctx.clinic, state.language) + '.');
    // After the pet warning has been said once, never a loop (a tester clinic, 2026-11-03): finding who they are and another pet's
    // needs go on as usual; a routine visit for the pet in danger stays refused, with the next step, the team now or an
    // urgent request for them. The hospital again only when the caller asks for it.
    if (aboutPetInDanger(name, parsed.data as Record<string, unknown>, state)) return petEmergencyNextStep(state, ctx);
  }
  // in an animal's emergency the on-call line is the clinic's own setting (emergencyTransferEnabled rings it once, by
  // itself): the planner never sends the caller there. A live run put a caller through to it unasked (2026-11-15)
  if (name === 'transfer_call' && (parsed.data as { target?: unknown }).target === 'on_call' && state.emergencyLocked && trade.identity === 'pet'
    && [...state.emergencyKinds].every((k) => isPetEmergency(k) || k === 'general')) {
    return state.emergencyScriptSaid ? petEmergencyNextStep(state, ctx)
      : refuse('emergency_in_progress', 'Do not transfer. Say where to take the animal now, once, and that a person in danger should call ' + emergencyNumberFor(ctx.clinic, state.language) + '.');
  }
  // an animal's emergency goes where the emergency machine sends it (the clinic's mode, after the caller's answer), never
  // through the voice model's own transfer: a live run on path A put callers through to the on-call line in refer mode and
  // after a clear no (batch 1b matrix)
  if (name === 'transfer_call' && (parsed.data as { target?: unknown }).target === 'on_call' && trade.identity === 'pet' && flagged) {
    if (flagged.stage === 'cleared') return refuse('emergency_cleared', 'The caller said it is not an emergency now. Do not transfer. Carry on with what they want; if it comes back, the clinic\'s line was already said.');
    if (flagged.stage === 'escalated') return state.emergencyScriptSaid ? petEmergencyNextStep(state, ctx) : refuse('emergency_in_progress', 'Do not transfer: the emergency is already being handled. Say only the line you were given.');
    return refuse('pet_flagged', `The caller has not yet answered whether this is still an emergency. Do not transfer. If the question has not been asked, ask it now, word for word: "${EMERGENCY_LINES.question(state.language)}" and wait for the answer.`);
  }
  if (WRITE_TOOLS.has(name) && revision !== state.revision) {
    return refuse('superseded', 'The caller has asked for something else since; do not act on this request.');
  }
  // a pet's visits only once it is found by its owner, its name and the phone: the number alone, or the owner's name, is not enough
  if (name === 'visit_summary' && !state.verifiedPatient) {
    return refuse('not_verified', 'Nothing about a pet\'s visits can be said before the pet is found. Find it first with verify_caller (the owner\'s first name, the pet\'s name, the phone), asking only for what the caller has not said yet; say nothing about any visit until then.');
  }
  // the record (next and last visit, the usual vet) only for a caller the number knows: caller ID, or the owner's name matched
  if (name === 'visit_summary' && trade.identity === 'pet' && !state.memory.verified) {
    return refuse('not_verified', 'Details from the pet\'s record (its visits, its vet) are given only once the pet is found under the owner\'s number and name. Say, kindly and in a few words, the real reason: for privacy you can only go into a pet\'s details once you have found them under the owner\'s number and name. Then say you can still book, move or cancel a visit, or have the team call back. Never say a name from the records.');
  }
  if (PATIENT_TOOLS.has(name) && !state.verifiedPatient) {
    // a time the caller chose before the pet or patient is found is kept, and read back once they are
    const chosen = name === 'propose_booking' ? state.offered.get(String((parsed.data as { slot_id?: unknown }).slot_id)) : undefined;
    if (chosen) state.chosen = chosen;
    const keep = chosen ? `The caller chose ${choiceOf(chosen, ctx.clinic, state.language, ctx.now())}: that choice is kept, and the backend says how to book it once ${trade.identity === 'pet' ? 'the pet is found or added' : 'they are found or added'}. Say you will book it right after that, never that it is done or taken care of. ` : '';
    return refuse('identity_required', keep + (trade.identity === 'pet'
      ? 'Before that, find the pet with verify_caller, or add it with register_patient when the caller said it is new, asking only for what the caller has not said yet (the owner\'s first name, the pet\'s name).'
      : 'Before that, ask for the caller\'s full name and date of birth.'));
  }
  // closed, at a clinic that takes requests out of hours: the team books in the morning. No
  // times are looked up either, so none is ever read out and then refused. A cancellation
  // still goes ahead: it frees a slot and needs no one's judgement.
  if ((name === 'find_slots' || name === 'propose_booking') && ctx.clinic.afterHours === 'requests' && !isOpen(ctx.clinic, ctx.now())) {
    return refuse('after_hours', 'The clinic is closed and books during opening hours only. Do not offer any times. Say so, and offer to take a request for the team to call back in the morning with create_callback: what they want, and the best number. Cancelling an existing visit is still fine.');
  }
  const { clinic } = ctx;
  const args = parsed.data as Record<string, unknown>;
  // what the caller said about who they are is kept for the planner, so nothing is asked twice
  if (name === 'verify_caller' || name === 'register_patient') state.remember(args);
  // never let a webhook problem undo or hold up what the caller was told
  const emit = (e: DomainEvent) => backend.events?.emit(clinic.id, e).catch((err: unknown) => ctx.log?.warn({ call_id: ctx.callId, type: e.type, err }, 'event not queued'));
  // everything said back to the caller is in the language they are speaking
  const lang = state.language;
  const pack = PACKS[lang];
  // said in full, on the call and in a text alike: "Wednesday, November 4, at 5:20 PM" (2026-11-14)
  const when = (start: Date) => speakSlot(start, clinic.timezone, lang, ctx.now());
  const whenDated = (start: Date) => speakSlot(start, clinic.timezone, lang);
  const nameOf = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? providerName(p, lang) : undefined; };
  /**
   * Where a confirmation text for this change would go, or null when none would: texting must be
   * on (its registration approved), the patient must have a phone, and changes and cancellations
   * follow the clinic's switch for them. A patient the assistant just added is texted only at the
   * number they are calling from, until the front desk checks them: nobody can have visits texted
   * to someone else's phone by making up a patient.
   */
  const confirmationTarget = (template: 'booking_confirmed' | 'change_confirmed' | 'cancel_confirmed'): 'calling' | 'file' | null => {
    const patient = state.verifiedPatient;
    if (!textingOf(clinic).enabled || !patient?.phone) return null;
    // a number that can't get texts (abroad, premium, toll-free) is never promised one
    if (!textableNumber(clinic, asE164(clinic, patient.phone))) return null;
    if (template !== 'booking_confirmed' && !textingOf(clinic).kinds.change_confirmed) return null;
    const calling = !!ctx.callerNumber && samePhone(ctx.callerNumber, patient.phone, clinic);
    if (patient.isNew && !calling) return null;
    return calling ? 'calling' : 'file';
  };
  /**
   * The names a text uses, when the call has them: the owner (a pet's) or the patient, the pet, the vet or
   * doctor, and the kind of visit, for pets only. Never an empty one.
   */
  const personal = (facts: { providerId?: string; visitTypeId?: string } = {}): Record<string, string> => {
    const p = state.verifiedPatient;
    const pets = clinic.industry === 'vet';
    const first = (s: string | null | undefined) => s?.trim().split(/\s+/)[0] ?? '';
    const name = first(pets ? state.verifiedOwner : p?.firstName);
    const provider = facts.providerId ? clinic.providers.find((x) => x.id === facts.providerId) : undefined;
    const visit = pets && facts.visitTypeId ? clinic.visitTypes.find((x) => x.id === facts.visitTypeId) : undefined;
    return {
      ...(name ? { name } : {}), ...(pets && p?.firstName ? { pet: p.firstName } : {}),
      ...(provider && provider.kind !== 'room' ? { provider: providerName(provider, lang) } : {}),
      ...(visit ? { visit: localName(visit, lang).toLowerCase() } : {}),
    };
  };
  /**
   * A confirmation text for a change just made. The read-back said it would come, so the caller's
   * yes is their consent to it; a caller who said no to the text gets none. The change stands
   * whatever happens to the text; it is never reported as failed.
   */
  const confirmByText = async (template: 'booking_confirmed' | 'change_confirmed' | 'cancel_confirmed', start: Date, appointmentId: string, visitFacts: { providerId?: string; visitTypeId?: string } = {}, declined = false, from: Date | null = null): Promise<boolean> => {
    const patient = state.verifiedPatient;
    if (declined || !patient?.phone || !confirmationTarget(template)) return false;
    try {
      const text = await backend.messenger.sendTemplate(clinic.id, {
        to: patient.phone, template, idempotencyKey: key(ctx.callId, template === 'booking_confirmed' ? 'sms' : template, appointmentId), language: lang,
        vars: { clinic: clinic.name, when: whenDated(start), ...(from ? { from: whenDated(from) } : {}), clinicPhone: callUsNumber(clinic), ...personal(visitFacts) },
        kind: 'auto', about: { callId: ctx.callId, patientId: patient.id, appointmentId },
      });
      if (text.status === 'not_sent') ctx.log?.info({ call_id: ctx.callId, reason: text.reason }, 'confirmation text not sent; the change stands');
      return text.status !== 'not_sent';
    } catch (err) {
      ctx.log?.warn({ call_id: ctx.callId, err }, 'confirmation text failed; the change stands');
      return false;
    }
  };

  switch (name) {
    case 'verify_caller': {
      if (trade.identity === 'pet') return verifyPet(args, state, ctx, backend, lang);
      // the number on their file, as they said it, or else the number they are calling from
      const phone = heardPhone(clinic, args.phone) ?? ctx.callerNumber;
      if (!phone) return refuse('phone_required', 'Ask for the phone number on their file, with the area code.');
      // numeric dates are month first only in North America
      const dob = parseDob(String(args.date_of_birth), ctx.now(), northAmerica(clinic) ? 'mdy' : 'dmy');
      if (!dob) return refuse('unclear_date_of_birth', dobAgain(String(args.date_of_birth), ctx.now(), northAmerica(clinic)));
      // the patient already verified: nothing to do. Someone else (a parent's second child) is checked like anyone
      const current = state.verifiedPatient;
      if (current && current.dob === dob && sameFirstWord(String(args.full_name), current.firstName)) return { ok: true, data: { verified: true, first_name: current.firstName } };
      if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
      }
      const tried = identityKey(String(args.full_name), dob, phone.replace(/\D/g, '').slice(-10));
      if (state.identitiesTried.has(tried)) return triedAgain(state, 'the patient');
      const found = await backend.patients.findByIdentity(clinic.id, String(args.full_name), dob, phone);
      if (found.status === 'found') {
        if (current?.id !== found.patient.id) { state.pending = null; state.offered.clear(); }
        state.verifiedPatient = found.patient;
        state.newFromTurn = state.turns.length;
        return { ok: true, data: { verified: true, first_name: found.patient.firstName, age: ageOn(found.patient.dob, localDateOf(ctx.now(), clinic.timezone)), ...chosenNote(state, clinic, lang, ctx.now()) } };
      }
      state.verifyAttempts++;
      if (found.status === 'ambiguous') return refuse('needs_staff', 'Say you need a colleague to confirm their record, and offer a callback.');
      state.notFound = true;
      state.identitiesTried.add(tried);
      // same answer for "no such patient", "wrong DOB" and "wrong phone": never confirm a record exists
      return refuse('not_verified', `Say you could not find a match. ${state.identitiesTried.size > 1 ? 'They have given these details before: do not ask again whether they are new.' : 'If they have not said whether they are new to the clinic, ask that first: someone new is added with register_patient.'} Someone who is not new is asked to spell their last name and repeat their date of birth and the phone number on their file, one detail at a time. ${triesLeft(state)}`);
    }

    case 'register_patient': {
      if (trade.identity === 'pet') return registerPet(args, state, ctx, backend, emit, lang);
      // a new patient is added only after the check found nobody, and never as a way round its limit
      if (!state.notFound) return refuse('verify_first', 'First look them up with verify_caller: name, date of birth and the phone on file.');
      if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
      if (state.registrations >= MAX_REGISTRATIONS) return refuse('too_many_registrations', 'Say the front desk will help with anyone else, and offer a callback.');
      const phone = heardPhone(clinic, args.phone) ?? ctx.callerNumber;
      if (!phone) return refuse('phone_required', askPhone(lang, false));
      const dob = parseDob(String(args.date_of_birth), ctx.now(), northAmerica(clinic) ? 'mdy' : 'dmy');
      if (!dob) return refuse('unclear_date_of_birth', dobAgain(String(args.date_of_birth), ctx.now(), northAmerica(clinic)));
      const today = localDateOf(ctx.now(), clinic.timezone);
      const age = ageOn(dob, today);
      const guardian = (args.guardian_name as string | null)?.trim() || null;
      if (age < 18 && !guardian) return refuse('guardian_required', 'They are under 18: ask for the name of the parent or guardian.');
      const first = String(args.first_name).trim();
      const last = String(args.last_name).trim();
      const gender = args.gender as Gender;
      const result = await backend.patients.register(clinic.id, { firstName: first, lastName: last, dob, gender, phone, guardianName: guardian, callId: ctx.callId });
      if (result.status === 'limited') return refuse('daily_registration_limit', 'Say the front desk will help add anyone else, and offer a callback.');
      if (state.verifiedPatient?.id !== result.patient.id) { state.pending = null; state.offered.clear(); }
      state.verifiedPatient = result.patient;
      state.newFromTurn = state.turns.length;
      // the same details as someone on file: as good as a verification, and counted like one, so it is no way round the limit
      if (result.status === 'exists') { state.verifyAttempts++; return { ok: true, data: { verified: true, first_name: result.patient.firstName, age, already_a_patient: true, say: `They are already a patient here: carry on as for any patient.${chosenNote(state, clinic, lang, ctx.now()).say ?? ''}` } }; }
      state.registrations++;
      // the front desk checks every patient the assistant adds
      const task = await backend.tasks.create(clinic.id, {
        type: 'review', callId: ctx.callId, patientId: result.patient.id,
        idempotencyKey: key(ctx.callId, 'review', result.patient.id),
        details: {
          reason: 'New patient added by the assistant. Check their details and confirm them.',
          first_name: first, last_name: last, date_of_birth: dob, gender: genderWord(gender), phone: asGiven(clinic, phone),
          ...(guardian ? { guardian_name: guardian } : {}),
          ...(result.similar ? { possible_duplicate: 'Another patient has the same name and date of birth with a different phone number.' } : {}),
        },
      });
      if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, number: task.number, type: 'review', patientId: result.patient.id, callId: ctx.callId } });
      const newVisits = clinic.visitTypes.filter((v) => v.audience !== 'existing').map((v) => localName(v, lang));
      return { ok: true, data: { registered: true, first_name: first, age, say: `They are now registered as a new patient. A first visit is usually ${newVisits.find((v) => /new/i.test(v)) ?? newVisits[0]}: ${state.chosen ? `use it for the time they chose.${chosenNote(state, clinic, lang, ctx.now()).say}` : `look for its times now, with any provider, unless they asked for something else (${newVisits.join(', ')}). Do not ask which provider.`}` } };
    }

    case 'get_clinic_info': {
      const question = String(args.question);
      // the medical-advice rule wins over anything the FAQ or a document says. It checks
      // what the caller said too: the model may pass on a question it has softened
      // "which vet is good for allergies?" is clinic information (who is listed for what), not medical advice (11-16)
      const whichVet = asksWhichVet(question);
      if (!whichVet && (isMedicalQuestion(question) || isMedicalQuestion(state.recentCallerText(), { quantities: false }))) return MEDICAL();
      // not about the clinic (the weather, how the assistant is made): the one polite line, nothing searched (batch 2)
      const outOfScope = outOfScopeLine(question);
      if (outOfScope && !whichVet) return { ok: true, data: { passages: [], say: `Say exactly: "${outOfScope}"` } };
      const hours = todaysHoursLine(clinic, ctx.now());
      const topic = topicOf(question, clinic.name);
      const answer = answerFromFaqs(clinic.faqs, topic);
      const passages = !answer && backend.knowledge ? await backend.knowledge.search(clinic.id, topic) : [];
      // a question about the clinic (its hours, doctors, visits, or its own answers) is a call the assistant handled
      if (state.outcome === 'abandoned') state.outcome = 'info';
      // an answer from the clinic's own list may be texted afterwards, by its id
      if (answer) state.answersGiven.add(answer.id);
      const texting = textingOf(clinic);
      const today = localDateOf(ctx.now(), clinic.timezone);
      return {
        ok: true,
        data: {
          today: hours, next_7_days: weekHours(clinic, ctx.now()),
          // asked whether the call is recorded: the clinic's own setting, never a guess
          call_recording: clinic.recording?.enabled ? 'on: callers hear a notice at the start of the call' : 'off: calls are not recorded; a transcript and a summary are kept for the clinic',
          // the days the clinic has marked closed in the next four months, for "are you open on Thanksgiving?"
          closed_days_ahead: closedDaysAhead(clinic, today),
          // and its shorter days after this week, for "are you open on Christmas Eve?"
          ...(specialHoursAhead(clinic, today).length ? { special_hours_ahead: specialHoursAhead(clinic, today) } : {}),
          answer: answer?.answer ?? null, source: answer?.id ?? null,
          ...(clinic.address ? { address: clinic.address } : {}), ...(clinic.website ? { website: clinic.website } : {}),
          // the clinic's own line, the one its clients know, for "what's your number?"
          phone: callUsNumber(clinic),
          // where an animal goes when the clinic cannot see it, for a caller who asks before they need it
          ...(emergencyHospitalFacts(clinic).length ? { emergency_hospitals: emergencyHospitalFacts(clinic) } : {}),
          // who works here: anyone may ask, so it carries no patient data
          providers: providerFacts(clinic, today, lang), specialties: specialtyFacts(clinic, lang), visit_types: visitTypeFacts(clinic, lang),
          // which vet sees what: the vets' listed specialties and animals, said as clinic information; the medical side is the team's
          // "is Dr. Vance in on Tuesday?": the vet's day from the schedule, never worked out from these hours (live runs said
          // "she's away Friday" of a vet who was fully booked, and "the clinic is closed on Sundays" of a vet who works them)
          ...(vetDayAsked(clinic, `${question} ${state.lastTurn('caller')}`) ? { vet_day: VET_DAY_NOTE } : {}),
          ...(whichVet ? { which_vet: `Answer from the providers' listed specialties and the animals they see, in a sentence or two ("Dr. Green's listed specialty is dermatology"). Say plainly that the team decides the medical side; say nothing about the condition itself. If none is listed for it, say so and offer a visit with any of them.` } : {}),
          ...(currentOffers(clinic, today).length ? { current_offers: currentOffers(clinic, today) } : {}),
          ...(clinic.requestTopics?.length ? { request_topics: requestTopicFacts(clinic) } : {}),
          // what may be texted on request: offered only after the caller has heard it
          ...(texting.enabled ? { texting: { kinds: (['directions', 'hours', 'emergency_hospital', 'provider', 'answer', 'link'] as const).filter((k) => texting.kinds[k]), links: texting.links.map((l) => ({ id: l.id, label: l.label, when: l.when })) } } : {}),
          ...(passages.length ? { passages: passages.map((p) => ({ title: p.title, text: p.text })) } : {}),
        },
      };
    }

    case 'search_knowledge': {
      const question = String(args.question);
      if (isMedicalQuestion(question) || isMedicalQuestion(state.recentCallerText(), { quantities: false })) return MEDICAL();
      const outOfScope = outOfScopeLine(question);
      if (outOfScope) return { ok: true, data: { passages: [], say: `Say exactly: "${outOfScope}"` } };
      const topic = topicOf(question, clinic.name);
      const passages = backend.knowledge ? await backend.knowledge.search(clinic.id, topic) : [];
      if (!passages.length) {
        // the clinic's own common questions (the address, parking) answer it as well as a document would
        const answer = answerFromFaqs(clinic.faqs, topic);
        if (answer) {
          state.answersGiven.add(answer.id);
          if (state.outcome === 'abandoned') state.outcome = 'info';
          return { ok: true, data: { passages: [], answer: answer.answer, source: answer.id, say: `This is one of the clinic's common questions. If it answers theirs, answer from it in a sentence or two, in the caller's language; if not, say: "${NO_INFORMATION}" Never add advice of your own.` } };
        }
        return { ok: true, data: { passages: [], say: `Nothing in the clinic's documents answers this. For the hours, the address or the ${trade.identity === 'pet' ? 'vets' : 'doctors'}, use get_clinic_info. Otherwise say: "${NO_INFORMATION}" Offer to take a callback.` } };
      }
      if (state.outcome === 'abandoned') state.outcome = 'info';
      return {
        ok: true,
        data: {
          passages: passages.map((p) => ({ title: p.title, text: p.text })),
          say: 'Answer only from these passages, in a sentence or two, in the caller\'s language. If they do not answer the question, say you do not have that information and offer a callback. Never add advice of your own.',
        },
      };
    }

    case 'find_slots': {
      const visitType = clinic.visitTypes.find((v) => v.id === args.visit_type_id);
      if (!visitType) return refuse('unknown_visit_type', `Ask which of these they need: ${clinic.visitTypes.map((v) => localName(v, lang)).join(', ')}.`);
      // the clinic books this one itself: a request for the team, never a time from the assistant
      if (visitType.staffOnly) {
        // why, the notice the clinic set, then both next steps (a test call asked for surgery and heard only "not the surgery itself")
        const related = relatedBookable(clinic, visitType);
        const line = PACKS[lang].teamBooks({ visit: localName(visitType, lang), notice: visitType.noticeHours ? noticeWords(visitType.noticeHours) : null, related: related ? localName(related, lang) : null });
        return refuse('staff_books', `Say, in these words: "${line}" A request: create_callback with topic "${localName(visitType, lang)}", and in the reason the pet and the timing they want.${related ? ` The other visit: find_slots with visit_type_id ${related.id}.` : ''}`);
      }
      const patient = state.verifiedPatient;
      // a caller who said they (or the pet) are new is looked for with a new patient's visit from the start, so a time they pick still fits once they are added
      if ((patient?.isNew || (!patient && state.saidNew() === 'new')) && visitType.audience === 'existing') {
        return refuse('new_patient_visit_type', `New patients book one of these first: ${clinic.visitTypes.filter((v) => v.audience !== 'existing').map((v) => localName(v, lang)).join(', ')}.`);
      }
      if (patient && !patient.isNew && visitType.audience === 'new') {
        return refuse('existing_patient_visit_type', `They are already a patient. Offer one of these: ${clinic.visitTypes.filter((v) => v.audience !== 'new').map((v) => localName(v, lang)).join(', ')}.`);
      }
      // a vet named the way the caller says it ("Dr. Khan", "Vance", "la doctora Vance") is that vet when only one fits:
      // a live run lost a model round on unknown_provider for "Dr. Khan" on almost every vet-specific request (batch 1c)
      if (args.provider_id && !clinic.providers.some((p) => p.id === args.provider_id)) {
        const named = providerNamed(clinic.providers, String(args.provider_id));
        if (named) args.provider_id = named.id;
      }
      let providers = args.provider_id ? clinic.providers.filter((p) => p.id === args.provider_id) : bookableProviders(clinic.providers);
      if (args.provider_id && !providers.length) return refuse('unknown_provider', `No vet here is called that. The vets: ${bookableProviders(clinic.providers).map((p) => `${providerName(p)} (${p.id})`).join(', ')}.`);
      // a vet named who does not do this visit: the true reason, and who does (a caller heard "fully booked for two weeks")
      if (args.provider_id && !providers[0]!.visitTypeIds.includes(visitType.id)) {
        const line = doesntDoType(clinic, providers[0]!, visitType, lang);
        // the planner often guesses the visit (a check-up) when the caller named only the vet: then the vet's own visits
        // are the next look, not other vets (live evals: "Dr. Vance doesn't do wellness exams" to a caller with a sick dog)
        const theirs = providers[0]!.visitTypeIds.filter((id) => clinic.visitTypes.some((v) => v.id === id && !v.staffOnly));
        return { ok: true, data: { slots: [], reason: 'doesnt_do_type', say_as: line, their_visit_type_ids: theirs,
          note: `If the caller named this visit, say say_as as written; on a yes, find_slots again with the vet they pick, or with provider_id null for any of them. If you chose the visit yourself, do not say say_as: call find_slots again with this vet and the one of their_visit_type_ids that fits what the caller described (${theirs.join(', ')}), or ask what the visit is for.` } };
      }
      // the kind of doctor or department the caller asked for, matched to the clinic's own list only
      // a clinic that lists no specialties or categories for anyone: everyone sees everything
      // a specialty that is really the visit ("dental care" with vt_dental) or no specialty at all ("general practice")
      // narrows nothing: a live run told a caller "no doctor here is listed for dental care" while two vets did dental
      // visits (batch 1c)
      if (args.specialty && specialtyIsTheVisit(String(args.specialty), clinic)) args.specialty = null;
      if (args.specialty && providers.some((p) => p.specialty || p.categories.length)) {
        providers = providers.filter((p) => matchesSpecialty(p, String(args.specialty)));
        if (!providers.length) {
          const list = specialtyFacts(clinic, lang).map((s) => `${s.specialty} (${s.doctors.join(', ')})`).join('; ');
          return refuse('no_provider_for_specialty', `No doctor here is listed for ${String(args.specialty)}. Say so, without guessing why, and offer what the clinic has: ${list}. Or offer a callback.`);
        }
      }
      // a caller who asks for a female or a male doctor
      if (args.provider_gender) {
        providers = providers.filter((p) => p.gender === args.provider_gender);
        if (!providers.length) return refuse('no_provider_of_gender', `No ${String(args.provider_gender)} doctor here offers that. Say so, and offer the clinic's other doctors.`);
      }
      // once we know who the visit is for: only doctors who see their age, and take new patients if they are new
      if (patient) {
        const age = ageOn(patient.dob, localDateOf(ctx.now(), clinic.timezone));
        providers = providers.filter((p) => seesAge(p, age) && (!patient.isNew || p.acceptingNewPatients));
        if (!providers.length) {
          return refuse('no_provider_for_patient', args.provider_id
            ? 'That doctor does not see this patient (their age, or they are not taking new patients). Offer the clinic\'s other doctors from get_clinic_info.'
            : 'None of the clinic\'s doctors can see this patient for that visit. Offer a callback.');
        }
      }
      // the clinic's rules for whoever the caller did not name (Settings, Booking rules)
      const rules = bookingOf(clinic);
      const named = !!args.provider_id;
      const asked = named || !!args.specialty || !!args.provider_gender;
      // a pet goes to a vet who sees its kind of animal; a vet who lists no animals sees them all
      if (!named && trade.identity === 'pet' && rules.matchAnimal && patient?.species) {
        const fit = providers.filter((p) => seesAnimal(p, patient.species!));
        if (!fit.length) {
          const only = providers.length === 1 ? providers[0] : undefined;
          return {
            ok: false,
            data: {
              error: 'no_provider_for_animal', say: `None of the clinic's vets is listed for a ${patient.species}. Say so, without guessing why, and offer a callback for the team to arrange it.`,
              // the whole answer, in the backend's words: the vet's limit, then the request offered
              spoken: pack.spoken.noVetForAnimal({ vet: only ? localName(only, lang) : null, animals: only ? seesAnimals(only, lang) : null, pet: patient.firstName }),
            },
          };
        }
        providers = fit;
      }
      const now = ctx.now();
      const today = localDateOf(now, clinic.timezone);
      // the clinic's today, in every answer, so no model counts days from a calendar of its own
      const todayIs = `${PACKS.en.fullDay(today)} (${today})`;
      // a day already gone is never searched from: a model with no date of its own (a Vapi call, 2026-11-09) searched
      // from a day two years back, heard "fully booked on Friday, June 7" and booked the wrong day
      if (args.from_date && String(args.from_date) < today) {
        return refuse('date_in_past', `Today at the clinic is ${todayIs}, so ${String(args.from_date)} has already gone. Work out the day the caller meant counting from today (clinic_now's days list has the dates) and call find_slots again with it, or with from_date null for the next openings. Never say a past date to the caller.`);
      }
      // "next Wednesday" said early in a week could be this week's or the next: asked once, never guessed
      const said = state.memory.fact('day');
      if (said?.source === 'caller' && said.value && 'either' in said.value && !state.memory.whichWeekAsked
        && (!args.from_date || said.value.either.includes(String(args.from_date)))) {
        state.memory.whichWeekAsked = true;
        const [first, second] = said.value.either;
        return refuse('which_week', `"Next ${DAY_NAMES[weekdayOf(first)]}" could be either. Ask once, in these words: "${pack.whichWeek({ first, second })}" Then call find_slots with the day they pick (${first} or ${second}).`);
      }
      const requested = (args.from_date as string | null) ?? today;
      const from = requested < today ? today : requested;
      // the clinic's booking window for this visit: how far ahead the assistant may book it
      const lastDay = visitType.maxDaysAhead ? addDays(today, visitType.maxDaysAhead) : null;
      if (lastDay && from > lastDay) {
        const line = pack.slots.tooFarAhead({ visit: localName(visitType, lang).toLowerCase(), days: visitType.maxDaysAhead!, lastDate: lastDay });
        return { ok: false, data: { error: 'too_far_ahead', reason: 'too_far_ahead', say_as: line, say: `Say, in these words: "${line}" Offer to look before then, or take a request for the team with create_callback.` } };
      }
      // a day the caller named is looked at up to 60 days on (its nearest times, then the same time on the next working
      // days); with no day, the next two weeks
      let days = args.from_date ? 60 : 14;
      while (lastDay && days > 1 && addDays(from, days - 1) > lastDay) days--;
      // and how much notice it needs: never under two hours
      const leadMinutes = Math.max(120, (visitType.noticeHours ?? 0) * 60);
      // busy time must cover the whole search window, however far out it starts
      const busy = await backend.scheduler.busy(clinic.id, providers.map((p) => p.id), now, zonedInstant(addDays(from, days + 1), '00:00', clinic.timezone));
      // and the patient's own visits: a time that overlaps one would only be refused as patient_busy after their yes
      // the visit being moved or changed is not in the way of itself: "make it a sick visit" keeps its 5:00 (a live
      // eval moved a visit to 5:30 because its own 5:00 looked taken)
      const moving = state.memory.get('intent') === 'move' ? state.memory.visit : null;
      if (moving) {
        for (let i = busy.length - 1; i >= 0; i--) if (busy[i]!.providerId === moving.providerId && busy[i]!.start.getTime() === moving.start.getTime()) busy.splice(i, 1);
      }
      // their visits still to come, other than one booked on this call or the one being moved: said before times for
      // another (note 45: a pet with a visit booked was offered a second one with no word about the first)
      const theirs: { id: string; providerId: string; visitTypeId: string; start: Date }[] = [];
      if (patient) {
        for (const a of await backend.scheduler.upcoming(clinic.id, patient.id, now)) {
          if (a.id === moving?.appointmentId) continue;
          if (a.id !== state.memory.visit?.appointmentId) theirs.push(a);
          for (const p of providers) busy.push({ providerId: p.id, start: a.start, end: a.end });
        }
      }
      const fromTime = (args.from_time as string | null) ?? undefined;
      // the caller's time and how they said it: "is 4 free?" or "around 5" looks either side of it, "earlier than 6" before
      // it, "after 3" after it, nearest first, on the day they named (a caller asked "earlier than 6" and heard the morning)
      const saidTime = state.memory.get('time');
      // with no mode from the planner or the caller's words, a time is the earliest they want, as before time_mode
      const mode = (args.time_mode as string | null) ?? (saidTime && saidTime.time === fromTime ? saidTime.mode : null) ?? 'after';
      const near = fromTime && mode !== 'earliest' ? { date: from, time: fromTime, direction: (mode === 'before' || mode === 'after' ? mode : 'around') as NearDirection } : undefined;
      // a move keeps its vet when they are free then: theirs first, ahead of the clinic's tie-break
      if (moving && !named && providers.some((p) => p.id === moving.providerId)) providers = [...providers.filter((p) => p.id === moving.providerId), ...providers.filter((p) => p.id !== moving.providerId)];
      const query = { visitType, from, days, now, leadMinutes, partOfDay: (near ? 'any' : args.part_of_day) as 'any', fromTime: near ? undefined : fromTime, near,
        // the nearest two to a time asked for: "not at 4, but 3:50 or 4:20"
        ...(near ? { limit: 2 } : {}), tieBreak: rules.tieBreak === 'fewest_visits' && !moving ? 'fewest' as const : 'order' as const };
      // with anyone: three different times, each with the vet the clinic's rule picks for it
      const anyone = findSlots(clinic, busy, { ...query, providers, distinctTimes: !named });
      let slots = anyone;
      const sameDay = anyone.filter((s) => localDateOf(s.start, clinic.timezone) === from);
      const target = near ? toMinutes(near.time) : 0;
      const exactSlot = near && near.direction !== 'before' ? sameDay.find((s) => localParts(s.start, clinic.timezone).minutes === target) : undefined;
      const hhmm = (s: Slot) => { const m = localParts(s.start, clinic.timezone).minutes; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
      const nearest = near && !exactSlot && sameDay.length
        ? ` Nothing is free at exactly ${fromTime} on ${PACKS.en.fullDay(from)}; the nearest that day are ${sameDay.map(hhmm).join(' and ')}: say so, then offer them.` : '';
      // why the day or the vet asked for gave nothing: the true reason, said before the times; nothing at all: up to which day
      const one = named || providers.length === 1 ? providers[0] : undefined;
      const reason = dayReason(clinic, { date: args.from_date as string | null, providers, found: anyone, noticeHours: visitType.noticeHours, visit: localName(visitType, lang).toLowerCase(), now, lang })
        ?? (anyone.length ? null : nothingFound(clinic, { providers, from, days, lang }));
      let note = anyone.length ? `Offer these as written, in the words of say_as. Do not invent other times.${nearest}` : 'No openings: say say_as as written, then offer a callback.';
      // nobody named: their usual vet first, when that vet is free soon enough
      // the usual vet is a fact of the record: said only to a caller the number knows
      const recordOpen = trade.identity !== 'pet' || !!state.memory.verified;
      if (!asked && patient && recordOpen && rules.noPreference === 'usual_first' && backend.scheduler.history) {
        const usualId = usualProviderOf(await backend.scheduler.history(clinic.id, patient.id, now), now);
        const usual = providers.find((p) => p.id === usualId);
        if (usual) {
          const until = addDays(from, rules.usualWithinDays - 1);
          const theirs = findSlots(clinic, busy, { ...query, providers: [usual] }).filter((s) => localDateOf(s.start, clinic.timezone) <= until);
          const name = nameOf(usual.id);
          if (theirs.length) {
            const sooner = anyone.find((s) => s.providerId !== usual.id && s.start.getTime() < theirs[0]!.start.getTime());
            slots = sooner ? [...theirs, sooner] : theirs;
            note = `The first ${theirs.length === 1 ? 'time is' : `${theirs.length} times are`} with ${name}, who usually sees ${patient.firstName}: offer ${theirs.length === 1 ? 'it' : 'them'} first.`
              + (sooner ? ` The last one, with ${nameOf(sooner.providerId)}, is sooner: mention it only if none of ${name}'s suit.` : '') + ' Do not invent other times.';
          } else if (anyone.length) {
            note = `${name}, who usually sees ${patient.firstName}, has nothing in the next ${rules.usualWithinDays} ${rules.usualWithinDays === 1 ? 'day' : 'days'}. Say so, offer these with other ${trade.identity === 'pet' ? 'vets' : 'doctors'}, and offer to look later for ${name} if they would rather wait.`;
          }
        }
      }
      for (const s of slots) state.offered.set(s.id, s);
      // the answer leads with "not at 9:30": the read-back need not say it again
      if (near && !exactSlot) state.askedTimeTold = near.time;
      // a caller who can't pick ("I don't know which time", "no sé qué hora"): the first one, for a yes. Live runs asked
      // them to choose again and again, then took a request or put them through to the desk (batch 1d)
      if (slots.length > 1) note += ` If the caller can't choose ("I don't know which", "any is fine", "no sé"), offer the first time alone, ${when(slots[0]!.start)}, and ask whether to book it; never ask them to pick again.`;
      // what else about the day or the vet asked for (closed, a half day, away, notice), for the planner to say in a few words
      const why = whyNot(clinic, { date: args.from_date as string | null, provider: one, providers, noticeHours: visitType.noticeHours, now, today });
      // the answer in the caller's language, the direct one first: "Yes, 4:00 PM ... is free", "Not at 4:00, but 3:50 or 4:20 PM"
      const outside = near && one && !exactSlot ? vetHoursLine(clinic, one, from, near.time, lang, near.direction) : null;
      // a visit they already have, once per call, before anything else, to a caller the record is open to
      const next = theirs.sort((a, b) => a.start.getTime() - b.start.getTime())[0];
      // never on a call about a visit they already have: a move or a cancel (said, or by the model), or their visits just
      // read out by list_appointments. A move is not a second booking (a new call that moved a pet's visit heard
      // "already has a visit booked" and "move it instead" in the middle of moving it)
      const intent = state.memory.get('intent');
      const aboutTheirVisit = !!moving || intent === 'move' || intent === 'cancel' || state.toolLog.some((t) => t.name === 'list_appointments' && t.ok);
      const booked = next && patient && !aboutTheirVisit && recordOpen && !state.upcomingSaid.has(patient.id)
        ? pack.slots.alreadyBooked({ name: patient.firstName, visit: (() => { const v = clinic.visitTypes.find((x) => x.id === next.visitTypeId); return v ? localName(v, lang).toLowerCase() : lang === 'es' ? 'cita' : 'visit'; })(), when: when(next.start), provider: nameOf(next.providerId) ?? null, more: theirs.length - 1 })
        : null;
      if (booked && patient) {
        state.upcomingSaid.add(patient.id);
        note = `${note} ${patient.firstName} already has a visit booked (the first line of say_as): say it first. If they would rather move that visit than book another, move it with propose_booking and replaces_appointment_id ${next!.id}.`;
      }
      const sayAs = [booked, reason?.line, outside, frontDeskLine(clinic, slots, lang)].filter((x): x is string => !!x);
      const askedTime = { hour: Math.floor(target / 60), minute: target % 60 };
      if (slots === anyone && exactSlot) sayAs.push(pack.slots.exactFree({ date: from, time: askedTime, provider: nameOf(exactSlot.providerId) ?? null }));
      else if (slots === anyone && near && sameDay.length) {
        const several = !named && new Set(sameDay.map((x) => x.providerId)).size > 1;
        const day = { date: from, times: [...sameDay].sort((x, y) => x.start.getTime() - y.start.getTime()).map((s) => { const m = localParts(s.start, clinic.timezone).minutes; return { hour: Math.floor(m / 60), minute: m % 60, provider: several ? nameOf(s.providerId) ?? null : null }; }) };
        // "not at 4, but..." for a time asked for; for "earlier than 6" or "after 3", simply the nearest on that side
        sayAs.push(outside || near.direction !== 'around' ? pack.slots.nearest({ day }) : pack.slots.notAt({ time: askedTime, day }));
      } else if (slots.length) sayAs.push(offerTimesLine(slots, clinic, lang));
      const found = slots.map((s) => ({ slot_id: s.id, when: when(s.start), provider: nameOf(s.providerId), specialty: clinic.providers.find((x) => x.id === s.providerId)?.specialty ?? null }));
      // the caller named one exact day and time and is already found: when it is free it is staged here and read back,
      // the one round where there were two (find, then propose). A time asked for ("is 5 free?") that is free is staged
      // the same way unless the planner said not to, so the caller's yes books it: a "yes, it's free, shall I book it?"
      // with nothing staged made the planner read it back again for a second yes (live evals). Anything else comes back
      // as the times to offer.
      const stage = !!patient && !!fromTime && (args.propose_if_exact === true ? !!args.from_date : args.propose_if_exact !== false && !!exactSlot && slots === anyone);
      if (stage) {
        const exact = exactSlot ?? slots.find((s) => localDateOf(s.start, clinic.timezone) === requested && localParts(s.start, clinic.timezone).minutes === toMinutes(fromTime!));
        if (exact) {
          const proposed = await runTool('propose_booking', { slot_id: exact.id, replaces_appointment_id: null }, state, ctx, backend, revision);
          // what is said before the read-back: the front-desk sentence for a time the vet keeps while the desk is closed
          const before = [booked, frontDeskLine(clinic, [exact], lang)].filter(Boolean).join(' ') || null;
          if (proposed.ok) {
            return { ok: true, data: { today: todayIs, slots: found, proposed_slot_id: exact.id, ...(near ? { exact: { time: near.time, free: !!exactSlot } } : {}), ...proposed.data,
              ...(before && typeof proposed.data.spoken === 'string' ? { spoken: `${before} ${proposed.data.spoken}`, say: `Say first, in these words: "${before}" Then: ${String(proposed.data.say)}` } : {}) } };
          }
        }
      }
      return {
        ok: true,
        data: {
          today: todayIs,
          slots: found,
          // the times in the caller's language, each day said once with its full date
          ...(sayAs.length ? { say_as: sayAs.join(' ') } : {}),
          // a time the caller named: whether it is free, so the answer leads with it
          ...(near ? { exact: { time: near.time, free: !!exactSlot } } : {}),
          ...(reason ? { reason: reason.code } : {}),
          note,
          ...(why ? { why_not_as_asked: why } : {}),
        },
      };
    }

    case 'list_appointments': {
      const upcoming = await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now());
      // the kind of visit too, so a reschedule looks for the same one
      return { ok: true, data: { appointments: upcoming.map((a) => {
        const visit = clinic.visitTypes.find((v) => v.id === a.visitTypeId);
        return { appointment_id: a.id, when: when(a.start), provider: nameOf(a.providerId), visit_type_id: a.visitTypeId, visit: visit ? localName(visit, lang) : null };
      }) } };
    }

    case 'visit_summary': {
      if (trade.identity !== 'pet') return refuse('not_available', 'Visit details are not given by phone here. Offer to have the team call them back.');
      const pet = state.verifiedPatient!;
      const now = ctx.now();
      const [upcoming, past] = await Promise.all([backend.scheduler.upcoming(clinic.id, pet.id, now), backend.scheduler.history?.(clinic.id, pet.id, now) ?? []]);
      // the newest past visit that took place (history leaves out cancelled ones), and the vet seen most
      const last = [...past].sort((a, b) => b.start.getTime() - a.start.getTime())[0];
      const usual = usualProviderOf(past, now);
      const visitName = (id: string | undefined) => { const v = id ? clinic.visitTypes.find((x) => x.id === id) : undefined; return v ? localName(v, lang) : null; };
      // reading a pet's visits on a call is an access to its record: audited before anything is handed over
      await backend.audit.record(clinic.id, { actor: 'voice-agent', action: 'patient.visits.read.call', entity: 'patient', entityId: pet.id, callId: ctx.callId });
      // a question about the pet's visits, answered, is a call the assistant handled
      if (state.outcome === 'abandoned') state.outcome = 'info';
      const lastSeen = last ? pack.lastVisitSeen({ pet: pet.firstName, when: when(last.start), provider: nameOf(last.providerId) ?? null, visit: visitName(last.visitTypeId) }) : null;
      // dates, vets and kinds of visit only: no reason, note or anything medical is in what comes back
      return {
        ok: true,
        data: {
          pet: pet.firstName,
          next_visits: upcoming.slice(0, 3).map((a) => ({ when: when(a.start), vet: nameOf(a.providerId) ?? null, visit: visitName(a.visitTypeId) })),
          last_visit: last ? { when: when(last.start), vet: nameOf(last.providerId) ?? null, visit: visitName(last.visitTypeId) } : null,
          usual_vet: usual ? nameOf(usual) ?? null : null,
          say: `Answer only what the owner asked, in a sentence, from these facts. ${lastSeen ? `A past visit is said this way: "${lastSeen}"` : 'No earlier visit is booked or recorded here: say you can\'t see one, never that there was none.'} Never read the visits out as a list unasked and never count them: only the last and the next. Nothing medical (what was found, results, medicines, doses, weights, notes, invoices) and no copy of the records: for those say "${pack.recordsOffer}", and on a yes take create_callback with the reason starting "Records request:".`,
        },
      };
    }

    case 'propose_booking': {
      const slot = state.offered.get(String(args.slot_id));
      if (!slot) return refuse('slot_not_offered', 'Only offer times returned by find_slots. Look up slots again.');
      const replaces = (args.replaces_appointment_id as string | null) ?? null;
      let replacing: string | null = null;
      let replacesStart: Date | null = null;
      if (replaces) {
        const current = (await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now())).find((a) => a.id === replaces);
        if (!current) return refuse('unknown_appointment', 'Use list_appointments to find the appointment being moved.');
        replacing = when(current.start);
        replacesStart = current.start;
      }
      const provider = nameOf(slot.providerId) ?? 'the provider';
      const providerKind = clinic.providers.find((x) => x.id === slot.providerId)?.kind ?? 'person';
      const visitType = clinic.visitTypes.find((v) => v.id === slot.visitTypeId);
      const visit = visitType ? localName(visitType, lang) : 'visit';
      // a move says both times in full, and how the day shifts when it does ("that's one week later, Wednesday, November 11")
      const shift = replacesStart ? dayShift(replacesStart, slot.start, clinic.timezone, lang) : null;
      const pet = trade.identity === 'pet' ? state.verifiedPatient?.firstName ?? null : null;
      const readback = pack.readbackBooking({ when: when(slot.start), provider, providerKind, visit, replacing, pet, shift });
      // the caller asked for another time ("9:30") and has not heard it is taken: said first, before the read-back of
      // the time on offer (a test call asked for 9:30 and heard 9:00 read back with no word about it; note 45, A3)
      const asked = state.memory.fact('time');
      const askedTime = asked?.source === 'caller' && (asked.value.mode === 'at' || asked.value.mode === 'around') ? asked.value.time : null;
      const notFree = askedTime && askedTime !== state.askedTimeTold && toMinutes(askedTime) !== localParts(slot.start, clinic.timezone).minutes
        ? pack.slots.askedNotFree({ time: { hour: Math.floor(toMinutes(askedTime) / 60), minute: toMinutes(askedTime) % 60 } }) : null;
      // the same change proposed again after it was read back keeps its read-back, so the yes the caller gave still counts
      const same = state.pending;
      if (same?.kind === 'book' && same.slot.id === slot.id && same.replacesAppointmentId === replaces && same.readbackAtMs !== null) {
        return { ok: true, data: { say: `This was already read back: ${readback}. If the caller said yes to it, call commit_pending now; otherwise ask for a clear yes.` } };
      }
      state.pending = { kind: 'book', slot, replacesAppointmentId: replaces, replacesStart, readback, seq: ++state.proposals, proposedAtMs: state.lastMs(), readbackAtMs: null, when: { start: slot.start, timeZone: clinic.timezone, now: ctx.now() } };
      state.chosen = null; // the time they chose is the one being read back now
      // the confirmation text is said before the yes, so the yes covers it and the caller can turn it down
      const target = confirmationTarget(replaces ? 'change_confirmed' : 'booking_confirmed');
      // said once a call: the caller heard it, and five read-backs of five times each with it were judged robotic
      const textNote = target && !TEXT_NOTE_SAID.has(state) ? pack.confirmTextNote({ target }) : null;
      // the voice already said this booking's day and time ("Monday at 3:30 with Dr. Ruiz, shall I book it?") and the
      // caller said yes to it: that was the read-back, and asking again was judged robotic (batch 1c live runs). Not for
      // a move (both times are read back), nor when a confirmation text still has to be mentioned and that line did not
      const lastAgent = [...state.turns].reverse().find((t) => t.speaker === 'agent');
      const after = lastAgent ? state.turns.filter((t) => t.speaker === 'caller' && t.startMs > lastAgent.startMs).map((t) => t.text).join(' ') : '';
      if (!replaces && lastAgent && saysSlot(lastAgent.text, slot.start, clinic.timezone, ctx.now()) && (!textNote || /\b(?:text|mensaje)/i.test(lastAgent.text))
        && after && isClearYes(after, clinic.languages)) {
        state.pending.readbackAtMs = lastAgent.startMs;
        if (textNote) TEXT_NOTE_SAID.add(state);
        return { ok: true, data: { say: `The caller already heard this and said yes: ${readback}. Call commit_pending now; do not read it back again.` } };
      }
      if (textNote) TEXT_NOTE_SAID.add(state);
      if (notFree) state.askedTimeTold = askedTime;
      const first = notFree ? `Say first, in these words: "${notFree}" Then: ` : '';
      return { ok: true, data: { say: `${first}${textNote ? `Read this back, say "${textNote}", and ask for a clear yes: ${readback}.` : `Read this back and ask for a clear yes: ${readback}.`}`, spoken: [notFree, pack.spoken.readback({ readback, textNote, move: !!replaces })].filter(Boolean).join(' ') } };
    }

    case 'propose_cancellation': {
      const upcoming = await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now());
      const appt = upcoming.find((a) => a.id === args.appointment_id);
      if (!appt) return refuse('unknown_appointment', 'Use list_appointments to find the appointment first.');
      const readback = pack.readbackCancel({ when: when(appt.start) });
      const same = state.pending;
      if (same?.kind === 'cancel' && same.appointmentId === appt.id && same.readbackAtMs !== null) {
        return { ok: true, data: { say: `This was already read back: ${readback}. If the caller said yes to it, call commit_pending now; otherwise ask for a clear yes.` } };
      }
      state.pending = { kind: 'cancel', appointmentId: appt.id, start: appt.start, readback, seq: ++state.proposals, proposedAtMs: state.lastMs(), readbackAtMs: null, when: { start: appt.start, timeZone: clinic.timezone, now: ctx.now() } };
      const target = confirmationTarget('cancel_confirmed');
      const textNote = target ? pack.confirmTextNote({ target }) : null;
      return { ok: true, data: { say: textNote ? `Ask them to confirm, with a clear yes, that you should ${readback}, and say "${textNote}".` : `Ask them to confirm, with a clear yes, that you should ${readback}.`, spoken: pack.spoken.cancelReadback({ readback, textNote }) } };
    }

    case 'commit_pending': {
      const pending = state.pending;
      if (!pending) return refuse('nothing_pending', 'There is nothing to confirm. Propose the change first.');
      if (pending.readbackAtMs === null) return refuse('not_read_back', `Read it back first: ${pending.readback}.`);
      // "yes, but no text": a yes to the change, and no confirmation text
      const answer = state.answerToReadback();
      const noText = declinesText(answer);
      if (!isClearYes(noText ? withoutTextRefusal(answer) : answer, clinic.languages)) return refuse('no_clear_yes', `Do not make the change yet. Ask again: ${pending.readback}?`);
      const patient = state.verifiedPatient!;

      if (pending.kind === 'cancel') {
        const cancelled = await backend.scheduler.cancel(clinic.id, { patientId: patient.id, appointmentId: pending.appointmentId, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'cancel', pending.appointmentId, pending.seq) });
        state.pending = null;
        if (cancelled.status === 'not_found') return refuse('unknown_appointment', 'Say you could not find that appointment and offer a callback.');
        state.outcome = 'cancelled';
        state.done.push(`cancelled ${pending.readback}`);
        if (cancelled.status === 'cancelled') {
          await emit({ type: 'appointment.cancelled', key: pending.appointmentId, data: { appointmentId: pending.appointmentId, patientId: patient.id, by: 'assistant', callId: ctx.callId, reason: 'patient_asked' } });
        }
        const smsSent = await confirmByText('cancel_confirmed', pending.start, pending.appointmentId, {}, noText);
        return { ok: true, data: { cancelled: true, sms_sent: smsSent, spoken: pack.spoken.done({ kind: 'cancelled', textSent: smsSent, then: pack.spoken.anythingElse }) } };
      }

      // booked on a number whose owner on file is not the name the caller gave: the team sees who booked it
      const byCaller = trade.identity === 'pet' ? state.memory.bookedByCaller : null;
      const result = await backend.scheduler.book(clinic.id, {
        patientId: patient.id, slot: pending.slot, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'book', pending.slot.id, pending.seq),
        replacesAppointmentId: pending.replacesAppointmentId,
        ...bookingNote(state, byCaller, clinic),
      });
      state.pending = null;
      if (result.status === 'slot_taken') {
        state.offered.delete(pending.slot.id);
        return refuse('slot_taken', 'That time was just taken. Apologise and look up slots again.');
      }
      if (result.status === 'patient_busy') {
        state.offered.delete(pending.slot.id);
        return refuse('patient_busy', 'They already have an appointment at that time. Say so, and offer another time.');
      }
      let oldStillActive = false;
      // the scheduler may have cancelled the old visit with the booking, in one step (an overlapping move)
      if (pending.replacesAppointmentId && !(result.status === 'booked' && result.replaced)) {
        const moved = await backend.scheduler.cancel(clinic.id, { patientId: patient.id, appointmentId: pending.replacesAppointmentId, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'replace', pending.replacesAppointmentId, pending.seq) });
        oldStillActive = moved.status === 'not_found';
      }
      state.outcome = pending.replacesAppointmentId && !oldStillActive ? 'rescheduled' : 'booked';
      // the visit this call booked or moved to, so "make it 4:40" moves it and keeps its day
      if (result.status === 'booked' || result.status === 'already_done') {
        const a = result.appointment;
        if (state.outcome === 'rescheduled' && state.memory.visit?.appointmentId === pending.replacesAppointmentId) state.memory.moved = { from: state.memory.visit.start, to: a.start };
        else if (state.outcome === 'rescheduled' && pending.replacesStart) state.memory.moved = { from: pending.replacesStart, to: a.start };
        state.memory.visit = { appointmentId: a.id, start: a.start, visitTypeId: a.visitTypeId, providerId: a.providerId };
      }
      if (result.status === 'booked') {
        const a = result.appointment;
        const facts = { appointmentId: a.id, patientId: patient.id, providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.start.toISOString(), endsAt: a.end.toISOString(), by: 'assistant', callId: ctx.callId };
        await emit(state.outcome === 'rescheduled'
          ? { type: 'appointment.rescheduled', key: `${a.id}|${facts.startsAt}`, data: { ...facts, previousAppointmentId: pending.replacesAppointmentId } }
          : { type: 'appointment.booked', key: a.id, data: facts });
      }
      // a move is confirmed as a move, a new booking as a booking
      const smsSent = result.status === 'booked'
        ? await confirmByText(state.outcome === 'rescheduled' ? 'change_confirmed' : 'booking_confirmed', result.appointment.start, result.appointment.id, { providerId: result.appointment.providerId, visitTypeId: result.appointment.visitTypeId }, noText, state.outcome === 'rescheduled' ? pending.replacesStart ?? null : null)
        : false;
      // a clinic that sends reminders asks once, after a booking, whoever has not said yes yet
      const reminders = textingOf(clinic).reminders;
      const askReminder = result.status === 'booked' && reminders.enabled && reminders.askOnBooking && !patient.textsOk && !!patient.phone
        && !!backend.patients.setTextConsent && !state.remindersAsked;
      if (askReminder) {
        state.reminderOffer = { patientId: patient.id, offeredAtMs: state.lastMs(), askedAtMs: null };
        state.remindersAsked = true;
      }
      state.done.push(`${pending.replacesAppointmentId ? 'moved: ' : 'booked '}${pending.readback}${smsSent ? ' (confirmation text sent)' : ''}`);
      return {
        ok: true,
        data: {
          booked: true, when: pending.readback, sms_sent: smsSent,
          done: `This visit is booked. Say so once${smsSent ? ', and that a confirmation text is on its way to the number on file (asked for one, say it has been sent)' : ''}; do not look for times again or check it, and never say it was not completed. If the caller says goodbye, call end_call.`,
          ...(oldStillActive ? { old_appointment_still_active: true, say: 'The new time is booked, but the old appointment could not be cancelled; offer a callback to sort it out.' } : {}),
          ...(askReminder && !oldStillActive ? { say: `Say it is booked, then ask once: "${pack.reminderOffer}" and call set_reminder_consent with their answer.` } : {}),
          // the whole answer, in the backend's words: the model is not asked again unless something is left to explain
          ...(result.status === 'booked' && !oldStillActive ? { spoken: pack.spoken.done({ kind: state.outcome === 'rescheduled' ? 'rescheduled' : 'booked', textSent: smsSent, then: askReminder ? pack.reminderOffer : pack.spoken.anythingElse }) } : {}),
        },
      };
    }

    case 'create_refill_request': {
      const callback = callbackNumber(args, ctx, state);
      if (!callback) return NO_CALLBACK_NUMBER(state.language);
      // the team's decision goes out by text only on a yes, asked before the request is logged
      const textUpdates = typeof args.text_updates === 'boolean' ? args.text_updates : null;
      if (textingOf(clinic).enabled && textUpdates === null) {
        return refuse('ask_text_updates', `Ask once: "${pack.refillTextOffer}" Then call create_refill_request again with the same details and text_updates true or false.`);
      }
      const task = await backend.tasks.create(clinic.id, {
        type: 'refill', callId: ctx.callId, patientId: state.verifiedPatient!.id,
        idempotencyKey: key(ctx.callId, 'refill', String(args.medication).toLowerCase()),
        details: { medication: String(args.medication), pharmacy: String(args.pharmacy), callback_number: asGiven(clinic, callback), ...(textUpdates !== null ? { texts: textUpdates ? 'yes' : 'no' } : {}) },
      });
      state.outcome = 'task_created';
      if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, number: task.number, type: 'refill', patientId: state.verifiedPatient!.id, callId: ctx.callId } });
      return { ok: true, data: { task_id: task.id, say: `Tell them the request is with the ${trade.identity === 'pet' ? 'team' : 'care team'}, who will review it and get back to them. Say nothing about approval or how long it takes.`, spoken: pack.spoken.refillTaken } };
    }

    case 'create_callback': {
      // only one of the clinic's own topics labels a request; anything else is left unlabelled
      const same = (x: string) => fold(x).toLowerCase().trim();
      const asked = typeof args.topic === 'string' ? same(args.topic) : '';
      const topic = asked ? clinic.requestTopics?.find((t) => same(t.name) === asked || t.id === args.topic) : undefined;
      const callback = callbackNumber(args, ctx, state);
      if (!callback) return NO_CALLBACK_NUMBER(state.language);
      const task = await backend.tasks.create(clinic.id, {
        type: 'callback', callId: ctx.callId, patientId: state.verifiedPatient?.id ?? null,
        // one callback per call for each purpose (a topic, a privacy request, or anything else): the team calls once
        idempotencyKey: key(ctx.callId, 'callback', topic?.id ?? (/^privacy request/i.test(String(args.reason)) ? 'privacy' : 'general')),
        details: { ...(topic ? { topic: topic.name } : {}), reason: String(args.reason), callback_number: asGiven(clinic, callback), ...(state.emergencyNotes.length ? { note: state.emergencyNotes.join(' ') } : {}) },
        // taken while an emergency holds the call: urgent, so it leads the Requests page and Today, and marked as from
        // an emergency call (REQ-2), like the one a transfer that did not go through leaves
        ...(state.emergencyLocked ? { urgent: true, origin: 'emergency' as const } : {}),
      });
      if (!state.emergencyLocked) state.outcome = 'task_created';
      if (!task.created) return { ok: true, data: { task_id: task.id, already: true, say: 'The team already has a callback request from this call. Say it is noted and they will call; do not take another.' } };
      await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, number: task.number, type: 'callback', patientId: state.verifiedPatient?.id ?? null, callId: ctx.callId } });
      // in a person's emergency the script around the callback is the model's; after an animal's script, the urgent request
      // taken is the answer; otherwise the request taken is the whole answer
      const afterPetScript = state.emergencyLocked && trade.identity === 'pet' && state.emergencyScriptSaid;
      return { ok: true, data: { task_id: task.id, ...(state.emergencyLocked ? { urgent: true } : {}),
        ...(afterPetScript ? { spoken: pack.spoken.urgentRequestTaken } : state.emergencyLocked ? {} : { spoken: pack.spoken.callbackTaken({ sameNumber: !!ctx.callerNumber && samePhone(callback, ctx.callerNumber, clinic) }) }) } };
    }

    case 'set_reminder_consent': {
      const offer = state.reminderOffer;
      if (!offer || offer.patientId !== state.verifiedPatient!.id) return refuse('not_offered', 'Only after a booking, when you asked about reminder texts. Carry on with the call.');
      if (offer.askedAtMs === null) return refuse('not_asked', `Ask first: "${pack.reminderOffer}"`);
      state.reminderOffer = null; // asked once, answered once
      // a yes is the caller's own clear words after the question, never the model's reading of them
      if (!args.agreed || !isClearYes(state.latestCallerWordsAfter(offer.askedAtMs), clinic.languages)) {
        return { ok: true, data: { reminders: false, say: 'No reminder texts. Carry on with the call.', spoken: pack.spoken.reminders({ agreed: false }) } };
      }
      await backend.patients.setTextConsent!(clinic.id, offer.patientId, ctx.callId);
      state.verifiedPatient!.textsOk = true;
      return { ok: true, data: { reminders: true, say: 'Say they will get a reminder text before the visit.', spoken: pack.spoken.reminders({ agreed: true }) } };
    }

    case 'send_text': {
      const texting = textingOf(clinic);
      const picked = args.kind as AskedTextKind;
      let ref = (args.ref as string | null) ?? null;
      // which text goes is the table's (core TEXT_TABLE, batch 1e): where the call is, and what the caller asked for. An
      // address is an address whichever kind the model picked for it: 'directions', or the clinic's "where are you"
      // common question sent as an 'answer' (batch 1d); in a hospital-routed emergency the address is the hospital's
      const c = state.emergencyCase;
      const situation = textSituationOf({
        locked: state.emergencyLocked,
        emergency: c ? { stage: c.stage, action: c.route?.action ?? null, transfer: c.transfer, backup: !!c.route?.backup } : null,
        booked: state.outcome === 'booked' || state.outcome === 'rescheduled',
      });
      // (a clinic that does not text its address keeps sending its "where are you" answer as the answer it is)
      const where = picked === 'answer' && (state.emergencyLocked || texting.kinds.directions) && asksWhere(clinic.faqs.find((f) => f.id === ref)?.question ?? state.lastTurn('caller', 3));
      const route = textRoute(situation, textAskOf(picked, where));
      if ('refuse' in route) return refuse(route.refuse, TEXT_REFUSALS[route.refuse]);
      const kind = route.kind;
      if (kind !== picked && picked === 'answer') ref = null;
      if (!texting.enabled) return refuse('texting_off', `The clinic does not text this. Say: "${pack.textRefused({ reason: 'off' })}" Then say it out loud, slowly, and offer to repeat it.`);
      // the clinic texts, just not this: never "texting isn't set up"
      if (!texting.kinds[kind]) return refuse('texting_off', 'The clinic does not send this one by text (it sends other things). Say in a few words that you can\'t text that one, then say it out loud, slowly, and offer to repeat it. Never say texting is not set up or not available on this line.');
      // the hospital's details go once a call (FRIDAY notes: text once, to a confirmed number)
      if (kind === 'emergency_hospital' && state.emergencyTextSent) return refuse(picked === 'emergency_hospital' ? 'already_sent' : 'emergency_in_progress', 'The hospital\'s details were already texted on this call. Say they are on their phone; do not send them again.');
      // only to the number they are calling from, or the one on their file: never another person's
      const asked = (args.to as string | null) ?? null;
      const onFile = state.verifiedPatient?.phone ?? null;
      let to: string | null = null;
      let target: 'this' | 'file' = 'this';
      if (asked) {
        if (ctx.callerNumber && samePhone(asked, ctx.callerNumber, clinic)) to = ctx.callerNumber;
        else if (onFile && samePhone(asked, onFile, clinic)) { to = onFile; target = 'file'; } else return refuse('number_not_allowed', 'Texts go only to the number they are calling from or the number on their file. Offer those; never ask for another number.');
      } else if (ctx.callerNumber) to = ctx.callerNumber;
      if (!to) return refuse('no_number', 'Say you can\'t see the number they\'re calling from, and ask whether they\'d like it sent to the number on their file.');
      // a number abroad, premium or toll-free never gets a text: known before anything is asked
      if (!textableNumber(clinic, asE164(clinic, to))) {
        if (target === 'this') state.callerNotTextable = true;
        return refuse('not_textable', NOT_TEXTABLE);
      }
      if (backend.messenger.optedOut && await backend.messenger.optedOut(clinic.id, to)) {
        return refuse('opted_out', `Say: "${pack.textRefused({ reason: 'opted_out' })}" Then read it out, slowly.`);
      }
      if (state.textsSent >= MAX_TEXTS_PER_CALL) return refuse('rate_limited', 'You have sent what can be sent by text on this call. Read it out instead.');
      const content = textContent(kind, ref, clinic, state, ctx.now(), lang, route.source);
      if (!content) return refuse('nothing_to_send', 'Say you can\'t text that one, and say it out loud instead.');

      // consent, in the caller's own words, after the question was spoken: like a booking
      const offer = state.textOffer;
      const same = !!offer && offer.kind === kind && offer.ref === ref && offer.to === target;
      let consentAtMs: number;
      if (same && offer.askedAtMs !== null) {
        if (!isClearYes(state.answerToTextOffer(), clinic.languages)) return refuse('no_clear_yes', 'Do not send it. Carry on with the call.');
        consentAtMs = offer.askedAtMs;
      } else {
        // the assistant may have offered on its own (the emergency script ends with an offer): the yes after that counts
        const spoken = same ? null : state.spokenTextOfferMs(TEXT_OFFER_MARKER);
        // an offer whose yes already sent a text does not send another
        if (spoken !== null && spoken > state.lastTextConsentMs && isClearYes(state.latestCallerWordsAfter(spoken), clinic.languages)) consentAtMs = spoken;
        else {
          if (!same) state.textOffer = { kind, ref, to: target, offeredAtMs: state.lastMs(), askedAtMs: null };
          return refuse('consent_required', `Ask exactly: "${pack.textOffer({ target })}" Then call send_text again with the same details once they say yes.`);
        }
      }
      state.textOffer = null; // a yes counts once
      const sent = await backend.messenger.sendTemplate(clinic.id, {
        to, template: content.template, vars: { clinic: clinic.name, ...content.vars }, language: lang,
        idempotencyKey: key(ctx.callId, 'text', kind, ref ?? '', to.replace(/\D/g, '')),
        kind: 'asked', about: { callId: ctx.callId, patientId: state.verifiedPatient?.id ?? null }, consentAtMs,
      }).catch((err: unknown) => { ctx.log?.warn({ call_id: ctx.callId, err }, 'text failed'); return null; });
      if (!sent || sent.status === 'not_sent') {
        if (sent?.reason === 'opted_out') return refuse('opted_out', `Say: "${pack.textRefused({ reason: 'opted_out' })}" Then read it out, slowly.`);
        if (sent?.reason === 'rate_limited' || sent?.reason === 'monthly_limit') return refuse('rate_limited', 'Say the text can\'t be sent right now, and read it out instead.');
        if (sent?.reason === 'not_textable') return refuse('not_textable', NOT_TEXTABLE);
        return refuse('not_sent', 'Say the text didn\'t go through, and read it out instead.');
      }
      if (sent.status === 'sent') state.textsSent++;
      if (sent.status === 'sent' && kind === 'emergency_hospital') { state.emergencyTextSent = true; state.emergencyResult = 'hospital_texted'; }
      state.lastTextConsentMs = consentAtMs;
      // the text has gone: a failed audit row is logged, never turned into "I couldn't do that"
      await backend.audit.record(clinic.id, { actor: 'voice-agent', action: 'sms.consent.asked', entity: 'call', entityId: ctx.callId, callId: ctx.callId })
        .catch((err: unknown) => ctx.log?.error({ call_id: ctx.callId, err }, 'text consent not audited'));
      return { ok: true, data: { texted: true, template: content.template, consent_at_ms: consentAtMs, say: `Say: "${pack.textSent}"`, ...(state.emergencyLocked ? {} : { spoken: pack.spoken.textSent }) } };
    }

    case 'transfer_call': {
      const target = args.target as 'front_desk' | 'billing' | 'on_call';
      const resolved = resolveTransfer(clinic, target, ctx.now());
      if (!resolved.ok) {
        // said as it is, in the caller's language: the offer of a callback at once, never a question about a pet first (2026-10)
        const refused = refuse(resolved.reason, resolved.reason === 'no_rule'
          ? 'The clinic has no phone line set up for transfers. Do not say nobody is there. Offer to take a callback request for the team, with the reason and the best number.'
          : 'That line only takes calls at other times. Offer to take a callback request for the team, with the reason and the best number.');
        return state.emergencyLocked ? refused : { ...refused, data: { ...refused.data, spoken: pack.spoken.noTransfer } };
      }
      // a browser test call cannot be transferred: say what would happen on a real call
      if (ctx.channel === 'web') {
        return { ok: true, data: { test_call: true, say: `This is a test call from the browser, so it cannot be transferred. Say that on a real phone call you would connect them now to the ${target.replace('_', ' ')} line.` } };
      }
      await backend.audit.record(clinic.id, { actor: 'voice-agent', action: `call.transferred.${target}`, entity: 'call', entityId: ctx.callId, callId: ctx.callId });
      if (!state.emergencyLocked) state.outcome = 'transferred';
      return { ok: true, data: { transferring: target, say: 'Tell them you are connecting them now.' }, action: { type: 'transfer', uri: resolved.uri } };
    }

    case 'end_call':
      // never hang up on a caller who has not finished: "I'm done" can end a phone number, not the call
      if (!saidGoodbye(state.lastTurn('caller'), state.lastTurn('agent', 2))) {
        return refuse('caller_not_finished', 'Do not end the call yet. If their request is not finished, say what you can still do or offer a callback. Otherwise ask: "Is there anything else I can help you with?" End the call only after they say no or goodbye.');
      }
      return { ok: true, data: { ending: true, say: 'Say goodbye warmly.', spoken: pack.spoken.goodbye }, action: { type: 'hangup' } };
  }
}

/** Holidays and days with no hours within the next 120 days, after the week get_clinic_info already lists. */
function closedDaysAhead(clinic: ClinicConfig, today: string): string[] {
  const last = addDays(today, 120);
  const special = (clinic.specialDays ?? []).filter((d) => !d.windows.length).map((d) => `${d.date}${d.note ? ` (${d.note})` : ''}`);
  return [...clinic.holidays, ...special].filter((d) => d.slice(0, 10) >= addDays(today, 7) && d.slice(0, 10) <= last).sort();
}

/** Days after the week get_clinic_info already lists, within 120 days, with hours of their own: "2026-12-24 (Christmas Eve): 09:00 to 13:00". */
function specialHoursAhead(clinic: ClinicConfig, today: string): string[] {
  const last = addDays(today, 120);
  return (clinic.specialDays ?? []).filter((d) => d.windows.length && d.date >= addDays(today, 7) && d.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => `${d.date}${d.note ? ` (${d.note})` : ''}: ${d.windows.map((w) => `${w.open} to ${w.close}`).join(' and ')}`);
}

/** The clinic's emergency hospitals in its order of choice (Settings > Emergencies), each with its hours. */
function emergencyHospitalFacts(clinic: ClinicConfig) {
  return emergencyHospitalsOf(clinic.emergencies).map((h) => ({ name: h.name, phone: h.phone, address: h.address, hours: h.hours ? `${h.hours.open} to ${h.hours.close}` : 'open around the clock' }));
}

/** What the model is told when the table sends nothing; the caller hears its own words for it. */
const TEXT_REFUSALS: Record<TextTableRefusal, string> = {
  not_an_emergency: 'That text is only for an animal emergency. Read the hospital\'s details out instead if they ask.',
  emergency_question: 'Not yet: the caller has not answered whether this is still an emergency. Ask the one question first, word for word, and wait for the answer. Text nothing now.',
  emergency_in_progress: 'Do not text anything else now. Repeat where to take the animal.',
  no_hospital: 'There is no hospital to text on this call. Do not text anything. Repeat that the team will call right away, and the emergency line if you gave one.',
};

/**
 * "The other one", "my cat": the caller said which pet, not its name. Nothing is looked up and no try is used, so an
 * owner with two pets on one number is never told a pet was not found for pointing at it.
 */
const noPetName = () => refuse('pet_name', 'That is not the pet\'s name: the caller said which pet, not what it is called. Nothing was looked up and no try is used. Ask only for the pet\'s name; never say a pet was not found. Keep the owner\'s name and everything else they gave.');

/**
 * The veterinary pack's identity check: the number (caller ID, or one the caller says) is the household,
 * and a pet on it is found by its name as the caller says it, by sound. The owner's name is for the
 * greeting and for a new pet, never to unlock a record. The same rules as for a person otherwise:
 * three tries, the same answer whichever detail was wrong, and two records only staff can tell apart
 * go to staff.
 */
async function verifyPet(args: Record<string, unknown>, state: CallState, ctx: CallContext, backend: Backend, lang: CallState['language']): Promise<ToolResult> {
  const { clinic } = ctx;
  if (pointsAtPet(String(args.pet_name))) return noPetName();
  // "new" means added, never looked up: the registration checks the pet is not on file already
  if (state.saidNew() === 'new') return refuse('pet_is_new', 'The caller said the pet is new to the clinic: do not look it up. Add it with register_patient, asking only for what it still needs that the caller has not said yet (the kind of animal, its sex, its age or birthday, the owner\'s first name).');
  // the second way to find the profile, once the backend asked for it: the last four digits and the pet's name
  if (typeof args.phone_last4 === 'string' && args.phone_last4.trim()) return byLastFour(args.phone_last4, args, state, ctx, backend, lang);
  const phone = heardPhone(clinic, args.phone) ?? ctx.callerNumber;
  if (!phone) return refuse('phone_required', askPhone(lang));
  // no pet named yet: the number's pets, to pick from
  if (!(args.pet_name as string | null)?.trim()) return whichPet(phone, state, ctx, backend, lang, args.phone);
  // the pet described as a new client does (its age, its sex) and nothing said about being new: asked first, once, never looked up blind.
  // Not after "Is this for Biscuit or Max, or a new pet?": that question already covered "new", and a call asks only one of the two
  if (!state.askedIfNew && !state.askedWhichPet && state.saidNew() === null && !state.askedWhetherNew() && describesPet(state.callerWordsSinceFound())) {
    state.askedIfNew = true;
    return refuse('ask_if_new', `Before looking anything up, ask once, in these words: "${PACKS[lang].petNewQuestion({ pet: String(args.pet_name).trim() })}" If they say yes, add it with register_patient; if no, call verify_caller again with the same details.`);
  }
  const pet = String(args.pet_name);
  // the pet already found: nothing to do. Another of the household's pets is checked like any
  const current = state.verifiedPatient;
  if (current && soundsLike(pet, current.firstName)) return { ok: true, data: { verified: true, pet_name: current.firstName } };
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  const tried = identityKey(pet, phone.replace(/\D/g, '').slice(-10));
  if (state.identitiesTried.has(tried)) return triedAgain(state, 'the pet');
  const readBack = readBackFirst(args.phone, phone, state, ctx, lang);
  if (readBack) return readBack;
  const check = await checkOwner(phone, args.phone, state, ctx, backend, lang);
  if (check) return check;
  // a spoken number the owner's name has not confirmed: no lookup, so "found", "not found" and "no profile" never differ
  if (unconfirmedSpokenNumber(phone, args.phone, state, ctx)) return numberNotOpened(lang);
  const found = await findPetOnce(pet, phone, tried, state, ctx, backend);
  if (found.status === 'found') {
    // the result first, in one short sentence, before any times: a caller had to ask "have you found her?" (a test call).
    // A verified caller who named the pet at once is thanked by the owner's name first, as the pick question does (2026-11-14)
    let thanks = '';
    if (state.memory.verified && !state.memory.greeted) {
      const known = await knownHousehold(phone, state, ctx, backend);
      if (known?.owner) thanks = `${PACKS[lang].thanksOwner({ owner: known.owner })} `;
    }
    if (thanks) state.memory.greeted = true;
    const first = thanks + PACKS[lang].foundPet({ pet: found.patient.firstName, species: found.patient.species ?? null });
    const chosen = chosenNote(state, clinic, lang, ctx.now()).say ?? '';
    return { ok: true, data: { verified: true, pet_name: found.patient.firstName, species: found.patient.species ?? null, say: `Say first, in these words: "${first}" Then go on with what they want.${chosen}` } };
  }
  if (found.status === 'ambiguous') return refuse('needs_staff', 'Say you need a colleague to confirm the pet\'s record, and offer a callback.');
  // the same answer whichever detail was wrong: never confirm what is on the number
  return refuse('not_verified', `Say first, in these words: "${PACKS[lang].notSeenPet({ pet })}" ${state.identitiesTried.size > 1 ? 'They have given details before: do not ask again whether the pet is new.' : 'If the owner has not said whether the pet is new to the clinic, ask that; if new, add it with register_patient under this number.'} Otherwise ask whether the pet's name or the number is right, once. ${triesLeft(state)}`);
}

/**
 * The second way to find a pet's profile (2026-11-15), after two read-backs the caller said were wrong or a number with
 * no profile: the last four digits of the number on file and the pet's name. Only once the backend asked for them, so
 * four digits and a name are never a way to look around the records; counted like any try. Exactly one pet in exactly
 * one household is found; anything else is the same answer, and a request for the team. Nothing from the record is
 * said first: not the number, not the owner's name.
 */
async function byLastFour(said: string, args: Record<string, unknown>, state: CallState, ctx: CallContext, backend: Backend, lang: CallState['language']): Promise<ToolResult> {
  const lastFour = spokenDigits(said).replace(/\D/g, '');
  const ask = PACKS[lang].lastFourQuestion({ after: state.lastFourAsked ?? 'wrong_readbacks' });
  // the planner may ask for the last four digits itself after the second no, before calling with another number: that
  // no counts too (a live eval, 2026-11-15)
  countWrongReadback(state, null);
  if (!state.lastFourAsked && state.readbacksWrong >= WRONG_READBACKS) state.lastFourAsked = 'wrong_readbacks';
  if (!state.lastFourAsked || !backend.patients.findPetByLastFour) return refuse('last_four_not_asked', 'Find the pet by the phone number its profile is under, with phone and phone_last4 null: the last four digits are only for when the backend asks for them.');
  if (lastFour.length !== 4) return refuse('last_four_digits', `Ask again for just the last four digits, in these words: "${ask}" Keep the pet's name if they gave it.`);
  const pet = String(args.pet_name ?? '').trim();
  if (!pet) return refuse('pet_name', 'Ask the pet\'s name. Keep the four digits they gave; do not ask for them again.');
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  const tried = identityKey('last four', pet, lastFour);
  if (state.identitiesTried.has(tried)) return triedAgain(state, 'the pet');
  const found = await backend.patients.findPetByLastFour(ctx.clinic.id, lastFour, pet, ctx.callId);
  if (found.status !== 'found') {
    state.verifyAttempts++;
    state.identitiesTried.add(tried);
    return refuse('last_four_no_match', `Say first, in these words: "${PACKS[lang].lastFourNoMatch}" Then offer to take a request for the team to find the profile and call them back, with create_callback (what they want, and the best number). Do not search again, and never say a number or a name from the records.`);
  }
  if (state.verifiedPatient?.id !== found.patient.id) { state.pending = null; state.offered.clear(); }
  state.verifiedPatient = found.patient;
  state.verifiedOwner = found.patient.guardianName ?? state.verifiedOwner;
  state.newFromTurn = state.turns.length;
  state.foundByLastFour = true;
  rememberPet(state, found.patient);
  const first = PACKS[lang].foundPet({ pet: found.patient.firstName, species: found.patient.species ?? null });
  const chosen = chosenNote(state, ctx.clinic, lang, ctx.now()).say ?? '';
  return { ok: true, data: { verified: true, pet_name: found.patient.firstName, species: found.patient.species ?? null, say: `Say first, in these words: "${first}" Then go on with what they want. Never say the number on file or the owner's name.${chosen}` } };
}

/**
 * The number is known but no pet is named yet: the pets on that number, the household, to pick from, at most
 * three ("Is this for Biscuit or Max, or a new pet?"). With caller ID or with a number the caller says alike:
 * the number is the household, and the confirmation text to the number on file is the safety net. A number
 * with no pets gets the plain question, with no name from the records.
 */
async function whichPet(phone: string, state: CallState, ctx: CallContext, backend: Backend, lang: CallState['language'], said: unknown): Promise<ToolResult> {
  const ask = refuse('pet_name', 'Ask which pet the call is about, by its name, or whether it is a new pet. Never say a pet\'s name the caller has not said. Keep what they already gave; do not ask for it again.');
  // "Is it new to us?" already asked this call: one question about "new" per call, so no pick question after it
  if (!backend.patients.petsOnNumber || state.askedIfNew) return ask;
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  const readBack = readBackFirst(said, phone, state, ctx, lang);
  if (readBack) return readBack;
  const check = await checkOwner(phone, said, state, ctx, backend, lang);
  if (check) return check;
  // A number the caller SAID (not their caller ID) and not confirmed by the owner's name: nothing from its record is
  // said, not even its pets' names (the FINAL rule: nothing from a record before the caller is verified). The caller
  // is asked the pet's name instead. Caller ID, or a name that matches the owner on file, keeps the pick question;
  // a number with no owner on file has no pets to give away.
  if (unconfirmedSpokenNumber(phone, said, state, ctx)) return numberNotOpened(lang);
  const known = await knownHousehold(phone, state, ctx, backend);
  const pets = known ?? await backend.patients.petsOnNumber(ctx.clinic.id, phone, ctx.callId);
  // an unknown number: a new owner and a new pet, the usual way
  if (!pets.names.length) {
    // the profile may be under another number: the second way, once, unless the caller said the pet is new (2026-11-15)
    if (!state.lastFourAsked && state.saidNew() !== 'new') {
      state.lastFourAsked = 'no_profile';
      return refuse('no_pets_on_number', `Say first, in these words: "${PACKS[lang].noPetsOnNumber}" Then ask, in these words: "${PACKS[lang].lastFourQuestion({ after: 'no_profile' })}" With the last four digits and the pet's name, call verify_caller with phone_last4, pet_name and phone null; a new pet is added with register_patient under this number. Never say a pet's name the caller has not said.`);
    }
    return refuse('no_pets_on_number', `Say first, in these words: "${PACKS[lang].noPetsOnNumber}" Then ask the pet's name and whether it is new to the clinic; a new pet is added with register_patient under this number. Never say a pet's name the caller has not said.`);
  }
  state.askedWhichPet = true;
  state.memory.pets = pets.names;
  // a caller the number knows is thanked by name, and never asked for it: "Thanks, Jordan. Is this for Biscuit or Pepper?"
  if (known?.owner) state.memory.greeted = true;
  const question = known?.owner
    ? PACKS[lang].whichPetVerified({ owner: known.owner, names: pets.names, more: pets.more, offerNew: state.saidNew() !== 'new' })
    : PACKS[lang].whichPet(pets);
  return { ok: true, data: {
    verified: false, pets_on_number: pets.names, more: pets.more, ...(known?.owner ? { owner: known.owner } : {}),
    say: `Ask, in these words: "${question}" When they name one, call verify_caller with that pet's name; a new pet is added with register_patient under this number (never ask for the owner's name: it is on file). Say nothing else about these pets until one is found.`,
  } };
}

/**
 * A number the caller said, other than their caller ID, that the owner's name has not confirmed: a name that does not
 * match, no name given, or no profile on the number at all. All three get the same answer and the same next step
 * (numberNotOpened, then a request for the team), so a caller can't tell whether a number belongs to a client.
 */
function unconfirmedSpokenNumber(phone: string, said: unknown, state: CallState, ctx: CallContext): boolean {
  const spoken = typeof said === 'string' && said.trim() !== '';
  if (!spoken || (ctx.callerNumber && samePhone(phone, ctx.callerNumber, ctx.clinic))) return false;
  return state.memory.verified !== 'name_match';
}

/** The one answer for an unconfirmed spoken number, whatever is or isn't on file, and the one next step: a request. */
const numberNotOpened = (lang: CallState['language']) => refuse('number_not_opened', `Say first, in these words: "${PACKS[lang].numberNotOpened}" Then, if they want, take a request for the team to call them back with create_callback (what they want, and the best number to call). Do not look anything up again on this number, and never say a name, a pet or anything else from the records. A new pet is still added with register_patient if the caller says it is new.`);

/**
 * Who the caller is to the number, checked once per number before its records are used (2026-11-14). Caller ID is
 * enough. A number they said is checked against the owner on file by the name they give: "And your name?" is asked once
 * when they have not given one. A match opens the record (the owner's name, the pets' visits). No match still books, as
 * before (the confirmation text goes to the number on file), but nothing from the record is said and the booking carries
 * a note for the team. Null when the call may go on; otherwise the question to ask.
 */
async function checkOwner(phone: string, said: unknown, state: CallState, ctx: CallContext, backend: Backend, lang: CallState['language']): Promise<ToolResult | null> {
  const m = state.memory;
  const digits = phone.replace(/\D/g, '');
  const spoken = typeof said === 'string' && said.trim() !== '';
  if (!spoken || (ctx.callerNumber && samePhone(phone, ctx.callerNumber, ctx.clinic))) {
    if (m.verified !== 'caller_id') { m.verified = 'caller_id'; m.owner = null; }
    return null;
  }
  // a number said after another one: the earlier check was about that one
  if (m.nameCheck && m.nameCheck.digits !== digits) { m.nameCheck = null; m.verified = null; m.owner = null; }
  if (m.nameCheck || !backend.patients.ownerMatches) return null;
  const name = m.get('saidName') ?? null;
  const result = await backend.patients.ownerMatches(ctx.clinic.id, phone, name, ctx.callId);
  // the name is asked on every spoken number, whether or not anyone is on file: a caller can't tell a client's number
  // from the question (2026-11-09)
  if (result === 'name_needed' || (result === 'no_owner' && !name)) {
    if (m.nameAskedFor === digits) { m.nameCheck = { digits, result: 'not_given' }; return null; }
    m.nameAskedFor = digits;
    return refuse('owner_check', `Ask, in these words: "${PACKS[lang].yourNameQuestion}" When they answer, call verify_caller again with the same number and owner_name as they said it. Never say a name from the records first, and never say you don't have their name.`);
  }
  m.nameCheck = { digits, result };
  m.verified = result === 'match' ? 'name_match' : null;
  ctx.log?.info({ call_id: ctx.callId, owner_check: result }, 'owner checked on a spoken number');
  return null;
}

/** For a caller the number knows: the owner's first name on file and the pets, kept in the call memory. Null otherwise. */
async function knownHousehold(phone: string, state: CallState, ctx: CallContext, backend: Backend): Promise<{ owner: string | null; names: string[]; more: boolean } | null> {
  if (!state.memory.verified || !backend.patients.householdOnNumber) return null;
  const household = await backend.patients.householdOnNumber(ctx.clinic.id, phone, ctx.callId);
  // caller ID, and the caller said a name that is not the owner's (another person on a family phone): never greeted by the owner's
  const said = state.memory.get('saidName');
  if (household.owner && state.memory.verified === 'caller_id' && said && backend.patients.ownerMatches
    && await backend.patients.ownerMatches(ctx.clinic.id, phone, said, ctx.callId) === 'no_match') return { ...household, owner: null };
  if (household.owner) {
    state.memory.owner = household.owner;
    state.verifiedOwner ??= household.owner;
  }
  return household;
}

/**
 * One lookup of a pet by the number and its name, counted like a try of the identity check: found, it is the
 * pet this call is about; not found, that name is not looked up again on this number.
 */
async function findPetOnce(pet: string, phone: string, tried: string, state: CallState, ctx: CallContext, backend: Backend) {
  const found = await backend.patients.findPet(ctx.clinic.id, pet, phone, ctx.callId);
  if (found.status === 'found') {
    if (state.verifiedPatient?.id !== found.patient.id) { state.pending = null; state.offered.clear(); }
    state.verifiedPatient = found.patient;
    state.verifiedOwner = found.patient.guardianName ?? state.verifiedOwner;
    state.newFromTurn = state.turns.length;
    rememberPet(state, found.patient);
    return found;
  }
  // a name not found on the number is not filled in again
  if (state.memory.get('petName') && soundsLike(pet, state.memory.get('petName')!)) state.memory.forget('petName');
  state.verifyAttempts++;
  if (found.status === 'not_found') {
    state.notFound = true;
    state.identitiesTried.add(tried);
  }
  return found;
}

/** The pet found or added is the one the call is about: its name and kind, as the record has them. */
function rememberPet(state: CallState, pet: { firstName: string; species?: string | null }) {
  const turn = state.turns.length;
  state.memory.set('petName', pet.firstName, 'record', turn);
  if (pet.species) state.memory.set('species', pet.species.toLowerCase(), 'record', turn);
}

/** A new pet, with its owner as the guardian on the record. The front desk checks every one. */
async function registerPet(
  args: Record<string, unknown>, state: CallState, ctx: CallContext, backend: Backend, emit: (e: DomainEvent) => unknown, lang: CallState['language'],
): Promise<ToolResult> {
  const { clinic } = ctx;
  if (pointsAtPet(String(args.pet_name))) return noPetName();
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  if (state.registrations >= MAX_REGISTRATIONS) return refuse('too_many_registrations', 'Say the front desk will help add any other pets, and offer a callback.');
  const phone = heardPhone(clinic, args.phone) ?? ctx.callerNumber;
  if (!phone) return refuse('phone_required', askPhone(lang));
  // a number the caller said is checked by their name before a pet is added under its owner; caller ID needs nothing
  const check = await checkOwner(phone, args.phone, state, ctx, backend, lang);
  if (check) return check;
  // a known number's owner is the pet's owner: never asked for, and never a second owner on the number
  if (state.memory.verified && !state.memory.owner) await knownHousehold(phone, state, ctx, backend);
  const onFile = state.memory.verified ? state.memory.owner : null;
  const owner = String(args.owner_name ?? '').trim() || onFile || '';
  const ownerParts = owner.split(/\s+/);
  const petName = String(args.pet_name).trim();
  // only what is still missing once the call memory has filled what the caller already said, one thing at a time
  if (!owner && !state.verifiedOwner) return refuse('owner_name', 'Ask for the owner\'s first name. Keep everything else they already gave.');
  if (!(args.species as string | null)?.trim()) return refuse('pet_species', `Ask what kind of animal ${petName} is. Keep everything else they already gave.`);
  if (!args.sex) return refuse('pet_sex', `Ask whether ${petName} is female or male. Keep everything else they already gave.`);
  const birth = args.birthday_or_age ? parsePetBirth(String(args.birthday_or_age), ctx.now(), northAmerica(clinic) ? 'mdy' : 'dmy') : null;
  if (!birth) return refuse('unclear_age', 'Ask for the pet\'s age, roughly, or its birthday with the year (a birthday without a year is not enough). Keep everything else they already gave.');
  const species = String(args.species).trim().toLowerCase();
  const sex = args.sex === 'unknown' ? 'undisclosed' : (args.sex as Gender);
  // A pet is added only when the identity check finds no such pet: a caller who said it is new is not made to wait for a
  // lookup first, so the same check runs here, with the same details, counted as one of the tries. A pet already on file
  // is found, never added twice, and the caller hears no more than they would from verify_caller.
  const tried = identityKey(petName, phone.replace(/\D/g, '').slice(-10));
  if (!state.identitiesTried.has(tried)) {
    const found = await findPetOnce(petName, phone, tried, state, ctx, backend);
    if (found.status === 'found') return { ok: true, data: { verified: true, pet_name: found.patient.firstName, already_a_patient: true, say: `The pet is already on file here: carry on as for any patient.${chosenNote(state, clinic, lang, ctx.now()).say ?? ''}` } };
    if (found.status === 'ambiguous') return refuse('needs_staff', 'Say you need a colleague to confirm the pet\'s record, and offer a callback.');
  }
  // under a number that has an owner, the pet joins that owner: the directory keeps the name on file
  const result = await backend.patients.register(clinic.id, {
    firstName: petName, lastName: ownerParts.length > 1 ? ownerParts.at(-1)! : '', dob: birth.dob, gender: sex, phone, guardianName: owner || state.verifiedOwner, callId: ctx.callId, species,
  });
  if (result.status === 'limited') return refuse('daily_registration_limit', 'Say the front desk will help add any other pets, and offer a callback.');
  if (state.verifiedPatient?.id !== result.patient.id) { state.pending = null; state.offered.clear(); }
  state.verifiedPatient = result.patient;
  rememberPet(state, result.patient);
  state.verifiedOwner = result.patient.guardianName ?? owner ?? state.verifiedOwner;
  state.newFromTurn = state.turns.length;
  if (result.status === 'exists') { state.verifyAttempts++; return { ok: true, data: { verified: true, pet_name: result.patient.firstName, already_a_patient: true, say: `The pet is already on file here: carry on as for any patient.${chosenNote(state, clinic, lang, ctx.now()).say ?? ''}` } }; }
  state.registrations++;
  const task = await backend.tasks.create(clinic.id, {
    type: 'review', callId: ctx.callId, patientId: result.patient.id,
    idempotencyKey: key(ctx.callId, 'review', result.patient.id),
    details: {
      reason: 'New pet added by the assistant. Check the details and confirm them.',
      pet_name: petName, species, sex: args.sex === 'unknown' ? 'unknown' : String(args.sex), owner_name: owner, phone: asGiven(clinic, phone),
      ...(state.memory.bookedByCaller ? { note: PACKS[clinic.primaryLanguage].bookedByCallerNote({ name: state.memory.bookedByCaller }) } : {}),
      date_of_birth: birth.dob, ...(birth.estimated ? { date_of_birth_note: `Estimated from the age the owner gave: ${String(args.birthday_or_age)}` } : {}),
    },
  });
  if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'review', patientId: result.patient.id, callId: ctx.callId } });
  const newVisits = clinic.visitTypes.filter((v) => v.audience !== 'existing').map((v) => localName(v, lang));
  return { ok: true, data: { registered: true, pet_name: petName, say: `${petName} is now registered as a new patient. A first visit is usually ${newVisits.find((v) => /new/i.test(v)) ?? newVisits[0]}: ${state.chosen ? `use it for the time the owner chose.${chosenNote(state, clinic, lang, ctx.now()).say}` : `look for its times now, with any vet, unless the owner asked for something else (${newVisits.join(', ')}). Do not ask which vet.`}` } };
}

/**
 * What a text says, by kind: public clinic facts only, never a caller's details. Null
 * when there is nothing to send: no address, an unknown link or doctor, or an answer
 * that was not given on this call.
 */
export function textContent(
  kind: AskedTextKind, ref: string | null,
  clinic: ClinicConfig, state: Pick<CallState, 'answersGiven'> & { emergencyCase?: CallState['emergencyCase'] }, now: Date, lang: keyof typeof PACKS,
  source: TextSource = kind === 'emergency_hospital' ? 'named_hospital' : 'clinic_address',
): { template: SmsTemplate; vars: Record<string, string> } | null {
  const texting = textingOf(clinic);
  const clinicPhone = callUsNumber(clinic);
  switch (kind) {
    case 'directions': {
      const address = clinic.address?.trim();
      if (!address) return null;
      return { template: 'directions', vars: { address, mapUrl: texting.mapUrl ?? `https://maps.google.com/?q=${encodeURIComponent(address)}` } };
    }
    case 'hours':
      return { template: 'hours', vars: { hours: hoursSummary(clinic, now, lang) } };
    case 'emergency_hospital': {
      // the table's source: the route's hospital, its backup after a transfer nobody took, or the one a script named
      const r = state.emergencyCase?.route;
      const h = source === 'route_hospital' ? r?.hospital ?? null : source === 'route_backup' ? r?.backup ?? null : hospitalNow(clinic, now);
      if (!h) return null;
      return { template: 'emergency_hospital', vars: { hospital: h.name, hospitalAddress: h.address, hospitalPhone: h.phone, emergencyNumber: emergencyNumberFor(clinic, lang) } };
    }
    case 'provider': {
      const p = clinic.providers.find((x) => x.id === ref && !x.placeholder);
      if (!p) return null;
      const details = [...(p.credentials ?? []), ...(p.specialty ? [p.specialty] : []), ...p.categories].join(', ');
      return { template: 'provider', vars: { provider: providerName(p, lang), details, clinicPhone } };
    }
    case 'answer': {
      const faq = ref && state.answersGiven.has(ref) ? clinic.faqs.find((f) => f.id === ref) : undefined;
      if (!faq) return null;
      // whole sentences, at most 300 characters
      const text = faq.answer.trim();
      const cut = text.length <= 300 ? text : (() => { const head = text.slice(0, 300); const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! ')); return end > 40 ? head.slice(0, end + 1) : `${head.slice(0, 297).trimEnd()}...`; })();
      return { template: 'answer', vars: { answer: /[.!?]$/.test(cut) ? cut : `${cut}.`, clinicPhone } };
    }
    case 'link': {
      const link = texting.links.find((l) => l.id === ref);
      if (!link) return null;
      return { template: 'link', vars: { label: link.label, url: link.url } };
    }
  }
}
