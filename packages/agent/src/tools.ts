// SPDX-License-Identifier: AGPL-3.0-only
import {
  bookableProviders,
  addDays, ageOn, asE164, callUsNumber, declinesText, describesPet, pointsAtPet, withoutTextRefusal, type AuditLog, dobProblem, type Gender, genderWord, type ClinicConfig, type DomainEvent, emergencyNumberFor, type EventSink, findSlots, isClearYes, isMedicalQuestion, type KnowledgeBase, localDateOf, localName, MEDICAL_REFUSAL,
  fold, industryPack, isOpen, localParts, matchesSpecialty, toMinutes, type Messenger, NO_INFORMATION, ownerMatches, PACKS, parseDob, parsePetBirth, saidGoodbye, samePhone,
  type PatientDirectory, providerFacts, resolveTransfer, type SchedulerAdapter, seesAge, type Slot, speakSlot, specialtyFacts, type TaskQueue,
  toolArgsFor, type ToolName, todaysHoursLine, visitTypeFacts, currentOffers, requestTopicFacts, weekHours, zonedInstant,
  hospitalFor, hoursSummary, type SmsTemplate, textableNumber, textingOf, bookingOf, seesAnimal, usualProviderOf, awayOn, specialDayOf, weekdayOf, windowsOn, windowsOnDate,
} from '@attendra/core';
import type { Logger } from '@attendra/observability';
import { createHash } from 'node:crypto';
import type { CallState } from './call-state';
import { answerFromFaqs } from './knowledge';

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
}

/** What a tool hands back: data for the planner, and optionally a call-control action. */
export interface ToolResult {
  ok: boolean;
  data: Record<string, unknown>;
  action?: { type: 'transfer'; uri: string } | { type: 'hangup' };
}

const MAX_VERIFY_ATTEMPTS = 3;
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

const callbackNumber = (args: Record<string, unknown>, ctx: { callerNumber: string | null }) =>
  (typeof args.callback_number === 'string' && args.callback_number.trim() ? args.callback_number.trim() : null) ?? ctx.callerNumber;
const NO_CALLBACK_NUMBER = () => refuse('no_callback_number', 'Say you can\'t see the number they\'re calling from, and ask for the best number to call them back. Then call this again with it.');
const MEDICAL = () => refuse('medical_question', `Do not answer it, and do not read anything from the clinic's documents. Say: "${MEDICAL_REFUSAL}" Offer to take a callback.`);

const refuse = (code: string, say: string): ToolResult => ({ ok: false, data: { error: code, say } });

/** No caller ID (a browser test call, a hidden number): the one question for a number, in the caller's language, asked once. */
const askPhone = (lang: CallState['language']) => `Ask once, in these words: "${PACKS[lang].phoneQuestion({ callerId: false })}" Keep everything else they already gave; do not ask for it again.`;
/** A time the caller chose, as the planner hears it: when, and with whom. */
const choiceOf = (slot: Slot, clinic: ClinicConfig, lang: CallState['language']) => {
  const provider = clinic.providers.find((p) => p.id === slot.providerId);
  return `${speakSlot(slot.start, clinic.timezone, lang)}${provider ? ` with ${localName(provider, lang)}` : ''}`;
};
/**
 * Once the pet or patient is found or added: the time they chose before, looked for again (it may have gone meanwhile, and
 * the visit may now be a new patient's) and read back as a question, never dropped and never said to be done.
 */
const chosenNote = (state: CallState, clinic: ClinicConfig, lang: CallState['language']): { say?: string } => {
  const slot = state.chosen;
  if (!slot) return {};
  const local = localParts(slot.start, clinic.timezone);
  const time = `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`;
  return { say: ` Before this, the caller chose ${choiceOf(slot, clinic, lang)}. Look for it again now with find_slots (from_date ${local.date}, from_time ${time}, provider_id ${slot.providerId}); if it is still free, propose_booking it, so it is read back as a question for their yes. If it was taken meanwhile, say so and offer the times find_slots returns.` };
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
  const phone = typeof given === 'string' && given.trim() ? given.trim() : null;
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
 * Why the day or the provider the caller asked for is not possible as asked, in a line for the
 * assistant to say before the times: a closed day (a holiday or a special day with a reason), a day
 * with shorter hours, a provider away until a date, one in on other days only, or notice needed.
 * Null when the day and the provider asked for are fine.
 */
export function whyNot(clinic: ClinicConfig, q: { date: string | null; provider?: { name: string; timeOff: { from: string; to: string; start?: string; note?: string }[]; hours?: ClinicConfig['hours'] }; noticeHours?: number; now: Date; today: string }): string | null {
  const reasons: string[] = [];
  const date = q.date && q.date > q.today ? q.date : null;
  if (date) {
    const special = specialDayOf(clinic, date);
    const open = windowsOnDate(clinic, date);
    const name = DAY_NAMES[weekdayOf(date)]!;
    if (!open.length) reasons.push(`The clinic is closed on ${name} ${date}${special?.note ? ` (${special.note})` : clinic.holidays.includes(date) ? ' (a holiday)' : ''}.`);
    else if (special) reasons.push(`On ${name} ${date} the clinic is open ${hoursText(open)} only${special.note ? ` (${special.note})` : ''}.`);
    if (q.provider) {
      const off = q.provider.timeOff.find((t) => !t.start && date >= t.from && date <= t.to);
      if (off) reasons.push(`${q.provider.name} is away ${off.from === off.to ? `on ${off.from}` : `from ${off.from} to ${off.to}`}${off.note ? ` (${off.note})` : ''}, back on ${addDays(off.to, 1)}.`);
      else if (q.provider.hours) {
        const theirs = windowsOn(q.provider.hours, weekdayOf(date));
        const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => windowsOn(q.provider!.hours!, d).length).map((d) => DAY_NAMES[d]);
        if (!theirs.length) reasons.push(`${q.provider.name} is not in on ${name}s; their days are ${days.join(', ')}.`);
        else if (hoursText(theirs) !== hoursText(open)) reasons.push(`On ${name}s ${q.provider.name} is in ${hoursText(theirs)} only.`);
      }
    }
  } else if (q.provider && awayOn(q.provider, q.today)) {
    const off = q.provider.timeOff.find((t) => !t.start && q.today >= t.from && q.today <= t.to)!;
    reasons.push(`${q.provider.name} is away until ${off.to}${off.note ? ` (${off.note})` : ''}, back on ${addDays(off.to, 1)}.`);
  }
  if (q.noticeHours && q.noticeHours > 2) {
    const earliest = new Date(q.now.getTime() + q.noticeHours * 3_600_000);
    const first = localDateOf(earliest, clinic.timezone);
    if (!date || date < first) reasons.push(`This visit needs ${q.noticeHours} hours' notice, so the first day it can be booked for is ${first}.`);
  }
  return reasons.length ? `${reasons.join(' ')} Say this in a few words before the times.` : null;
}

