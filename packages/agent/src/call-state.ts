// SPDX-License-Identifier: AGPL-3.0-only
import { type CallPatient, isClearYes, type Language, LANGUAGES, newToClinic, normalise, redactSensitive, type Slot } from '@attendra/core';
import { CallMemory } from './call-memory';

export interface Turn { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }

interface PendingBase {
  readback: string;
  seq: number; // one per proposal, so rebooking the same slot later in a call gets a fresh idempotency key
  proposedAtMs: number;
  /** When the assistant first spoke after the proposal: the read-back itself. Null until it is spoken. */
  readbackAtMs: number | null;
}

/** A text the assistant offered: what, and where, and when the question was spoken. */
export interface TextOffer { kind: string; ref: string | null; to: 'this' | 'file'; offeredAtMs: number; askedAtMs: number | null }

/** The details a caller gives about who they are, by the names the tools take them in, and how the state line says each. */
const DETAILS: Record<string, string> = {
  owner_name: 'owner\'s name', pet_name: 'pet\'s name', species: 'kind of animal', sex: 'pet\'s sex', birthday_or_age: 'pet\'s age or birthday',
  full_name: 'name', first_name: 'first name', last_name: 'last name', date_of_birth: 'date of birth', gender: 'gender', guardian_name: 'parent or guardian', phone: 'phone',
};
/** The assistant asked whether the pet (or the caller) is new: "Is Biscuit new to us?", "¿Es la primera vez que Biscuit viene?". */
const ASKED_IF_NEW = /\b(new|nuev[oa]s?|primera vez)\b[^.!]*\?/;
/** "Is this for Juniper, or a new pet?" ("¿Es para Juniper, o para una mascota nueva?"): new is one of the choices, so a yes is not it. */
const NEW_AS_CHOICE = /,\s*(?:or|o|u)\s+(?:a\s+|para\s+una?\s+)?(?:mascota\s+)?(?:new|nuev[oa])\b[^.!]*\?/;

/** The assistant asked whether the animal is in danger now: "Is Ginger in danger right now?", "¿Está en peligro ahora mismo?". */
const ASKED_DANGER = /\b(in danger|danger right now|en peligro|trouble breathing|le cuesta respirar)\b/;
/** A no to it, first: "no", "nope", "she's fine", "not right now", "no, gracias, está bien". */
const DANGER_NO = /^(?:no(?! (?:se|estoy segur[oa]|lo se)\b)|nope|nah|not (?:really|now|right now|at all)|(?:oh )?no(?:,| ) ?(?:she|he|it|they)|(?:she|he|it|they)(?:'?s| is| are|'?re) (?:fine|ok|okay|alright|all right|safe|not in danger|doing (?:fine|well|ok|okay))|para nada|esta bien|(?:el|ella) esta bien)\b/;
/** A yes: "yes", "yeah, she is", "I think so", "sí, ahora mismo". */
const DANGER_YES = /^(?:yes|yeah|yep|yup|i think so|it is|(?:she|he|it|they) (?:is|are)|right now|si|claro|creo que si|ahora mismo)\b/;

export type PendingChange =
  | (PendingBase & { kind: 'book'; slot: Slot; replacesAppointmentId: string | null; replacesStart?: Date | null })
  | (PendingBase & { kind: 'cancel'; appointmentId: string; start: Date });

/**
 * Everything the backend knows about one call. GPT-Live keeps the conversation;
 * this keeps the facts that decide what is allowed: who the caller is, what was
 * offered, what is waiting for a yes, and which request is current.
 */
