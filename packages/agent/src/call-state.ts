// SPDX-License-Identifier: AGPL-3.0-only
import { type CallPatient, isClearYes, type Language, LANGUAGES, newToClinic, normalise, redactSensitive, type Slot } from '@attendra/core';

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
/** The assistant asked whether the pet (or the caller) is new: "Is Orbit new to the clinic?", "¿Orbit es nuevo?". */
const ASKED_IF_NEW = /\b(new|nuev[oa]s?)\b[^.!]*\?/;

export type PendingChange =
  | (PendingBase & { kind: 'book'; slot: Slot; replacesAppointmentId: string | null })
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
  /** The turn from which the caller's words about being new count: after a pet or patient is found or added, it is about the next one. */
  newFromTurn = 0;
  /** A time the caller chose before the pet or patient was found: kept, then read back and booked on a yes once they are. */
  chosen: Slot | null = null;
  /** The number they are calling from can't get texts (abroad, premium, toll-free): no text is offered again. */
  callerNotTextable = false;
  /** Slots the caller has actually been offered. A booking can only use one of these. */
  readonly offered = new Map<string, Slot>();
  pending: PendingChange | null = null;
  proposals = 0;
  /** Bumped on every delegation. Work finishing under an old revision is discarded. */
  revision = 0;
  emergency: { kind: string; atMs: number } | null = null;
  /**
   * The caller said the animal is safe after hearing the emergency script, so the call
   * may go on (a booking for a check-up, say). The emergency stays on the record. Never
   * set for a person in danger; a new emergency later in the call locks it again.
   */
  emergencyCleared = false;
  /** An emergency is holding the call: only the script, a transfer, a callback or the end. */
  get emergencyLocked() { return !!this.emergency && !this.emergencyCleared; }
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
   * was found or added: 'new' ("she's new", or yes to "Is Orbit new?"), 'on_file' when they said it may be on file after
   * all, the latest of those, or null.
   */
  saidNew(): 'new' | 'on_file' | null {
    for (let i = this.turns.length - 1; i >= this.newFromTurn; i--) {
      const turn = this.turns[i]!;
      if (turn.speaker !== 'caller') continue;
      const said = newToClinic(turn.text);
      if (said) return said;
      const asked = this.turns.slice(0, i).reverse().find((t) => t.speaker === 'agent');
      if (asked && ASKED_IF_NEW.test(normalise(asked.text)) && isClearYes(turn.text, LANGUAGES)) return 'new';
    }
    return null;
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
