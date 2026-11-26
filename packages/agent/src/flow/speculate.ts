// SPDX-License-Identifier: AGPL-3.0-only
import { callerIdOf, type ClinicConfig, digitsAsWords, industryPack, isClearYes, localName, normalise } from '@attendra/core';
import type { CallState } from '../call-state';

/**
 * The lookup the caller's last words ask for, started before the voice decides (lookup-ahead): the moment their words
 * are in, the lookup runs and its result is handed to the voice with them, so it answers in one reply instead of a tool
 * call and a second reply. Only when the call makes the next tool plain, and never a guess. Each case calls a tool the
 * way the flow's own next step tells the voice to call it (flow/booking.ts nextStep), with the caller's words:
 * - identity (call speed, 2026-11-19), at a vet clinic, before the pet is found:
 *   - a clear yes to "Is your pet's profile under the number you're calling from, ending 0101?": verify_caller with
 *     phone null (the caller ID), and the pet's name when they said one of that number's pets (read as the call
 *     started), else none, which gives the pick question;
 *   - a clear yes to the read-back of a number they said: verify_caller with that number;
 *   - a pet on the number named after "Is this for Rocky or Bella, or a new pet?": verify_caller with that pet;
 * - the clinic's hours or whether it is open: clinic_now (it reads only the clinic's clock);
 * - times (batch 1a, round 2): the pet (or patient) is found, nothing waits for a yes, the visit is known (from an
 *   earlier lookup on this call, or named by the caller) and their words ask about a day or a time.
 * Never while a change waits for a yes, an emergency is open, or the call is ending. "New", a no, or any doubt: nothing
 * is run, and the voice asks as before.
 */
export interface Speculation { name: 'find_slots' | 'verify_caller' | 'clinic_now'; args: Record<string, unknown> }

/** What the lookup-ahead knows beyond the call state: the caller ID, and the pet names on it read as the call started. */
export interface SpeculationContext {
  callerNumber: string | null;
  /** The first names of the pets on the caller ID's number (the preload), or null before they are read or without one. */
  petsOnCallerId: readonly string[] | null;
}