export class CallState {
  readonly turns: Turn[] = [];
  /** The patient this call is about: the caller, or the child or relative they are calling for. */
  verifiedPatient: CallPatient | null = null;
  /** For a pet: the owner's name as the caller gave it when the pet was found. */
  verifiedOwner: string | null = null;
  verifyAttempts = 0;
  /** Details already looked up and not found: the same ones again are not another try, and not another lookup. */
  readonly identitiesTried = new Set<string>();
  /** New patients added on this call: a parent may add two children, nobody adds ten. */
  registrations = 0;
  /** The identity check has found nobody on this call: only then may the assistant add a new patient. */
  notFound = false;
  /**
   * What the caller has said about who they are (the owner's and the pet's names, the kind of animal, its sex and age,
   * the phone), as the latest identity check or registration passed it: asked once, and a correction replaces it.
   */
  readonly known = new Map<string, string>();
  /** Everything the call has established, from the caller's words, the tools and the records: never asked twice (2026-11-14). */
  readonly memory = new CallMemory();
  /** The turn from which the caller's words about being new count: after a pet or patient is found or added, it is about the next one. */
  newFromTurn = 0;
  /** The caller was asked whether the pet is new before any lookup, because they described it (its age, its sex): asked once. */
  askedIfNew = false;
  /** The owner was asked which of their pets on the number the call is for, "or a new pet": "Is it new to us?" is then never asked. */
  askedWhichPet = false;
  /**
   * A number the caller said, read back before it is searched ("That's 303-555-0130?"): its digits, when the read-back
   * was handed to the voice, and when it was said. Their yes confirms it; the digits confirmed are searched from then on.
   */
  phoneReadback: { digits: string; atMs: number; askedAtMs: number | null } | null = null;
  readonly phonesConfirmed = new Set<string>();
  /** Read-backs of a said number that the caller said were wrong: after two, the second way to find the profile. */
  readbacksWrong = 0;
  /**
   * The caller was asked for the last four digits of the number on file and the pet's name (2026-11-15), and why: two
   * wrong read-backs, or a number with no profile. Asked once; only then may verify_caller search by them.
   */
  lastFourAsked: 'wrong_readbacks' | 'no_profile' | null = null;
  /** The pet was found by the last four digits and its name: the booking tells the team so. */
  foundByLastFour = false;
  /** The digits of a number the caller gave that is not a whole one for the clinic's country: read back once, then kept as given. */
  phoneAsGiven: string | null = null;
  /** A time the caller chose before the pet or patient was found: kept, then read back and booked on a yes once they are. */
  chosen: Slot | null = null;
  /** The number they are calling from can't get texts (abroad, premium, toll-free): no text is offered again. */
  callerNotTextable = false;
  /** Slots the caller has actually been offered. A booking can only use one of these. */
  readonly offered = new Map<string, Slot>();
  pending: PendingChange | null = null;
  proposals = 0;
  /** Requests the planner has taken on this call: the first one says "One moment." when it has nothing to say after a second. */
  requestsPlanned = 0;
  /** Bumped on every delegation. Work finishing under an old revision is discarded. */
  revision = 0;
  emergency: { kind: string; atMs: number } | null = null;
  /**
   * The caller said the animal is safe after hearing the emergency script, so the call
   * may go on (a booking for a check-up, say). The emergency stays on the record. Never
   * set for a person in danger; a new emergency later in the call locks it again.
   */
  emergencyCleared = false;
  /** The assistant has said the emergency script (its hospital or number is in the captions): it is never said again unasked. */
  emergencyScriptSaid = false;
  /**
   * At a clinic for animals, a doubt about danger (the bare word "emergency", or a caller still talking after the
   * script) gets one short question: "Is Ginger in danger right now?". The caller's next words answer it: a yes holds
   * the call as an emergency, a no lets it go on. Asked once per call.
   */
  dangerQuestion: { atMs: number; askedAtMs: number | null; answered: boolean } | null = null;
  /** An emergency is holding the call: only the script, a transfer, a callback or the end. */
  get emergencyLocked() { return !!this.emergency && !this.emergencyCleared; }
  /**
   * The animal an emergency is about, as far as the call knows it (its name, its kind): after the script, a routine
   * visit for it is still refused, while another pet's needs are answered as usual (2026-11-15).
   */
  emergencyPet: { name: string | null; species: string | null } | null = null;
  /** The on-call transfer an emergency asks for has been queued: it rings once per call. */
  emergencyTransferSent = false;
  /** Staff pressed End call: the record says so, not that the assistant hung up on its own. */
  endedByStaff = false;
  /** The call is being ended for the caller's language: the goodbye has been said and nothing is planned after it. */
  endedForAbuse = false;
  /** The clinic's assistant is paused (its plan): the caller hears a short line and goes to the team, or the call ends. */
  answeringPaused = false;
  /** A request for the team (a callback, a refill) was made on this call. */
  requestMade = false;
  /** How often the assistant was told to make the callback it had promised. */
  promiseNudges = 0;
  /** The caller said they are returning a call from this number: told once that it may not have come from the clinic. */
  returnedCall = false;
  /** The caller turn last checked for a push on the rules, and how many reminders the call has had. */
  securityTurn = -1;
  securityNotes = 0;
  /** Nothing more is planned once the call is being ended, by staff, for abuse, or because the assistant is paused. */
  get ending(): boolean { return this.endedByStaff || this.endedForAbuse || this.answeringPaused; }
  /** Every emergency kind already answered, so a new kind (bleeding after chest pain) is answered too. */
  readonly emergencyKinds = new Set<string>();
  /**
   * The language the caller is being answered in: the clinic's primary language until
   * the caller's own words say otherwise. Read-backs, texts and the emergency script
   * follow it.
   */
  language: Language = 'en';
  /** A text waiting for the caller's yes. A new offer replaces it; an emergency clears it. */
  textOffer: TextOffer | null = null;
  /** What this call has changed so far, in the words read back ("booked ...", "cancelled ..."), so the backend never looks for it again or doubts it. */
  readonly done: string[] = [];
  /** The FAQ answers given on this call, by id: only those may be texted. */
  readonly answersGiven = new Set<string>();
  /** Texts sent on this call after a yes; confirmations do not count. */
  textsSent = 0;
  /** Where on the call the last yes to a text was asked: an offer counts once. */
  lastTextConsentMs = -1;
  /** After a booking, the question about reminder texts: asked once, answered once. */
  reminderOffer: { patientId: string; offeredAtMs: number; askedAtMs: number | null } | null = null;
  remindersAsked = false;
  /** When the caller last heard "still checking" on this call (wall clock), so a wait soon after does not say it again. */
  heldAtMs: number | null = null;
  /** How many times the assistant had to be told to answer a caller left waiting in silence. */
  silenceNudges = 0;
  /** Caller turns with insults or threats in them, and the last such turn (each counts once). */
  abuse = 0;
  abuseTurn = -1;
  outcome: 'booked' | 'rescheduled' | 'cancelled' | 'task_created' | 'transferred' | 'info' | 'emergency' | 'abandoned' = 'abandoned';