export async function runTool(
  name: ToolName, rawArgs: unknown, state: CallState, ctx: CallContext, backend: Backend, revision = state.revision,
): Promise<ToolResult> {
  const result = await toolCall(name, rawArgs, state, ctx, backend, revision);
  return name === 'verify_caller' || name === 'register_patient' ? withPhoneAsGiven(result, rawArgs, state, ctx) : result;
}

async function toolCall(name: ToolName, rawArgs: unknown, state: CallState, ctx: CallContext, backend: Backend, revision: number): Promise<ToolResult> {
  // the arguments the clinic's industry takes: a veterinary clinic finds a pet by its owner's name and its own
  const trade = industryPack(ctx.clinic.industry);
  const parsed = toolArgsFor(ctx.clinic.industry)[name].safeParse(rawArgs);
  // the arguments were the model's mistake, not the caller's: they are never asked to say it again for it
  if (!parsed.success) return refuse('invalid_arguments', `These arguments do not fit the tool (${parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean).join(', ') || 'their shape'}). Call it again with what the caller already said; ask the caller only for a detail they have not given yet.`);
  if (state.emergencyLocked && !EMERGENCY_ALLOWED.has(name)) {
    return refuse('emergency_in_progress', trade.identity === 'pet'
      ? 'Do not continue the task. Repeat where to take the animal now, and that a person in danger should call ' + emergencyNumberFor(ctx.clinic) + '.'
      : `Do not continue the task. Repeat that if this is an emergency they should call ${emergencyNumberFor(ctx.clinic)}.`);
  }
  if (WRITE_TOOLS.has(name) && revision !== state.revision) {
    return refuse('superseded', 'The caller has asked for something else since; do not act on this request.');
  }
  // a pet's visits only once it is found by its owner, its name and the phone: the number alone, or the owner's name, is not enough
  if (name === 'visit_summary' && !state.verifiedPatient) {
    return refuse('not_verified', 'Nothing about a pet\'s visits can be said before the pet is found. Find it first with verify_caller (the owner\'s first name, the pet\'s name, the phone), asking only for what the caller has not said yet; say nothing about any visit until then.');
  }
  if (PATIENT_TOOLS.has(name) && !state.verifiedPatient) {
    // a time the caller chose before the pet or patient is found is kept, and read back once they are
    const chosen = name === 'propose_booking' ? state.offered.get(String((parsed.data as { slot_id?: unknown }).slot_id)) : undefined;
    if (chosen) state.chosen = chosen;
    const keep = chosen ? `The caller chose ${choiceOf(chosen, ctx.clinic, state.language)}: that choice is kept, and the backend says how to book it once ${trade.identity === 'pet' ? 'the pet is found or added' : 'they are found or added'}. Say you will book it right after that, never that it is done or taken care of. ` : '';
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
  const when = (start: Date) => speakSlot(start, clinic.timezone, lang);
  const providerName = (id: string) => { const p = clinic.providers.find((x) => x.id === id); return p ? localName(p, lang) : undefined; };
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
    const calling = !!ctx.callerNumber && samePhone(ctx.callerNumber, patient.phone);
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
      ...(provider && provider.kind !== 'room' ? { provider: localName(provider, lang) } : {}),
      ...(visit ? { visit: localName(visit, lang).toLowerCase() } : {}),
    };
  };
  /**
   * A confirmation text for a change just made. The read-back said it would come, so the caller's
   * yes is their consent to it; a caller who said no to the text gets none. The change stands
   * whatever happens to the text; it is never reported as failed.
   */
  const confirmByText = async (template: 'booking_confirmed' | 'change_confirmed' | 'cancel_confirmed', start: Date, appointmentId: string, visitFacts: { providerId?: string; visitTypeId?: string } = {}, declined = false): Promise<boolean> => {
    const patient = state.verifiedPatient;
    if (declined || !patient?.phone || !confirmationTarget(template)) return false;
    try {
      const text = await backend.messenger.sendTemplate(clinic.id, {
        to: patient.phone, template, idempotencyKey: key(ctx.callId, template === 'booking_confirmed' ? 'sms' : template, appointmentId), language: lang,
        vars: { clinic: clinic.name, when: when(start), clinicPhone: callUsNumber(clinic), ...personal(visitFacts) },
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
      const phone = (args.phone as string | null) ?? ctx.callerNumber;
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
        return { ok: true, data: { verified: true, first_name: found.patient.firstName, age: ageOn(found.patient.dob, localDateOf(ctx.now(), clinic.timezone)), ...chosenNote(state, clinic, lang) } };
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
      const phone = (args.phone as string | null) ?? ctx.callerNumber;
      if (!phone) return refuse('phone_required', askPhone(lang));
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
      if (result.status === 'exists') { state.verifyAttempts++; return { ok: true, data: { verified: true, first_name: result.patient.firstName, age, already_a_patient: true, say: `They are already a patient here: carry on as for any patient.${chosenNote(state, clinic, lang).say ?? ''}` } }; }
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
      if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'review', patientId: result.patient.id, callId: ctx.callId } });
      const newVisits = clinic.visitTypes.filter((v) => v.audience !== 'existing').map((v) => localName(v, lang));
      return { ok: true, data: { registered: true, first_name: first, age, say: `They are now registered as a new patient. A first visit is usually ${newVisits.find((v) => /new/i.test(v)) ?? newVisits[0]}: ${state.chosen ? `use it for the time they chose.${chosenNote(state, clinic, lang).say}` : `look for its times now, with any provider, unless they asked for something else (${newVisits.join(', ')}). Do not ask which provider.`}` } };
    }

    case 'get_clinic_info': {
      const question = String(args.question);
      // the medical-advice rule wins over anything the FAQ or a document says. It checks
      // what the caller said too: the model may pass on a question it has softened
      if (isMedicalQuestion(question) || isMedicalQuestion(state.recentCallerText(), { quantities: false })) return MEDICAL();
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
      if (visitType.staffOnly) return refuse('staff_books', 'The team books this visit themselves. Say so, and offer to take a request for them to call back with create_callback: what the visit is for, and the best number.');
      const patient = state.verifiedPatient;
      // a caller who said they (or the pet) are new is looked for with a new patient's visit from the start, so a time they pick still fits once they are added
      if ((patient?.isNew || (!patient && state.saidNew() === 'new')) && visitType.audience === 'existing') {
        return refuse('new_patient_visit_type', `New patients book one of these first: ${clinic.visitTypes.filter((v) => v.audience !== 'existing').map((v) => localName(v, lang)).join(', ')}.`);
      }
      if (patient && !patient.isNew && visitType.audience === 'new') {
        return refuse('existing_patient_visit_type', `They are already a patient. Offer one of these: ${clinic.visitTypes.filter((v) => v.audience !== 'new').map((v) => localName(v, lang)).join(', ')}.`);
      }
      let providers = args.provider_id ? clinic.providers.filter((p) => p.id === args.provider_id) : bookableProviders(clinic.providers);
      if (args.provider_id && !providers.length) return refuse('unknown_provider', 'Use a provider_id from get_clinic_info.');
      // the kind of doctor or department the caller asked for, matched to the clinic's own list only
      // a clinic that lists no specialties or categories for anyone: everyone sees everything
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
        if (!fit.length) return refuse('no_provider_for_animal', `None of the clinic's vets is listed for a ${patient.species}. Say so, without guessing why, and offer a callback for the team to arrange it.`);
        providers = fit;
      }
      const now = ctx.now();
      const today = localDateOf(now, clinic.timezone);
      const requested = (args.from_date as string | null) ?? today;
      const from = requested < today ? today : requested;
      // the clinic's booking window for this visit: how far ahead the assistant may book it
      const lastDay = visitType.maxDaysAhead ? addDays(today, visitType.maxDaysAhead) : null;
      if (lastDay && from > lastDay) {
        return refuse('too_far_ahead', `This visit is booked at most ${visitType.maxDaysAhead} days ahead, so the last day it can be booked for is ${lastDay}. Offer to look before then, or take a request for the team with create_callback.`);
      }
      let days = 14;
      while (lastDay && days > 1 && addDays(from, days - 1) > lastDay) days--;
      // and how much notice it needs: never under two hours
      const leadMinutes = Math.max(120, (visitType.noticeHours ?? 0) * 60);
      // busy time must cover the whole search window, however far out it starts
      const busy = await backend.scheduler.busy(clinic.id, providers.map((p) => p.id), now, zonedInstant(addDays(from, days + 1), '00:00', clinic.timezone));
      // and the patient's own visits: a time that overlaps one would only be refused as patient_busy after their yes
      if (patient) {
        for (const a of await backend.scheduler.upcoming(clinic.id, patient.id, now)) {
          for (const p of providers) busy.push({ providerId: p.id, start: a.start, end: a.end });
        }
      }
      const fromTime = (args.from_time as string | null) ?? undefined;
      const query = { visitType, from, days, now, leadMinutes, partOfDay: args.part_of_day as 'any', fromTime, tieBreak: rules.tieBreak === 'fewest_visits' ? 'fewest' as const : 'order' as const };
      // with anyone: three different times, each with the vet the clinic's rule picks for it
      const anyone = findSlots(clinic, busy, { ...query, providers, distinctTimes: !named });
      let slots = anyone;
      let note = anyone.length ? `Offer these as written. Do not invent other times.${fromTime && !anyone.some((s) => localParts(s.start, clinic.timezone).minutes === toMinutes(fromTime)) ? ` Nothing is free at exactly ${fromTime}; say so and offer these, the nearest after it.` : ''}` : `No openings ${lastDay && days < 14 ? 'before bookings close for this visit' : 'in the next two weeks'}; offer a callback.`;
      // nobody named: their usual vet first, when that vet is free soon enough
      if (!asked && patient && rules.noPreference === 'usual_first' && backend.scheduler.history) {
        const usualId = usualProviderOf(await backend.scheduler.history(clinic.id, patient.id, now), now);
        const usual = providers.find((p) => p.id === usualId);
        if (usual) {
          const until = addDays(from, rules.usualWithinDays - 1);
          const theirs = findSlots(clinic, busy, { ...query, providers: [usual] }).filter((s) => localDateOf(s.start, clinic.timezone) <= until);
          const name = providerName(usual.id);
          if (theirs.length) {
            const sooner = anyone.find((s) => s.providerId !== usual.id && s.start.getTime() < theirs[0]!.start.getTime());
            slots = sooner ? [...theirs, sooner] : theirs;
            note = `The first ${theirs.length === 1 ? 'time is' : `${theirs.length} times are`} with ${name}, who usually sees ${patient.firstName}: offer ${theirs.length === 1 ? 'it' : 'them'} first.`
              + (sooner ? ` The last one, with ${providerName(sooner.providerId)}, is sooner: mention it only if none of ${name}'s suit.` : '') + ' Do not invent other times.';
          } else if (anyone.length) {
            note = `${name}, who usually sees ${patient.firstName}, has nothing in the next ${rules.usualWithinDays} ${rules.usualWithinDays === 1 ? 'day' : 'days'}. Say so, offer these with other ${trade.identity === 'pet' ? 'vets' : 'doctors'}, and offer to look later for ${name} if they would rather wait.`;
          }
        }
      }
      for (const s of slots) state.offered.set(s.id, s);
      // why the day or the provider the caller asked for gave nothing, so the assistant can say so before the times
      const why = whyNot(clinic, { date: args.from_date as string | null, provider: named || providers.length === 1 ? providers[0] : undefined, noticeHours: visitType.noticeHours, now, today });
      return {
        ok: true,
        data: {
          slots: slots.map((s) => ({ slot_id: s.id, when: when(s.start), provider: providerName(s.providerId), specialty: clinic.providers.find((x) => x.id === s.providerId)?.specialty ?? null })),
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
        return { appointment_id: a.id, when: when(a.start), provider: providerName(a.providerId), visit_type_id: a.visitTypeId, visit: visit ? localName(visit, lang) : null };
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
      const lastSeen = last ? pack.lastVisitSeen({ pet: pet.firstName, when: when(last.start), provider: providerName(last.providerId) ?? null, visit: visitName(last.visitTypeId) }) : null;
      // dates, vets and kinds of visit only: no reason, note or anything medical is in what comes back
      return {
        ok: true,
        data: {
          pet: pet.firstName,
          next_visits: upcoming.slice(0, 3).map((a) => ({ when: when(a.start), vet: providerName(a.providerId) ?? null, visit: visitName(a.visitTypeId) })),
          last_visit: last ? { when: when(last.start), vet: providerName(last.providerId) ?? null, visit: visitName(last.visitTypeId) } : null,
          usual_vet: usual ? providerName(usual) ?? null : null,
          say: `Answer only what the owner asked, in a sentence, from these facts. ${lastSeen ? `A past visit is said this way: "${lastSeen}"` : 'No earlier visit is booked or recorded here: say you can\'t see one, never that there was none.'} Never read the visits out as a list unasked and never count them: only the last and the next. Nothing medical (what was found, results, medicines, doses, weights, notes, invoices) and no copy of the records: for those say "${pack.recordsOffer}", and on a yes take create_callback with the reason starting "Records request:".`,
        },
      };
    }

    case 'propose_booking': {
      const slot = state.offered.get(String(args.slot_id));
      if (!slot) return refuse('slot_not_offered', 'Only offer times returned by find_slots. Look up slots again.');
      const replaces = (args.replaces_appointment_id as string | null) ?? null;
      let replacing: string | null = null;
      if (replaces) {
        const current = (await backend.scheduler.upcoming(clinic.id, state.verifiedPatient!.id, ctx.now())).find((a) => a.id === replaces);
        if (!current) return refuse('unknown_appointment', 'Use list_appointments to find the appointment being moved.');
        replacing = when(current.start);
      }
      const provider = providerName(slot.providerId) ?? 'the provider';
      const providerKind = clinic.providers.find((x) => x.id === slot.providerId)?.kind ?? 'person';
      const visitType = clinic.visitTypes.find((v) => v.id === slot.visitTypeId);
      const visit = visitType ? localName(visitType, lang) : 'visit';
      const readback = pack.readbackBooking({ when: when(slot.start), provider, providerKind, visit, replacing });
      // the same change proposed again after it was read back keeps its read-back, so the yes the caller gave still counts
      const same = state.pending;
      if (same?.kind === 'book' && same.slot.id === slot.id && same.replacesAppointmentId === replaces && same.readbackAtMs !== null) {
        return { ok: true, data: { say: `This was already read back: ${readback}. If the caller said yes to it, call commit_pending now; otherwise ask for a clear yes.` } };
      }
      state.pending = { kind: 'book', slot, replacesAppointmentId: replaces, readback, seq: ++state.proposals, proposedAtMs: state.lastMs(), readbackAtMs: null };
      state.chosen = null; // the time they chose is the one being read back now
      // the confirmation text is said before the yes, so the yes covers it and the caller can turn it down
      const target = confirmationTarget(replaces ? 'change_confirmed' : 'booking_confirmed');
      return { ok: true, data: { say: target ? `Read this back, say "${pack.confirmTextNote({ target })}", and ask for a clear yes: ${readback}.` : `Read this back and ask for a clear yes: ${readback}.` } };
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
      state.pending = { kind: 'cancel', appointmentId: appt.id, start: appt.start, readback, seq: ++state.proposals, proposedAtMs: state.lastMs(), readbackAtMs: null };
      const target = confirmationTarget('cancel_confirmed');
      return { ok: true, data: { say: target ? `Ask them to confirm, with a clear yes, that you should ${readback}, and say "${pack.confirmTextNote({ target })}".` : `Ask them to confirm, with a clear yes, that you should ${readback}.` } };
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
        return { ok: true, data: { cancelled: true, sms_sent: smsSent } };
      }

      const result = await backend.scheduler.book(clinic.id, {
        patientId: patient.id, slot: pending.slot, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'book', pending.slot.id, pending.seq),
        replacesAppointmentId: pending.replacesAppointmentId,
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
      if (pending.replacesAppointmentId) {
        const moved = await backend.scheduler.cancel(clinic.id, { patientId: patient.id, appointmentId: pending.replacesAppointmentId, callId: ctx.callId, idempotencyKey: key(ctx.callId, 'replace', pending.replacesAppointmentId, pending.seq) });
        oldStillActive = moved.status === 'not_found';
      }
      state.outcome = pending.replacesAppointmentId && !oldStillActive ? 'rescheduled' : 'booked';
      if (result.status === 'booked') {
        const a = result.appointment;
        const facts = { appointmentId: a.id, patientId: patient.id, providerId: a.providerId, visitTypeId: a.visitTypeId, startsAt: a.start.toISOString(), endsAt: a.end.toISOString(), by: 'assistant', callId: ctx.callId };
        await emit(state.outcome === 'rescheduled'
          ? { type: 'appointment.rescheduled', key: `${a.id}|${facts.startsAt}`, data: { ...facts, previousAppointmentId: pending.replacesAppointmentId } }
          : { type: 'appointment.booked', key: a.id, data: facts });
      }
      // a move is confirmed as a move, a new booking as a booking
      const smsSent = result.status === 'booked'
        ? await confirmByText(state.outcome === 'rescheduled' ? 'change_confirmed' : 'booking_confirmed', result.appointment.start, result.appointment.id, { providerId: result.appointment.providerId, visitTypeId: result.appointment.visitTypeId }, noText)
        : false;
      // a clinic that sends reminders asks once, after a booking, whoever has not said yes yet
      const reminders = textingOf(clinic).reminders;
      const askReminder = result.status === 'booked' && reminders.enabled && reminders.askOnBooking && !patient.textsOk && !!patient.phone
        && !!backend.patients.setTextConsent && !state.remindersAsked;
      if (askReminder) {
        state.reminderOffer = { patientId: patient.id, offeredAtMs: state.lastMs(), askedAtMs: null };
        state.remindersAsked = true;
      }
      state.done.push(`booked ${pending.readback}${smsSent ? ' (confirmation text sent)' : ''}`);
      return {
        ok: true,
        data: {
          booked: true, when: pending.readback, sms_sent: smsSent,
          done: `This visit is booked. Say so once${smsSent ? ', and that a confirmation text is on its way to the number on file (asked for one, say it has been sent)' : ''}; do not look for times again or check it, and never say it was not completed. If the caller says goodbye, call end_call.`,
          ...(oldStillActive ? { old_appointment_still_active: true, say: 'The new time is booked, but the old appointment could not be cancelled; offer a callback to sort it out.' } : {}),
          ...(askReminder && !oldStillActive ? { say: `Say it is booked, then ask once: "${pack.reminderOffer}" and call set_reminder_consent with their answer.` } : {}),
        },
      };
    }

    case 'create_refill_request': {
      const callback = callbackNumber(args, ctx);
      if (!callback) return NO_CALLBACK_NUMBER();
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
      if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'refill', patientId: state.verifiedPatient!.id, callId: ctx.callId } });
      return { ok: true, data: { task_id: task.id, say: `Tell them the request is with the ${trade.identity === 'pet' ? 'team' : 'care team'}, who will review it and get back to them. Say nothing about approval or how long it takes.` } };
    }

    case 'create_callback': {
      // only one of the clinic's own topics labels a request; anything else is left unlabelled
      const same = (x: string) => fold(x).toLowerCase().trim();
      const asked = typeof args.topic === 'string' ? same(args.topic) : '';
      const topic = asked ? clinic.requestTopics?.find((t) => same(t.name) === asked || t.id === args.topic) : undefined;
      const callback = callbackNumber(args, ctx);
      if (!callback) return NO_CALLBACK_NUMBER();
      const task = await backend.tasks.create(clinic.id, {
        type: 'callback', callId: ctx.callId, patientId: state.verifiedPatient?.id ?? null,
        // one callback per call for each purpose (a topic, a privacy request, or anything else): the team calls once
        idempotencyKey: key(ctx.callId, 'callback', topic?.id ?? (/^privacy request/i.test(String(args.reason)) ? 'privacy' : 'general')),
        details: { ...(topic ? { topic: topic.name } : {}), reason: String(args.reason), callback_number: asGiven(clinic, callback) },
      });
      if (!state.emergencyLocked) state.outcome = 'task_created';
      if (!task.created) return { ok: true, data: { task_id: task.id, already: true, say: 'The team already has a callback request from this call. Say it is noted and they will call; do not take another.' } };
      await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'callback', patientId: state.verifiedPatient?.id ?? null, callId: ctx.callId } });
      return { ok: true, data: { task_id: task.id } };
    }

    case 'set_reminder_consent': {
      const offer = state.reminderOffer;
      if (!offer || offer.patientId !== state.verifiedPatient!.id) return refuse('not_offered', 'Only after a booking, when you asked about reminder texts. Carry on with the call.');
      if (offer.askedAtMs === null) return refuse('not_asked', `Ask first: "${pack.reminderOffer}"`);
      state.reminderOffer = null; // asked once, answered once
      // a yes is the caller's own clear words after the question, never the model's reading of them
      if (!args.agreed || !isClearYes(state.latestCallerWordsAfter(offer.askedAtMs), clinic.languages)) {
        return { ok: true, data: { reminders: false, say: 'No reminder texts. Carry on with the call.' } };
      }
      await backend.patients.setTextConsent!(clinic.id, offer.patientId, ctx.callId);
      state.verifiedPatient!.textsOk = true;
      return { ok: true, data: { reminders: true, say: 'Say they will get a reminder text before the visit.' } };
    }

    case 'send_text': {
      const texting = textingOf(clinic);
      const kind = args.kind as 'directions' | 'hours' | 'emergency_hospital' | 'provider' | 'answer' | 'link';
      const ref = (args.ref as string | null) ?? null;
      if (!texting.enabled) return refuse('texting_off', `The clinic does not text this. Say: "${pack.textRefused({ reason: 'off' })}" Then say it out loud, slowly, and offer to repeat it.`);
      // the clinic texts, just not this: never "texting isn't set up"
      if (!texting.kinds[kind]) return refuse('texting_off', 'The clinic does not send this one by text (it sends other things). Say in a few words that you can\'t text that one, then say it out loud, slowly, and offer to repeat it. Never say texting is not set up or not available on this line.');
      // in an emergency the only text is where to take the animal, and only then
      if (state.emergencyLocked && kind !== 'emergency_hospital') return refuse('emergency_in_progress', 'Do not text anything else now. Repeat where to take the animal.');
      if (!state.emergencyLocked && kind === 'emergency_hospital') return refuse('not_an_emergency', 'That text is only for an animal emergency. Read the hospital\'s details out instead if they ask.');
      // only to the number they are calling from, or the one on their file: never another person's
      const asked = (args.to as string | null) ?? null;
      const onFile = state.verifiedPatient?.phone ?? null;
      let to: string | null = null;
      let target: 'this' | 'file' = 'this';
      if (asked) {
        if (ctx.callerNumber && samePhone(asked, ctx.callerNumber)) to = ctx.callerNumber;
        else if (onFile && samePhone(asked, onFile)) { to = onFile; target = 'file'; } else return refuse('number_not_allowed', 'Texts go only to the number they are calling from or the number on their file. Offer those; never ask for another number.');
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
      const content = textContent(kind, ref, clinic, state, ctx.now(), lang);
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
      state.lastTextConsentMs = consentAtMs;
      // the text has gone: a failed audit row is logged, never turned into "I couldn't do that"
      await backend.audit.record(clinic.id, { actor: 'voice-agent', action: 'sms.consent.asked', entity: 'call', entityId: ctx.callId, callId: ctx.callId })
        .catch((err: unknown) => ctx.log?.error({ call_id: ctx.callId, err }, 'text consent not audited'));
      return { ok: true, data: { texted: true, template: content.template, consent_at_ms: consentAtMs, say: `Say: "${pack.textSent}"` } };
    }

    case 'transfer_call': {
      const target = args.target as 'front_desk' | 'billing' | 'on_call';
      const resolved = resolveTransfer(clinic, target, ctx.now());
      if (!resolved.ok) {
        return refuse(resolved.reason, resolved.reason === 'no_rule'
          ? 'The clinic has no phone line set up for transfers. Do not say nobody is there. Offer to take a callback request for the team, with the reason and the best number.'
          : 'That line only takes calls at other times. Offer to take a callback request for the team, with the reason and the best number.');
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
      return { ok: true, data: { ending: true, say: 'Say goodbye warmly.' }, action: { type: 'hangup' } };
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

/** The clinic's emergency hospitals in its order of choice, each with its hours (none is around the clock). */
function emergencyHospitalFacts(clinic: ClinicConfig) {
  return [clinic.emergencyHospital, ...(clinic.moreEmergencyHospitals ?? [])].flatMap((h) => (h
    ? [{ name: h.name, phone: h.phone, address: h.address, hours: h.hours ? `${h.hours.open} to ${h.hours.close}` : 'open around the clock' }]
    : []));
}

/**
 * "The other one", "my cat": the caller said which pet, not its name. Nothing is looked up and no try is used, so an
 * owner with two pets on one number is never told a pet was not found for pointing at it.
 */
const noPetName = () => refuse('pet_name', 'That is not the pet\'s name: the caller said which pet, not what it is called. Nothing was looked up and no try is used. Ask only for the pet\'s name; never say a pet was not found. Keep the owner\'s name and everything else they gave.');

/**
 * The veterinary pack's identity check: a pet, by its owner's first name (or full name), its own name
 * and the phone on file. The same rules as for a person: three tries, the same answer
 * whichever detail was wrong, and two records only staff can tell apart go to staff.
 */
async function verifyPet(args: Record<string, unknown>, state: CallState, ctx: CallContext, backend: Backend, lang: CallState['language']): Promise<ToolResult> {
  const { clinic } = ctx;
  if (pointsAtPet(String(args.pet_name))) return noPetName();
  // "new" means added, never looked up: the registration checks the pet is not on file already
  if (state.saidNew() === 'new') return refuse('pet_is_new', 'The caller said the pet is new to the clinic: do not look it up. Add it with register_patient, asking only for what it still needs that the caller has not said yet (the kind of animal, its sex, its age), one at a time; it checks the pet is not on file already.');
  // the owner said who they are, and no pet yet
  if (!(args.pet_name as string | null)?.trim()) return whichPet(String(args.owner_name), args, state, ctx, backend, lang);
  // the pet described as a new client does (its age, its sex) and nothing said about being new: asked first, once, never looked up blind.
  // Not after "Is this for Biscuit or Max, or a new pet?": that question already covered "new", and a call asks only one of the two
  if (!state.askedIfNew && !state.askedWhichPet && state.saidNew() === null && !state.askedWhetherNew() && describesPet(state.callerWordsSinceFound())) {
    state.askedIfNew = true;
    return refuse('ask_if_new', `Before looking anything up, ask once, in these words: "${PACKS[lang].petNewQuestion({ pet: String(args.pet_name).trim() })}" If they say yes, add it with register_patient; if no, call verify_caller again with the same details. Keep everything they already gave.`);
  }
  const phone = (args.phone as string | null) ?? ctx.callerNumber;
  if (!phone) return refuse('phone_required', askPhone(lang));
  const owner = String(args.owner_name);
  const pet = String(args.pet_name);
  if (!owner.trim()) return refuse('owner_name', 'Ask for the owner\'s first name. Keep the pet\'s name and the phone they already gave.');
  // the pet already found: nothing to do. Another of the owner's pets is checked like any
  const current = state.verifiedPatient;
  if (current && sameFirstWord(pet, current.firstName) && state.verifiedOwner && ownerMatches(owner, state.verifiedOwner)) return { ok: true, data: { verified: true, pet_name: current.firstName } };
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  const tried = identityKey(owner, pet, phone.replace(/\D/g, '').slice(-10));
  if (state.identitiesTried.has(tried)) return triedAgain(state, 'the pet');
  const found = await findPetOnce(owner, pet, phone, tried, state, ctx, backend);
  if (found.status === 'found') return { ok: true, data: { verified: true, pet_name: found.patient.firstName, species: found.patient.species ?? null, ...chosenNote(state, clinic, lang) } };
  if (found.status === 'ambiguous') return refuse('needs_staff', 'Say you need a colleague to confirm the pet\'s record, and offer a callback.');
  // the same answer whichever detail was wrong: never confirm that a record exists
  return refuse('not_verified', `Say you could not find the pet. ${state.identitiesTried.size > 1 ? 'They have given details before: do not ask again whether the pet is new.' : 'If the owner has not said whether the pet is new to the clinic, ask that first: a new pet is added with register_patient.'} For a pet that is not new, check the details one at a time: the owner's first name as it is on the pet's file, the pet's name, and the phone number on file if it is not the one they are calling from. ${triesLeft(state)}`);
}

/**
 * The owner has said who they are but not which pet. Only on a call with real caller ID (never a number the caller just
 * says, as on a browser test call or from a hidden number), and only when the owner's name matches the owner on file for
 * that number, are their pets named to pick from, at most three: on a family number, never another owner's. Otherwise
 * the assistant asks which pet, with no name from the records, and a name that matched nobody uses one of the tries.
 */
async function whichPet(owner: string, args: Record<string, unknown>, state: CallState, ctx: CallContext, backend: Backend, lang: CallState['language']): Promise<ToolResult> {
  const ask = refuse('pet_name', 'Ask which pet the call is about, by its name, or whether it is a new pet. Never say a pet\'s name the caller has not said. Keep the owner\'s name they gave; do not ask for it again.');
  const callerId = ctx.channel !== 'web' ? ctx.callerNumber : null;
  const said = (args.phone as string | null) ?? null;
  // "Is it new to us?" already asked this call: one question about "new" per call, so no pick question after it
  if (!callerId || (said && !samePhone(said, callerId)) || !backend.patients.petsOnNumber || state.askedIfNew) return ask;
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  const pets = await backend.patients.petsOnNumber(ctx.clinic.id, callerId, owner, ctx.callId);
  if (!pets.names.length) { state.verifyAttempts++; return ask; }
  state.askedWhichPet = true;
  return { ok: true, data: {
    verified: false, pets_on_number: pets.names, more: pets.more,
    say: `Ask, in these words: "${PACKS[lang].whichPet(pets)}" When they name one, call verify_caller with that pet's name; a new pet is added with register_patient. Say nothing else about these pets until one is found.`,
  } };
}

/**
 * One lookup of a pet by its owner, its name and the phone, counted like a try of the identity check: found, it is the
 * pet this call is about; not found, these details are not looked up again.
 */
async function findPetOnce(owner: string, pet: string, phone: string, tried: string, state: CallState, ctx: CallContext, backend: Backend) {
  const found = await backend.patients.findPet(ctx.clinic.id, owner, pet, phone);
  if (found.status === 'found') {
    if (state.verifiedPatient?.id !== found.patient.id) { state.pending = null; state.offered.clear(); }
    state.verifiedPatient = found.patient;
    state.verifiedOwner = owner;
    state.newFromTurn = state.turns.length;
    return found;
  }
  state.verifyAttempts++;
  if (found.status === 'not_found') {
    state.notFound = true;
    state.identitiesTried.add(tried);
  }
  return found;
}

/** A new pet, with its owner as the guardian on the record. The front desk checks every one. */
async function registerPet(
  args: Record<string, unknown>, state: CallState, ctx: CallContext, backend: Backend, emit: (e: DomainEvent) => unknown, lang: CallState['language'],
): Promise<ToolResult> {
  const { clinic } = ctx;
  if (pointsAtPet(String(args.pet_name))) return noPetName();
  if (state.verifyAttempts >= MAX_VERIFY_ATTEMPTS) return refuse('too_many_attempts', 'Offer to have the front desk call them back, and take a callback number.');
  if (state.registrations >= MAX_REGISTRATIONS) return refuse('too_many_registrations', 'Say the front desk will help add any other pets, and offer a callback.');
  const phone = (args.phone as string | null) ?? ctx.callerNumber;
  if (!phone) return refuse('phone_required', askPhone(lang));
  const owner = String(args.owner_name).trim();
  const ownerParts = owner.split(/\s+/);
  if (!owner) return refuse('owner_name', 'Ask for the owner\'s first name. Keep everything else they already gave.');
  const birth = parsePetBirth(String(args.birthday_or_age), ctx.now(), northAmerica(clinic) ? 'mdy' : 'dmy');
  if (!birth) return refuse('unclear_age', 'Ask for the pet\'s age, roughly, or its birthday with the year (a birthday without a year is not enough). Keep everything else they already gave.');
  const petName = String(args.pet_name).trim();
  const species = String(args.species).trim().toLowerCase();
  const sex = args.sex === 'unknown' ? 'undisclosed' : (args.sex as Gender);
  // A pet is added only when the identity check finds no such pet: a caller who said it is new is not made to wait for a
  // lookup first, so the same check runs here, with the same details, counted as one of the tries. A pet already on file
  // is found, never added twice, and the caller hears no more than they would from verify_caller.
  const tried = identityKey(owner, petName, phone.replace(/\D/g, '').slice(-10));
  if (!state.identitiesTried.has(tried)) {
    const found = await findPetOnce(owner, petName, phone, tried, state, ctx, backend);
    if (found.status === 'found') return { ok: true, data: { verified: true, pet_name: found.patient.firstName, already_a_patient: true, say: `The pet is already on file here: carry on as for any patient.${chosenNote(state, clinic, lang).say ?? ''}` } };
    if (found.status === 'ambiguous') return refuse('needs_staff', 'Say you need a colleague to confirm the pet\'s record, and offer a callback.');
  }
  const result = await backend.patients.register(clinic.id, {
    firstName: petName, lastName: ownerParts.length > 1 ? ownerParts.at(-1)! : '', dob: birth.dob, gender: sex, phone, guardianName: owner, callId: ctx.callId, species,
  });
  if (result.status === 'limited') return refuse('daily_registration_limit', 'Say the front desk will help add any other pets, and offer a callback.');
  if (state.verifiedPatient?.id !== result.patient.id) { state.pending = null; state.offered.clear(); }
  state.verifiedPatient = result.patient;
  state.verifiedOwner = owner;
  state.newFromTurn = state.turns.length;
  if (result.status === 'exists') { state.verifyAttempts++; return { ok: true, data: { verified: true, pet_name: result.patient.firstName, already_a_patient: true, say: `The pet is already on file here: carry on as for any patient.${chosenNote(state, clinic, lang).say ?? ''}` } }; }
  state.registrations++;
  const task = await backend.tasks.create(clinic.id, {
    type: 'review', callId: ctx.callId, patientId: result.patient.id,
    idempotencyKey: key(ctx.callId, 'review', result.patient.id),
    details: {
      reason: 'New pet added by the assistant. Check the details and confirm them.',
      pet_name: petName, species, sex: args.sex === 'unknown' ? 'unknown' : String(args.sex), owner_name: owner, phone: asGiven(clinic, phone),
      date_of_birth: birth.dob, ...(birth.estimated ? { date_of_birth_note: `Estimated from the age the owner gave: ${String(args.birthday_or_age)}` } : {}),
    },
  });
  if (task.created) await emit({ type: 'request.created', key: task.id, data: { requestId: task.id, type: 'review', patientId: result.patient.id, callId: ctx.callId } });
  const newVisits = clinic.visitTypes.filter((v) => v.audience !== 'existing').map((v) => localName(v, lang));
  return { ok: true, data: { registered: true, pet_name: petName, say: `${petName} is now registered as a new patient. A first visit is usually ${newVisits.find((v) => /new/i.test(v)) ?? newVisits[0]}: ${state.chosen ? `use it for the time the owner chose.${chosenNote(state, clinic, lang).say}` : `look for its times now, with any vet, unless the owner asked for something else (${newVisits.join(', ')}). Do not ask which vet.`}` } };
}

/**
 * What a text says, by kind: public clinic facts only, never a caller's details. Null
 * when there is nothing to send: no address, an unknown link or doctor, or an answer
 * that was not given on this call.
 */
export function textContent(
  kind: 'directions' | 'hours' | 'emergency_hospital' | 'provider' | 'answer' | 'link', ref: string | null,
  clinic: ClinicConfig, state: Pick<CallState, 'answersGiven'>, now: Date, lang: keyof typeof PACKS,
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
      const h = hospitalFor(clinic, now);
      if (!h) return null;
      return { template: 'emergency_hospital', vars: { hospital: h.name, hospitalAddress: h.address, hospitalPhone: h.phone, emergencyNumber: emergencyNumberFor(clinic) } };
    }
    case 'provider': {
      const p = clinic.providers.find((x) => x.id === ref && !x.placeholder);
      if (!p) return null;
      const details = [...(p.credentials ?? []), ...(p.specialty ? [p.specialty] : []), ...p.categories].join(', ');
      return { template: 'provider', vars: { provider: localName(p, lang), details, clinicPhone } };
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
