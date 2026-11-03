// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, extractFacts, type Language, localName, PACKS, providerName, type SaidDay, type SaidTime, soundsLike, spokenDigits, asE164, normalise } from '@attendra/core';

/** Where a fact came from: the caller's own words, a tool's arguments, or the clinic's records. */
export type FactSource = 'caller' | 'tool' | 'record';
export interface Fact<T> { value: T; source: FactSource; atTurn: number }

/** The facts the call memory holds, by name. */
export interface MemoryFacts {
  /** The number the pet's profile is under: its digits, whether it was read back and said yes to, whether it is the caller ID. */
  number: { digits: string; readBack: boolean; callerId: boolean };
  /** The name the caller gave for themselves. Never compared or revealed here: the backend does that (item 2). */
  saidName: string;
  petName: string;
  species: string;
  sex: 'female' | 'male';
  age: string;
  intent: 'book' | 'move' | 'cancel' | 'question';
  visitType: string;
  vet: string;
  /** null: the caller said any day is fine. */
  day: SaidDay | null;
  time: SaidTime;
}

/**
 * What this call has established, so nothing is asked twice (2026-11-14): filled from the caller's own words (by closed
 * word lists, in memory-words), from the arguments the tools were given, and from what the records said. A later value
 * replaces an earlier one: a correction ("no, it's a cat") wins at once. The planner reads it every turn (memoryLine) and
 * the tools fill a missing argument from it (fillFromMemory).
 */
export class CallMemory {
  private readonly facts = new Map<keyof MemoryFacts, Fact<unknown>>();
  /** How the caller is known: by caller ID, or by a spoken number whose owner on file matched the name they gave. */
  verified: 'caller_id' | 'name_match' | null = null;
  /** The owner's first name on file: set only once verified, and never printed before. */
  owner: string | null = null;
  /**
   * The one name check on a number the caller said (its digits): matched, not matched (they may still book; nothing from
   * the record is said, and the booking carries a note for the team), no owner on file, or not given after "And your name?".
   */
  nameCheck: { digits: string; result: 'match' | 'no_match' | 'no_owner' | 'not_given' } | null = null;
  /** The number "And your name?" was asked for: asked once per number. */
  nameAskedFor: string | null = null;
  /** The first names of the pets on the number, as the records list them. */
  pets: string[] = [];
  /** The visit booked (or moved to) on this call, for a time-only move ("make it 4:40") that keeps its day. */
  visit: { appointmentId: string; start: Date; visitTypeId: string; providerId: string } | null = null;
  moved: { from: Date; to: Date } | null = null;

  set<K extends keyof MemoryFacts>(key: K, value: MemoryFacts[K], source: FactSource, atTurn = 0) {
    this.facts.set(key, { value, source, atTurn });
  }

  get<K extends keyof MemoryFacts>(key: K): MemoryFacts[K] | undefined {
    return this.facts.get(key)?.value as MemoryFacts[K] | undefined;
  }

  fact<K extends keyof MemoryFacts>(key: K): Fact<MemoryFacts[K]> | undefined {
    return this.facts.get(key) as Fact<MemoryFacts[K]> | undefined;
  }

  has(key: keyof MemoryFacts): boolean {
    return this.facts.has(key);
  }

  forget(key: keyof MemoryFacts) {
    this.facts.delete(key);
  }

  /** The caller's latest turn, read by the closed word lists of the call's language: the facts it says replace older ones. */
  fromCaller(text: string, lang: Language, clinic: ClinicConfig, today: string, atTurn: number) {
    const animals = clinic.providers.flatMap((p) => p.categories);
    const said = extractFacts(text, lang, { today, animals });
    if (said.species) this.set('species', said.species, 'caller', atTurn);
    if (said.sex) this.set('sex', said.sex, 'caller', atTurn);
    if (said.age) this.set('age', said.age, 'caller', atTurn);
    if (said.intent) this.set('intent', said.intent, 'caller', atTurn);
    if (said.day !== undefined) this.set('day', said.day, 'caller', atTurn);
    if (said.time) this.set('time', said.time, 'caller', atTurn);
    const vet = vetNamed(text, clinic);
    if (vet) this.set('vet', vet, 'caller', atTurn);
    else if (said.anyVet) this.forget('vet');
  }

