// SPDX-License-Identifier: AGPL-3.0-only
import type { EmergencyKind } from '../emergency';

export const LANGUAGES = ['en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * Everything one language needs for a call, as data. Adding a language means adding
 * one of these (and its evals); nothing else in the code should hold a sentence a
 * caller hears. docs/languages.md explains how.
 */
export interface LanguagePack {
  code: Language;
  /** The language's name, in English, for the dashboard (which stays in English). */
  name: string;
  /** Its own name for itself. */
  nativeName: string;
  /** For Intl, when a pack formats with it. */
  locale: string;

  /** Lines for the conversation prompt: tone, register, how to handle mixed speech. */
  prompt: string[];
  /** The default greeting. It must disclose that the caller is talking to an AI assistant. */
  greeting: (v: { assistantName: string | null; clinicName: string }) => string;
  /** Words that disclose an AI assistant, in this language. A greeting without them is refused. */
  disclosure: RegExp;

  /** "Tuesday, October 6 at 3:00 PM" in this language, in the clinic's zone. */
  speakWhen: (start: Date, timeZone: string) => string;
  /** A phone number read out digit by digit. */
  speakPhone: (e164: string) => string;
  /** The read-back before a booking or a move. */
  /** `providerKind` is how the provider is named: "with" a person, "in" a room. */
  readbackBooking: (v: { when: string; provider: string; providerKind: 'person' | 'room'; visit: string; replacing: string | null }) => string;
  /** The read-back before a cancellation. */
  readbackCancel: (v: { when: string }) => string;

  /** Text messages: when and where, never why. */
  sms: {
    booking_confirmed: (v: Record<string, string>) => string;
    /** A request the team approved is ready to pick up: never what it is. */
    request_ready: (v: Record<string, string>) => string;
    /** A refill the team sent to the caller's pharmacy: where, never what, and never the word refill. */
    refill_sent: (v: Record<string, string>) => string;
    /** A refill the team did not approve: please call, never why or what. */
    refill_not_approved: (v: Record<string, string>) => string;
    /** A visit moved or cancelled on the phone: sent without asking, like the booking one. */
    change_confirmed: (v: Record<string, string>) => string;
    cancel_confirmed: (v: Record<string, string>) => string;
    /** Texted during a call, only after the caller said yes to the offer. */
    directions: (v: Record<string, string>) => string;
    hours: (v: Record<string, string>) => string;
    emergency_hospital: (v: Record<string, string>) => string;
    provider: (v: Record<string, string>) => string;
    answer: (v: Record<string, string>) => string;
    link: (v: Record<string, string>) => string;
    /** Sent before a visit to someone who said yes to reminders: when, and how to confirm. A pet is named; a person is not. */
    reminder: (v: Record<string, string>) => string;
  };
  /** The question before an in-call text: to the number they are calling from, or the one on their file. */
  textOffer: (v: { target: 'this' | 'file' }) => string;
  /** Said once the text has gone. */
  textSent: string;
  /** Said instead of texting. */
  textRefused: (v: { reason: 'opted_out' | 'off' }) => string;
  /** Monday first: "Mon" … "Sun", for a short hours text. */
  shortDays: [string, string, string, string, string, string, string];
  /** Asked once after a booking, when the clinic sends reminders and the caller has not agreed yet. */
  reminderOffer: string;
  /** Asked before a refill request is logged, when texting is on: only a yes gets the team's decision by text. */
  refillTextOffer: string;
  /**
   * The one question about the caller's phone number for a new pet or patient: on a call with caller ID,
   * whether that number is the best one; with none (a browser test call, a hidden number), the best number.
   */
  phoneQuestion: (v: { callerId: boolean }) => string;
  /**
   * Asked once caller ID matched and the owner said who they are: which of their pets the call is for, by
   * first name (at most three; `more` when they have others), or a new one.
   */
  whichPet: (v: { names: string[]; more: boolean }) => string;
  /**
   * A pet's last visit, said as the last one Attendra can see: it knows only the visits booked or recorded in
   * it, so it never says "the last visit" as if it were the whole history. `when` is speakWhen's.
   */
  lastVisitSeen: (v: { pet: string; when: string; provider: string | null; visit: string | null }) => string;
  /** Offered instead of any medical detail or a copy of the records: the team sends records in writing. */
  recordsOffer: string;
  /**
   * Said once when the number a caller gives is not a whole number for the clinic's country (a number abroad, no area
   * code): it is read back as given and kept, never asked for again. `digits`: the number as the caller said it.
   */
  phoneAsGiven: (v: { digits: string }) => string;
  /** Asked before any lookup when a caller describes a pet (its age, its sex) and has not said whether it is new. */
  petNewQuestion: (v: { pet: string }) => string;
  /** Said with a read-back when a confirmation text will follow, so the caller's yes covers it and they can say no to the text alone. */
  confirmTextNote: (v: { target: 'calling' | 'file' }) => string;
  /** The answer to a reply of C to a reminder. */
  smsConfirmed: (v: { clinic: string; when: string }) => string;
  /** The answer to a text sent to the clinic's number that is not STOP or START: replies are not read. */
  smsNoReplies: (v: { clinicPhone: string }) => string;

  /** The fixed emergency instruction, with the clinic's emergency number. */
  emergencyScript: (emergencyNumber: string) => string;
  /** The one warning an insulting caller hears, and the goodbye when the call is ended for it: said word for word. */
  abuseWarning: string;
  abuseGoodbye: string;
  /** Said word for word when a person takes the call over, before the transfer. */
  takeOver: string;
  /**
   * The backend's own words for the caller, spoken as they are when a tool's result is the whole answer, so the model is
   * not asked again (2026-11). Each ends with the next question when one follows (the reminder offer, anything else?).
   */
  spoken: {
    /** A booking or a move read back as a question, with the confirmation-text note when a text will follow. */
    readback: (v: { readback: string; textNote: string | null }) => string;
    /** A cancellation read back as a question. */
    cancelReadback: (v: { readback: string; textNote: string | null }) => string;
    /** The change is made; `then` is the question that follows (the reminder offer, or anything else?). */
    done: (v: { kind: 'booked' | 'rescheduled' | 'cancelled'; textSent: boolean; then: string }) => string;
    /** The closing question, in the words saidGoodbye listens for. */
    anythingElse: string;
    /** The goodbye once the caller said no or goodbye: never the greeting's words again. */
    goodbye: string;
    /** A callback request taken: the team will call, at the number they are calling from or the one they gave. */
    callbackTaken: (v: { sameNumber: boolean }) => string;
    /** A refill request logged: with the team, never approved or timed. */
    refillTaken: string;
    /** A text just sent. */
    textSent: string;
    /** The caller's answer to the reminder offer, acknowledged. */
    reminders: (v: { agreed: boolean }) => string;
    /** No vet here sees this kind of animal: the one vet's limit when there is one, then the request offered. */
    noVetForAnimal: (v: { vet: string | null; animals: string | null; pet: string }) => string;
    /**
     * Said the moment the backend starts a lookup, so the caller never waits in silence: what it is doing, in a few
     * words, never a result. `day` is already in the caller's words ("today", "Thursday"); `pet` the pet's name.
     */
    lookingUp: (v: { kind: 'times' | 'times_on' | 'pet' | 'info' | 'visits'; day?: string | null; pet?: string | null }) => string;
    /** A day as people say it when a time is read back or looked up: today, tomorrow, or the weekday. `weekday` is 0 for Sunday. */
    dayWord: (v: { daysFromToday: number; weekday: number }) => string;
  };
  /** Said when an answer takes too long (the deadline), and when a request fails: never a claim that it worked. */
  tooSlow: string;
  couldNotFinish: string;
  /** The fixed self-harm instruction. `crisisLine` is 988 in the United States, and absent where there is no national line. */
  selfHarmScript: (emergencyNumber: string, crisisLine: string | null) => string;
  /** Emergency phrases, in every script and spelling a transcriber may return. Reviewed like decision 0005. */
  emergencyPhrases: [EmergencyKind, RegExp][];
  /** "It is not an emergency": honoured for the generic word only. */
  notAnEmergency: RegExp;

  /** A clear yes, in the caller's own words. */
  yes: RegExp;
  /**
   * Words that are a yes only when they are the whole answer: "vale" or "confirm" said
   * alone is a yes; inside a sentence ("I need to confirm with my wife") it is not.
   */
  yesAlone: RegExp;
  /** Anything that makes a yes not count: a no, a wait, a maybe, a question. */
  hedge: RegExp;

  /** Words that suggest a caller is speaking this language, for choosing the reply language. */
  markers: RegExp;

  /** The caller says the pet (or they) are new to the clinic: "she's new", "he's not registered", "first time". */
  saysNew: RegExp;
  /** The caller says it may be on file after all: "she's already a patient", "he's been there before", "not new". */
  saysOnFile: RegExp;
  /** The caller describes the pet the way a new client does: its age ("a year old") or its sex ("a female"). */
  describesPet: RegExp;
  /** The whole "name" only points at a pet, with no name in it: "the other one", "my cat", "not the dog". */
  pointsAtPet: RegExp;
}

/** Word edges that work for any script: JavaScript's \b only knows ASCII letters. */
export const B = String.raw`(?<![\p{L}\p{M}\p{N}])`;
export const E = String.raw`(?![\p{L}\p{M}\p{N}])`;
/** Canonical form: NFC, with accents on Latin letters dropped (so "sí" and "si" meet). Other scripts are left whole. */
export const fold = (text: string) => text.normalize('NFD').replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1').normalize('NFC');

/**
 * A regular expression from alternatives, matched as whole words in any script.
 * The alternatives are folded like the text they meet, so a pattern typed with an
 * accent matches the text however it was composed.
 */
export const words = (alternatives: string, flags = 'u') => new RegExp(`${B}(?:${fold(alternatives)})${E}`, flags);

/** Lower case, curly quotes straightened, Latin accents removed, spaces collapsed. What every pattern is matched against. */
export function normalise(text: string) {
  return fold(text).toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
}