  /** Keeps what a caller said about who they are, from an identity check's or a registration's arguments. */
  remember(args: Record<string, unknown>) {
    for (const [key, label] of Object.entries(DETAILS)) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) this.known.set(label, value.trim());
    }
  }

  /**
   * Whether the caller has said the pet (or they) are new to the clinic, by their own words since the last pet or patient
   * was found or added: 'new' ("she's new", yes to "Is Hazel new?", or "a new one" when asked which pet), 'on_file' when they said it may be on file after
   * all, the latest of those, or null.
   */
  saidNew(): 'new' | 'on_file' | null {
    for (let i = this.turns.length - 1; i >= this.newFromTurn; i--) {
      const turn = this.turns[i]!;
      if (turn.speaker !== 'caller') continue;
      const said = newToClinic(turn.text);
      if (said) return said;
      const asked = normalise(this.turns.slice(0, i).reverse().find((t) => t.speaker === 'agent')?.text ?? '');
      // asked which pet, "or a new pet": a yes picks the pet named, and "a new one" ("una nueva") is new
      if (NEW_AS_CHOICE.test(asked)) { if (/\b(new|nuev[oa])\b/.test(normalise(turn.text))) return 'new'; continue; }
      if (ASKED_IF_NEW.test(asked) && isClearYes(turn.text, LANGUAGES)) return 'new';
    }
    return null;
  }

  /** Whether the assistant has asked if the pet (or they) are new since the last one was found or added. */
  askedWhetherNew(): boolean {
    return this.turns.slice(this.newFromTurn).some((t) => t.speaker === 'agent' && ASKED_IF_NEW.test(normalise(t.text)));
  }

  /** What the caller has said since the last pet or patient was found or added. */
  callerWordsSinceFound(): string {
    return this.turns.slice(this.newFromTurn).filter((t) => t.speaker === 'caller').map((t) => t.text).join(' ');
  }

  /** Transcript deltas arrive in fragments; consecutive fragments from one speaker join into one turn. */
  addTranscript(speaker: Turn['speaker'], delta: string, startMs: number, endMs: number) {
    const last = this.turns.at(-1);
    // The assistant often starts talking ("Sure, let me book that") before the proposal
    // is back and reads it out in the same breath, so any assistant speech after the
    // proposal counts as the read-back, not only a new turn.
    if (speaker === 'agent' && this.pending && this.pending.readbackAtMs === null && endMs > this.pending.proposedAtMs) {
      this.pending.readbackAtMs = Math.max(startMs, this.pending.proposedAtMs);
    }
    // the same for a text offer: the question is the first thing said after it
    if (speaker === 'agent' && this.textOffer && this.textOffer.askedAtMs === null && endMs > this.textOffer.offeredAtMs) {
      this.textOffer.askedAtMs = Math.max(startMs, this.textOffer.offeredAtMs);
    }
    if (speaker === 'agent' && this.reminderOffer && this.reminderOffer.askedAtMs === null && endMs > this.reminderOffer.offeredAtMs) {
      this.reminderOffer.askedAtMs = Math.max(startMs, this.reminderOffer.offeredAtMs);
    }
    if (last && last.speaker === speaker) {
      last.text = `${last.text}${delta.startsWith(' ') || last.text.endsWith(' ') ? '' : ' '}${delta}`.replace(/\s+/g, ' ');
      last.endMs = endMs;
    } else {
      this.turns.push({ speaker, text: delta.trim(), startMs, endMs });
    }
    // a card or social security number is never kept, shown or sent on, by either side
    const turn = this.turns.at(-1)!;
    turn.text = redactSensitive(turn.text);
    if (speaker === 'agent' && this.phoneReadback && this.phoneReadback.askedAtMs === null && endMs > this.phoneReadback.atMs) {
      this.phoneReadback.askedAtMs = Math.max(startMs, this.phoneReadback.atMs);
    }
    // the danger question counts as asked once the assistant's words actually ask it, not on any reply after the note
    const q = this.dangerQuestion;
    if (speaker === 'agent' && q && q.askedAtMs === null && endMs > q.atMs && ASKED_DANGER.test(normalise(turn.text))) q.askedAtMs = Math.max(startMs, q.atMs);
  }

  /** Whether the caller said yes to the read-back of these digits since it was said. */
  confirmedReadback(digits: string): boolean {
    const r = this.phoneReadback;
    if (!r || r.digits !== digits || r.askedAtMs === null) return false;
    return isClearYes(this.latestCallerWordsAfter(r.askedAtMs), LANGUAGES);
  }

  /** The caller's answer to the danger question, once: yes (in danger), no, or something else (they moved on). Null until they answer. */
  answerToDangerQuestion(): 'yes' | 'no' | 'other' | null {
    const q = this.dangerQuestion;
    if (!q || q.askedAtMs === null || q.answered) return null;
    const said = normalise(this.latestCallerWordsAfter(q.askedAtMs));
    if (!said) return null;
    q.answered = true;
    // only an answer to that question: when the assistant has said something else since ("Is it the number you're
    // calling from?"), a "yes" is about that, never about danger (a test run locked a booking on it)
    const lastAgent = [...this.turns].reverse().find((t) => t.speaker === 'agent');
    // the last question the assistant asked, not anything earlier in the same breath
    const questions = normalise(lastAgent?.text ?? '').match(/[^.!?]*\?/g) ?? [];
    if (!ASKED_DANGER.test(questions.at(-1) ?? '')) return 'other';
    if (DANGER_NO.test(said)) return 'no';
    if (DANGER_YES.test(said)) return 'yes';
    return 'other';
  }

  /**
   * The caller's latest words after the read-back began, for the confirmation check.
   * Only the latest: "hmm, maybe" followed later by a clear "yes" is a yes, and a
   * "yeah" said before the read-back never counts. Sounds the transcriber marks in
   * brackets ([breath], [clear throat]) are not words, so they change nothing.
   */
  answerToReadback(): string {
    const at = this.pending?.readbackAtMs;
    if (at === null || at === undefined) return '';
    const said = this.turns
      .filter((t) => t.speaker === 'caller' && t.startMs > at)
      .map((t) => t.text.replace(/\[[^\]]*(\]|$)/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return said.at(-1) ?? '';
  }

  /** The caller's latest words since the text offer was asked, like answerToReadback. */
  answerToTextOffer(): string {
    return this.latestCallerWordsAfter(this.textOffer?.askedAtMs ?? null);
  }

  /**
   * When the assistant offered a text on its own (the emergency script ends with one),
   * before any send_text: the start of its latest turn that mentions a text, among its
   * last two, or null. The caller's answer after it is the consent.
   */
  spokenTextOfferMs(marker: RegExp): number | null {
    const agent = this.turns.filter((t) => t.speaker === 'agent').slice(-2).reverse();
    return agent.find((t) => marker.test(t.text))?.startMs ?? null;
  }

  latestCallerWordsAfter(at: number | null): string {
    if (at === null) return '';
    const said = this.turns
      .filter((t) => t.speaker === 'caller' && t.startMs > at)
      .map((t) => t.text.replace(/\[[^\]]*(\]|$)/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return said.at(-1) ?? '';
  }

  /** What one side said in its last few turns. */
  lastTurn(speaker: 'caller' | 'agent', count = 1): string {
    return this.turns.filter((t) => t.speaker === speaker).slice(-count).map((t) => t.text).join(' ');
  }

  /** The last stretch of caller speech, for the emergency guardrail's rolling window. */
  recentCallerText(chars = 240): string {
    const text = this.turns.filter((t) => t.speaker === 'caller').slice(-3).map((t) => t.text).join(' ');
    return text.slice(-chars);
  }

  lastMs(): number {
    return this.turns.at(-1)?.endMs ?? 0;
  }
}