  /** What a tool was given: the planner passes what the caller said, so those are facts of the call too. */
  fromToolArgs(name: string, args: Record<string, unknown>, clinic: ClinicConfig, callerNumber: string | null, atTurn: number) {
    const text = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : null);
    if (name === 'verify_caller' || name === 'register_patient') {
      const owner = text('owner_name') ?? text('full_name');
      if (owner) this.set('saidName', owner, 'tool', atTurn);
      const pet = text('pet_name');
      if (pet) this.set('petName', pet, 'tool', atTurn);
      const species = text('species');
      if (species) this.set('species', species.toLowerCase(), 'tool', atTurn);
      const sex = text('sex');
      if (sex === 'female' || sex === 'male') this.set('sex', sex, 'tool', atTurn);
      const age = text('birthday_or_age');
      if (age) this.set('age', age, 'tool', atTurn);
      const phone = text('phone');
      if (phone) {
        const digits = asE164(clinic, spokenDigits(phone)).replace(/\D/g, '');
        const current = this.get('number');
        if (current?.digits !== digits) this.set('number', { digits, readBack: false, callerId: !!callerNumber && callerNumber.replace(/\D/g, '') === digits }, 'tool', atTurn);
      } else if (callerNumber && !this.has('number')) {
        this.set('number', { digits: callerNumber.replace(/\D/g, ''), readBack: false, callerId: true }, 'tool', atTurn);
      }
    }
    if (name === 'find_slots') {
      const visit = text('visit_type_id');
      if (visit) this.set('visitType', visit, 'tool', atTurn);
      const vet = text('provider_id');
      if (vet) this.set('vet', vet, 'tool', atTurn);
      const day = text('from_date');
      if (day) this.set('day', { date: day }, 'tool', atTurn);
      const time = text('from_time');
      // a time the planner passed keeps the caller's own reading of it ("after 3" or "at 3")
      if (time && this.get('time')?.time !== time) this.set('time', { time, mode: 'after' }, 'tool', atTurn);
    }
  }

  /** The name the caller gave when it did not match the owner on file, for the team's note on a booking; null otherwise. */
  get bookedByCaller(): string | null {
    return this.nameCheck?.result === 'no_match' ? this.get('saidName')?.split(/\s+/)[0] ?? null : null;
  }

  /** The digits read back and said yes to. */
  confirmNumber(digits: string) {
    const n = this.fact('number');
    if (n && n.value.digits === digits && !n.value.readBack) this.set('number', { ...n.value, readBack: true }, n.source, n.atTurn);
  }
}