/** Words that ask about a day or a time, in English and Spanish (after `normalise`). */
const ASKS_TIME = /\b(free|available|availability|open(ing)?s?|earliest|soonest|first (time|one|available)|any ?time|when can|what (times|do you have)|anything (on|for|at)|how about|what about|tomorrow|today|tonight|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|noon|\d{1,2}(:\d\d)?\s*(am|pm|a m|p m)|o'?clock|libre|disponible|hay (algo|lugar|espacio|cita)|manana|hoy|lunes|martes|miercoles|jueves|viernes|sabado|domingo|por la (manana|tarde)|temprano|lo antes posible|la proxima semana)\b/;

/**
 * Words that ask about the clinic's hours or whether it is open now or on a day, in English and Spanish (after
 * `normalise`): "are you open Saturday?", "what are your hours?", "what time do you close?", "¿a qué hora abren?".
 */
const ASKS_HOURS = /\b(?:(?:are|is) (?:you|you guys|the clinic|it|the office) (?:still )?(?:open|closed)|(?:your|the clinic'?s|the) (?:hours|opening hours|business hours)|what (?:are )?(?:your |the )?hours|what time (?:do|does) (?:you|the clinic|it) (?:open|close)|when (?:do|does) (?:you|the clinic|it) (?:open|close)|(?:estan|esta|siguen) (?:abiertos?|cerrados?)|(?:su|el|cual es (?:el|su)) horario|a que hora (?:abren|cierran|abre|cierra))\b/;

/** A visit the caller named in their words: a whole word of the visit's name (four letters or more), in either language. */
function namedVisit(clinic: ClinicConfig, said: string): string | null {
  const words = new Set(said.split(/[^\p{L}]+/u).filter((w) => w.length >= 4));
  const hits = clinic.visitTypes.filter((v) => (['en', 'es'] as const).some((l) => normalise(localName(v, l)).split(/[^\p{L}]+/u).some((w) => w.length >= 4 && words.has(w))));
  return hits.length === 1 ? hits[0]!.id : null;
}

/** The one pet of `pets` the caller named in `said` (every word of its name), or null for none or more than one. */
export function petNamedIn(said: string, pets: readonly string[]): string | null {
  const words = new Set(normalise(said).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const hits = pets.filter((p) => { const w = normalise(p).split(/[^\p{L}\p{N}]+/u).filter(Boolean); return w.length > 0 && w.every((x) => words.has(x)); });
  return hits.length === 1 ? hits[0]! : null;
}

/** The assistant's last line before the caller's last turn, normalised. */
function askedLast(state: CallState): string {
  for (let i = state.turns.length - 2; i >= 0; i--) if (state.turns[i]!.speaker === 'agent') return normalise(state.turns[i]!.text);
  return '';
}

/**
 * The assistant's last line asked whether the pet's profile is under the caller ID ("…the number you're calling from,
 * ending 0 1 0 1?", "…el número desde el que llama, que termina en 0101?"): it names the profile and the caller ID's last
 * four digits, as digits or as words (Vapi's voice says them as words).
 */
export function askedCallerIdNumber(asked: string, callerNumber: string | null): boolean {
  const id = callerIdOf(callerNumber);
  if (!id || !/\b(profile|perfil|ficha|calling from|llama)\b/.test(asked)) return false;
  const digits = asked.replace(/\D/g, '');
  return digits.endsWith(id.last4) || (['en', 'es'] as const).some((l) => asked.includes(normalise(digitsAsWords(id.last4, l))));
}

/**
 * The caller said the pet's profile is on the number they are calling from, without being asked: "on the number I'm
 * calling from", "desde el número del que llamo", "con este número", "el mismo número" (a live run, 2026-11-26: the
 * Spanish caller still got the caller-ID question). A "not this number" or "another number" never is.
 */
const CALLING_NUMBER = new RegExp([
  "(?:the|this) (?:same )?number (?:i'?m|i am) calling (?:from|on)",
  '(?:on|under|with|from) this (?:same |very )?number',
  "(?:it'?s|its|it is) (?:the same|this) number",
  '(?:el|este) (?:mismo )?numero (?:del|desde el|con el) que (?:le )?(?:llamo|estoy llamando)',
  'del numero (?:del|desde el) que (?:le )?llamo',
  'con este (?:mismo )?numero',
  'este mismo numero',
  'el mismo numero',
  '(?:con|desde) el que (?:le )?estoy llamando',
].map((p) => `\\b${p}\\b`).join('|'));
const OTHER_NUMBER = /\b(?:not (?:on |under )?(?:this|the same|that) number|isn'?t (?:this|the same) number|(?:a |another |different |other )number|no (?:es|esta (?:con|en)) (?:este|el mismo|ese) numero|otro numero|numero (?:diferente|distinto))\b/;
// a "no" or "not" in the few words before the phrase: "No, no con este número", "Not the number I am calling from" (review)
const NEGATED = /\b(?:no|not|nope|isn'?t|is not|aren'?t|nunca)\b/;
export function saysCallingNumber(text: string): boolean {
  const t = normalise(text);
  const m = CALLING_NUMBER.exec(t);
  if (!m || OTHER_NUMBER.test(t)) return false;
  return !NEGATED.test(t.slice(0, m.index).split(/\s+/).slice(-4).join(' '));
}
/**
 * A turn about the pet, its profile or a visit: the calling number said in it is where the profile is. "Text me the
 * hours on this number" or "call me back on this number" asks for no profile (review).
 */
const ABOUT_THE_PET = /\b(?:book(?:ing)?|appointment|visit|check-?up|exam|vaccin\w*|schedule|reschedule|cancel\w*|profile|file|account|records?|my (?:pet|dog|cat|puppy|kitten|rabbit|bunny|bird)'?s?|citas?|visitas?|consultas?|turno|reserv\w*|agendar|cancelar|ficha|perfil|expediente|mi (?:mascota|perr[oa]|perrit[oa]|gat[oa]|gatit[oa]|cachorr[oa]|conej[oa]))\b/;

function identityLookup(state: CallState, clinic: ClinicConfig, said: string, ctx: SpeculationContext): Speculation | null {
  if (industryPack(clinic.industry).identity !== 'pet' || state.verifiedPatient || state.saidNew() === 'new' || /\b(new|nuev[oa])\b/.test(said)) return null;
  const yes = isClearYes(said, clinic.languages);
  const verify = (phone: string | null, pet: string | null): Speculation => ({ name: 'verify_caller', args: { phone, pet_name: pet, owner_name: null, phone_last4: null } });
  // the pick question was asked and answered with one of the pets on the number
  if (state.askedWhichPet && state.memory.pets.length) {
    const pet = petNamedIn(said, state.memory.pets);
    return pet ? verify(null, pet) : null;
  }
  // a number they said, read back, and a clear yes to it: searched now, as the read-back's own line says
  const r = state.phoneReadback;
  // (with the pet's name as they said it, as the voice passes it: that number's pets are not known before it is searched)
  if (r && r.askedAtMs !== null) {
    return yes && state.confirmedReadback(r.digits) ? verify(r.digits, state.memory.get('petName') ?? null) : null;
  }
  // a clear yes to the caller-ID question: the caller ID's number, with the pet when they named one that is on it; with
  // none named, the number's pets to pick from ("Is this for Biscuit or Max, or a new pet?"), as the voice would call it
  if (yes && !state.memory.verified && !state.phonesConfirmed.size && askedCallerIdNumber(askedLast(state), ctx.callerNumber)) return verify(null, petSaid(state, ctx));
  // said without being asked ("Hola, soy Linh Nguyen, desde el número del que llamo"): the same yes, before the question
  // only once the household on the caller ID is known: a pet named in the turn ("Can Biscuit come in…") is passed, never
  // a pet-less lookup that asks "Biscuit or Mochi?" again (the owner's final live run); unknown, nothing is run ahead
  if (!state.memory.verified && !state.phonesConfirmed.size && callerIdOf(ctx.callerNumber) && saysCallingNumber(said)) {
    if (!(state.memory.pets.length || ctx.petsOnCallerId?.length)) return null;
    const pet = petSaid(state, ctx);
    if (pet || ABOUT_THE_PET.test(said)) return verify(null, pet);
  }
  return null;
}

/** The pet of the caller ID's household the caller named on this call (in their words, or a tool's arguments), or null. */
function petSaid(state: CallState, ctx: SpeculationContext): string | null {
  const pets = state.memory.pets.length ? state.memory.pets : ctx.petsOnCallerId ?? [];
  if (!pets.length) return null;
  const words = state.turns.filter((t) => t.speaker === 'caller').map((t) => t.text).join(' ');
  return petNamedIn(words, pets) ?? petNamedIn(state.memory.get('petName') ?? '', pets);
}

function timesLookup(state: CallState, clinic: ClinicConfig, said: string): Speculation | null {
  if (!state.verifiedPatient || !ASKS_TIME.test(said)) return null;
  const known = state.memory.get('visitType');
  const visit = (known && clinic.visitTypes.some((v) => v.id === known) ? known : null) ?? namedVisit(clinic, said);
  if (!visit) return null;
  // the part of the day they asked for goes with it: "an afternoon time?" looked up as any time found only mornings
  const part = /\b(afternoon|tarde|evening|after lunch|despues de comer)\b/.test(said) ? 'afternoon' : /\b(morning|por la manana|en la manana|temprano)\b/.test(said) ? 'morning' : 'any';
  return { name: 'find_slots', args: { visit_type_id: visit, provider_id: null, from_date: null, part_of_day: part } };
}

export function speculativeLookup(state: CallState, clinic: ClinicConfig, ctx: SpeculationContext = { callerNumber: null, petsOnCallerId: null }): Speculation | null {
  if (state.pending || state.emergencyLocked || state.emergencyCase || state.ending) return null;
  const last = state.turns.at(-1);
  if (!last || last.speaker !== 'caller') return null;
  const said = normalise(last.text);
  const identity = identityLookup(state, clinic, said, ctx);
  if (identity) return identity;
  if (ASKS_HOURS.test(said)) return { name: 'clinic_now', args: {} };
  return timesLookup(state, clinic, said);
}

/**
 * Whether the caller's next words may ask for a lookup that can run ahead, so the voice waits for them (gpt-realtime
 * transcribes a turn after it ends): the identity questions above are waiting for their answer, or times are on the
 * table and the visit is known. Waiting costs the transcript's time on every turn it is on, so it is on only there.
 */
export function lookupLikelyNext(state: CallState, clinic: ClinicConfig, ctx: SpeculationContext, stage: string): boolean {
  if (state.pending || state.emergencyLocked || state.emergencyCase || state.ending) return false;
  // the caller's first turn waits for their words anyway (a cough is never answered): what it asks for is looked up first
  if (!state.turns.some((t) => t.speaker === 'caller')) return true;
  if (stage === 'times_offered') {
    const visit = state.memory.get('visitType');
    return !!visit && clinic.visitTypes.some((v) => v.id === visit);
  }
  if (industryPack(clinic.industry).identity !== 'pet' || state.verifiedPatient) return false;
  if (state.askedWhichPet && state.memory.pets.length) return true;
  if ((state.phoneReadback?.askedAtMs ?? null) !== null) return true;
  const lastAgent = [...state.turns].reverse().find((t) => t.speaker === 'agent');
  return !!lastAgent && !state.memory.verified && askedCallerIdNumber(normalise(lastAgent.text), ctx.callerNumber);
}