/** A vet the caller named ("with Dr. Ruiz", "la doctora Patel"), matched by sound to the clinic's own; null when none. */
function vetNamed(text: string, clinic: ClinicConfig): string | null {
  const t = normalise(text);
  let found: string | null = null;
  for (const m of t.matchAll(/\b(?:dr\.?|doctor|doctora|dra\.?)\s+([\p{L}'-]{2,})/gu)) {
    const said = m[1]!;
    const vet = clinic.providers.find((p) => p.kind !== 'room' && normalise(p.name).split(/\s+/).some((part) => part.length > 1 && soundsLike(said, part)));
    if (vet) found = vet.id;
  }
  return found;
}

/**
 * A missing or null argument the call memory has is filled from it, before the arguments are checked: the planner
 * never has to ask again for what the caller already said. A value the planner passed is never replaced. Returns the
 * arguments and the names of those filled (logged, never their values).
 */
export function fillFromMemory(name: string, rawArgs: unknown, memory: CallMemory, opts: { industry: string; verifiedPatient: boolean; callerNumber: string | null; ownerOnFile?: string | null }): { args: unknown; filled: string[] } {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return { args: rawArgs, filled: [] };
  const args = { ...(rawArgs as Record<string, unknown>) };
  const filled: string[] = [];
  const empty = (k: string) => args[k] === null || args[k] === undefined || (typeof args[k] === 'string' && !(args[k] as string).trim());
  const fill = (k: string, value: unknown) => { if (value !== undefined && value !== null && empty(k)) { args[k] = value; filled.push(k); } };
  const pets = opts.industry === 'vet';
  const number = memory.get('number');
  // a number the caller said (never the caller ID: phone null already means that one)
  const spoken = number && !number.callerId ? `+${number.digits}` : undefined;
  if (name === 'register_patient' && pets) {
    fill('species', memory.get('species'));
    fill('sex', memory.get('sex'));
    fill('birthday_or_age', memory.get('age'));
    // the owner on file of a known number, else the name the caller gave
    fill('owner_name', opts.ownerOnFile ?? memory.get('saidName'));
    fill('phone', spoken);
  }
  if (name === 'verify_caller' && pets) {
    fill('phone', spoken);
    fill('species', memory.get('species'));
    // never the pet's name: pet_name null asks for the pets on the number, and a name the caller gave is passed by the planner
  }
  if (name === 'find_slots') {
    // only what the caller said: a day or a vet the planner passed before and leaves out now is one it no longer means
    const said = <K extends 'day' | 'time' | 'vet'>(k: K) => { const f = memory.fact(k); return f?.source === 'caller' ? f.value : undefined; };
    const day = said('day');
    if (day && 'date' in day) fill('from_date', day.date);
    fill('from_time', said('time')?.time);
    fill('visit_type_id', memory.get('visitType'));
    fill('provider_id', said('vet'));
  }
  if (name === 'propose_booking' && memory.get('intent') === 'move' && memory.visit) fill('replaces_appointment_id', memory.visit.appointmentId);
  return { args, filled };
}

/** Each fact said once, for the planner: what the call memory holds, without the owner's name until the caller is verified. */
export function memoryLine(memory: CallMemory, clinic: ClinicConfig, lang: Language = 'en'): string | null {
  const parts: string[] = [];
  const number = memory.get('number');
  if (number) parts.push(`number ending ${number.digits.slice(-4)}${number.callerId ? ' (caller ID)' : number.readBack ? ' (read back, yes)' : ''}`);
  if (memory.verified) parts.push(memory.verified === 'caller_id' ? 'verified by caller ID' : 'verified: the name they gave matches the owner on file');
  if (memory.verified && memory.owner) parts.push(`owner ${memory.owner}`);
  else if (memory.get('saidName')) parts.push(`the caller said their name is ${memory.get('saidName')}`);
  if (memory.pets.length) parts.push(`pets on this number: ${memory.pets.join(', ')}`);
  const pet = [memory.get('petName'), memory.get('species'), memory.get('sex'), memory.get('age')].filter(Boolean);
  if (pet.length) parts.push(`this call is about: ${pet.join(', ')}`);
  const intent = memory.get('intent');
  const visitType = clinic.visitTypes.find((v) => v.id === memory.get('visitType'));
  const want = [
    intent && intent !== 'question' ? ({ book: 'book', move: 'move a visit', cancel: 'cancel a visit' } as const)[intent] : null,
    visitType ? `a ${localName(visitType, 'en').toLowerCase()}` : null,
  ].filter(Boolean).join(' ');
  const day = memory.get('day');
  const time = memory.get('time');
  const vet = clinic.providers.find((p) => p.id === memory.get('vet'));
  const when = [
    day === null ? 'any day' : day && 'date' in day ? PACKS.en.fullDay(day.date) : day ? `either ${PACKS.en.fullDay(day.either[0])} or ${PACKS.en.fullDay(day.either[1])} (ask which, once)` : null,
    time ? `${time.mode === 'after' ? 'after' : 'around'} ${time.time}` : null,
    vet ? `with ${providerName(vet, lang)}` : null,
  ].filter(Boolean).join(', ');
  if (want || when) parts.push(`wants: ${[want, when].filter(Boolean).join(', ')}`);
  if (memory.moved) parts.push(`moved on this call: ${PACKS.en.fullWhen(memory.moved.from, clinic.timezone)} to ${PACKS.en.fullWhen(memory.moved.to, clinic.timezone)}`);
  else if (memory.visit) parts.push(`booked on this call: ${PACKS.en.fullWhen(memory.visit.start, clinic.timezone)}`);
  return parts.length ? `call memory (never ask for any of these again; a correction replaces one): ${parts.join('; ')}` : null;
}
