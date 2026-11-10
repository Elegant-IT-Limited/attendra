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

  /**
   * A time as it is said on a call and written in a text: fullWhen, every time (2026-11-14). `now` is kept for callers
   * that pass it and changes nothing: "today" and "Thursday" alone left the date to the caller.
   */
  speakWhen: (start: Date, timeZone: string, now?: Date) => string;
  /**
   * A time said in full, every time, in the clinic's zone: the weekday, the date and the time, never the year
   * ("Wednesday, November 4, at 5:20 PM", "el miércoles 4 de noviembre a las 5:20 de la tarde"). Built from parts, so
   * it does not depend on the ICU version Node ships.
   */
  fullWhen: (start: Date, timeZone: string) => string;
  /** A clinic-local date (YYYY-MM-DD) as a day: "Wednesday, November 4", "miércoles 4 de noviembre" (no article). */
  fullDay: (date: string) => string;
  /** A phone number read out digit by digit. */
  speakPhone: (e164: string) => string;
  /** The read-back before a booking or a move. */
  /** `providerKind` is how the provider is named: "with" a person, "in" a room. */
  /**
   * `replacing`: the time being moved from (fullWhen), and then the read-back says both times in full ("move Biscuit's
   * check-up from Wednesday, November 4, at 5:20 PM to ..."); `shift` how the day changes (dayShift), when it does.
   */
  readbackBooking: (v: { when: string; provider: string; providerKind: 'person' | 'room'; visit: string; replacing: string | null; pet?: string | null; shift?: string | null }) => string;
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
    /** A visit handed to another vet when its vet is removed (same day and time): sent only after the team said yes, to people who agreed to texts. */
    vet_changed: (v: Record<string, string>) => string;
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
  /**
   * Settings' warning for a visit type nobody can be booked for (2026-11-15): the dashboard shows the clinic's language,
   * the Spanish twin is here so the words live in one place. `pets` names a vet, else a doctor.
   */
  noProviderForVisit: (v: { visit: string; pets: boolean }) => string;
  /** Said instead of texting. */
  textRefused: (v: { reason: 'opted_out' | 'off' }) => string;
  /** Monday first: "Mon" … "Sun", for a short hours text. */
  shortDays: [string, string, string, string, string, string, string];
  /** Asked once after a booking, when the clinic sends reminders and the caller has not agreed yet. */
  reminderOffer: string;
  /** Asked before a refill request is logged, when texting is on: only a yes gets the team's decision by text. */
  refillTextOffer: string;
  /**
   * At a clinic for people, on a call with caller ID: whether the number they are calling from is the best one for a new
   * patient. A clinic for animals asks profileNumberQuestion instead (2026-11-14).
   */
  sameNumberQuestion: string;
  /** The number to call back, for a callback request only (never for a booking): "What's the best number to reach you?". */
  callbackNumberQuestion: string;
  /** Asked once on a number the caller said, before anything from its records is used: "And your name?". */
  yourNameQuestion: string;
  /**
   * The same question at a veterinary clinic, where the profile is the household's (2026-11-11): asked after each number
   * read back, for that number, when no owner's name was given for it. Never answered by a pet's name or by the name
   * checked on another number.
   */
  ownerNameQuestion: string;
  /**
   * The pick question once the caller is known (caller ID, or a spoken number whose name matched the owner on file):
   * thanks by the owner's first name, then the pets by first name ("Thanks, Jordan. Is this for Biscuit or Pepper, or a
   * new pet?"). `more`: they have others; `offerNew`: the caller has not said the pet is new.
   */
  whichPetVerified: (v: { owner: string; names: string[]; more: boolean; offerNew: boolean }) => string;
  /** A verified caller who named the pet at once is thanked by the owner's name on file, before the pet found: "Thanks, Jordan." */
  thanksOwner: (v: { owner: string }) => string;
  /** The one question when "next Wednesday" could be either week: "This Wednesday, November 4, or Wednesday, November 11?". Dates are YYYY-MM-DD. */
  whichWeek: (v: { first: string; second: string }) => string;
  /** The note the team sees on a booking made on a number whose owner on file did not match the name the caller gave. */
  bookedByCallerNote: (v: { name: string }) => string;
  /** The team's note on a booking for a pet found by the last four digits of its number and its name, not the whole number. */
  foundByLastFourNote: string;
  /** The words that pick facts out of what a caller says, for the call memory (memory-words.ts). Closed lists only. */
  memory: MemoryWords;
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
  /**
   * The first question when a caller wants to book, move or cancel at a clinic for animals: the number the pet's profile
   * is under. With caller ID, offered by its last four digits ("ending 0123").
   */
  profileNumberQuestion: (v: { last4: string | null }) => string;
  /** A number the caller said, read back in groups before it is searched: "That's 303-555-0130?". */
  phoneReadback: (v: { grouped: string }) => string;
  /** Said first after a lookup finds the pet: "I found Ginger, your dog." `species` as on the record, or null. */
  foundPet: (v: { pet: string; species: string | null }) => string;
  /** Said first when the pet named is not on the number: "I don't see Ginger under that number." */
  notSeenPet: (v: { pet: string }) => string;
  /** Said first when a number has no pets on file at all: then a new owner and pet the usual way. */
  noPetsOnNumber: string;
  /** A number the caller said, not confirmed by the owner's name (or with no profile on it): the one answer for both, so a caller can't tell whether the number belongs to a client (2026-11-09). */
  numberNotOpened: string;
  /**
   * The second way to find a pet's profile, asked once: after two read-backs the caller said were wrong
   * ('wrong_readbacks'), or a number with no profile on it ('no_profile', which also offers to add a new pet). The
   * last four digits of the number on file and the pet's name; never a number or a name from the records.
   */
  lastFourQuestion: (v: { after: 'wrong_readbacks' | 'no_profile' }) => string;
  /** Said first when the last four digits and the pet's name do not find exactly one household: then a request for the team. */
  lastFourNoMatch: string;
  /**
   * A visit the team books itself, asked for directly: why, the notice when set (in English words, "25 hours", "3 days"),
   * then both next steps: a request for the team, or the related visit the caller can book now.
   */
  teamBooks: (v: { visit: string; notice: string | null; related: string | null }) => string;
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
  /**
   * After an animal's emergency script, to a caller who still wants a visit for that pet or asks for something: no
   * routine visit for it on this call, and the next step, the team now (`transfer`: a line takes calls and the clinic is
   * open) or an urgent request. `pet`: its name, or null. The hospital is never said again unless they ask.
   */
  petEmergencyNext: (v: { pet: string | null; transfer: boolean }) => string;
  /** The one warning an insulting caller hears, and the goodbye when the call is ended for it: said word for word. */
  abuseWarning: string;
  abuseGoodbye: string;
  /** Said word for word when a person takes the call over, before the transfer. */
  takeOver: string;
  /**
   * Said once, word for word, to a caller returning a call from this number: the assistant never calls out, so the
   * call they got may not have come from the clinic. Then the choice: a client with a request, or a message.
   */
  returnedCallLine: (v: { clinic: string }) => string;
  /**
   * The backend's own words for the caller, spoken as they are when a tool's result is the whole answer, so the model is
   * not asked again (2026-11). Each ends with the next question when one follows (the reminder offer, anything else?).
   */
  spoken: {
    /** A booking or a move read back as a question, with the confirmation-text note when a text will follow. */
    readback: (v: { readback: string; textNote: string | null; move?: boolean }) => string;
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
    /** A request taken during an animal's emergency: with the team as urgent, at the top of their list. */
    urgentRequestTaken: string;
    /** A text just sent. */
    textSent: string;
    /** The caller's answer to the reminder offer, acknowledged. */
    reminders: (v: { agreed: boolean }) => string;
    /** No vet here sees this kind of animal: the one vet's limit when there is one, then the request offered. */
    noVetForAnimal: (v: { vet: string | null; animals: string | null; pet: string }) => string;
    /** A person was asked for and no line takes transfers now: said so once, and the message offered at once. */
    noTransfer: string;
    /**
     * Said the moment the backend starts a lookup, so the caller never waits in silence: what it is doing, in a few
     * words, never a result. `day` is already in the caller's words ("today", "Thursday"); `pet` the pet's name.
     */
    lookingUp: (v: { kind: 'times' | 'times_on' | 'pet' | 'info' | 'visits' | 'number'; day?: string | null; pet?: string | null }) => string;
    /** Said once, on the first request of a call, when the backend has said nothing after a second: never a silence. */
    oneMoment: string;
    /** A day as people say it when a time is read back or looked up: today, tomorrow, or the weekday. `weekday` is 0 for Sunday. */
    dayWord: (v: { daysFromToday: number; weekday: number }) => string;
    /**
     * Several times offered at once, grouped by day so each date is said once: "On Wednesday, November 4, I have 8:00,
     * 8:40 or 9:20 AM." With `provider` on a time, each time says its vet; `provider` for them all, once at the end.
     */
    offerTimes: (v: { days: OfferDay[]; provider: string | null }) => string;
    /**
     * How a move shifts the day, said after the read-back when the dates differ: "that's one week later, Wednesday,
     * November 11". `days` is the new date minus the old (never 0); `day` the new day's words (fullDay).
     */
    dayShift: (v: { days: number; day: string }) => string;
  };
  /** find_slots' direct answers, reasons and the front-desk sentence. */
  slots: SlotLines;
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

/** One day of offered times: the day (YYYY-MM-DD) and its times, each as hour and minutes on the 24-hour clock. */
/** A time of day, 24-hour. */
export interface Clock { hour: number; minute: number }
/** How a provider is referred to again in a sentence: "she", "he", or their name when the clinic did not say. */
export type Pronoun = 'female' | 'male' | null;

/**
 * find_slots' own lines (2026-11-15): the direct answer to "is 4 PM free?" first, the true reason when nothing fits,
 * and the front-desk sentence for a vet who works outside the clinic's hours. `date` is clinic-local YYYY-MM-DD.
 */
export interface SlotLines {
  /** "Yes, 4:00 PM on Tuesday, November 11 is free with Dr. Rahman. Shall I book it?" */
  exactFree: (v: { date: string; time: Clock; provider: string | null }) => string;
  /** "Not at 4:00, but 3:50 or 4:20 PM on Tuesday, November 11." */
  notAt: (v: { time: Clock; day: OfferDay }) => string;
  /** "The nearest is 9:00 AM on Friday, November 6." */
  nearest: (v: { day: OfferDay }) => string;
  /** Before a read-back of another time than the one the caller asked for: "9:30 AM isn't free." */
  askedNotFree: (v: { time: Clock }) => string;
  /** Before times for a patient who already has one booked: "Biscuit already has a visit booked: wellness exam, ... with Dr. Ruiz." */
  alreadyBooked: (v: { name: string; visit: string; when: string; provider: string | null; more: number }) => string;
  /** The asked time is outside the vet's hours that day: "Dr. Vance starts at 9 on Fridays." (or "finishes at 6"). */
  vetHours: (v: { provider: string; weekday: number; starts: Clock | null; ends: Clock | null }) => string;
  /**
   * A time the vet keeps while the clinic's front desk is closed: "The clinic's front desk is closed on Sundays, but Dr.
   * Vance sees patients Sunday from 9 to 1." With the clinic open part of that day, its opening or closing time; with
   * `oneDay` (a holiday or a special day the vet is listed for), that date instead of the weekday.
   */
  frontDesk: (v: { weekday: number; provider: string; from: Clock; to: Clock; clinicOpens: Clock | null; clinicCloses: Clock | null; oneDay?: string | null }) => string;
  /** "Dr. Vance doesn't do dental care; her visits are surgery and new client exam. Dr. Bennett and Dr. Khan do dental care. Shall I look with them?" */
  doesntDoType: (v: { provider: string; pronoun: Pronoun; visit: string; theirVisits: string[]; others: string[] }) => string;
  /** "Dr. Vance doesn't work on Tuesdays. She's in Wednesday to Friday and Sunday." `days` 0 = Sunday. */
  notWorkingThatDay: (v: { provider: string; pronoun: Pronoun; weekday: number; days: number[] }) => string;
  /** "Dr. Vance is fully booked on Friday, November 6." */
  fullyBooked: (v: { provider: string | null; date: string }) => string;
  /** Nothing at all in the search: "I can't find a free time with Dr. Vance through Friday, December 4." */
  nothingThrough: (v: { provider: string | null; date: string }) => string;
  /** "We book dental cleanings up to 30 days ahead, so the last day I can book is Friday, December 4." */
  tooFarAhead: (v: { visit: string; days: number; lastDate: string }) => string;
  /** "A dental cleaning needs 48 hours' notice, so the first day I can book is Friday, November 6." */
  notice: (v: { visit: string; hours: number; firstDate: string }) => string;
  /** "The clinic is closed on Thursday, November 26 (Thanksgiving)." */
  clinicClosed: (v: { date: string; note: string | null }) => string;
}

export interface OfferDay { date: string; times: { hour: number; minute: number; provider: string | null }[] }

/**
 * Closed word lists, matched against normalised text (lower case, no accents), that fill the call memory from the
 * caller's own words. No free-text guessing: a word that is not on a list is not a fact.
 */
export interface MemoryWords {
  /** The kind of animal, as the caller says it after "my", "a", "our": word to the English name kept in the memory. */
  species: Record<string, string>;
  /** Words that say the pet's sex on their own ("female", "a girl"; "perra", "hembra"). */
  female: RegExp;
  male: RegExp;
  /** He or she, counted only in a turn that also names the animal. */
  she: RegExp;
  he: RegExp;
  /** "2 years old", "six months old", "tiene 2 años": the number word (group 1) and the unit (group 2). */
  age: RegExp;
  /** Number words, as the age is said: "two" to 2. */
  numbers: Record<string, number>;
  /** What the call is about. */
  /** `book`: words that ask for a visit on their own; `visit` ("a check-up", "una cita") asks only next to a `want` word, so "how long does a check-up take" is a question, not a booking. */
  intent: { book: RegExp; visit: RegExp; want: RegExp; move: RegExp; cancel: RegExp };
  /** Weekday names, Sunday first, and month names, January first, as matched (normalised). */
  weekdays: string[];
  months: string[];
  today: RegExp;
  tomorrow: RegExp;
  /** The word before a weekday that means the coming one ("this", "este") and the one that may mean the week after ("next", "el próximo"). */
  thisWord: string;
  nextWord: string;
  /** "Any doctor is fine", "whoever": a vet the caller named earlier no longer holds. */
  anyVet: RegExp;
  /** "Any day", "the first available": what the caller said about the day no longer holds. */
  anyDay: RegExp;
  /**
   * A time of day the caller asked for: group 1 the word before it ("at", "around", "after"; "a las", "después de las"),
   * group 2 the hour, group 3 the minutes, group 4 the part of the day (am/pm, "de la tarde").
   */
  time: RegExp;
  /** Words before a time that mean "no earlier than" rather than "at about". */
  after: RegExp;
  /** Words before a time that mean "no later than": "earlier than 6", "before 6". */
  before: RegExp;
  /** Words before a time that mean either side of it: "around 5". */
  around: RegExp;
  /** Parts of the day after a time that put it in the afternoon or evening. */
  pm: RegExp;
  am: RegExp;
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

/** How many clinic-local days `start` is after `now`: 0 the same day, 1 tomorrow; negative in the past. */
export function daysAhead(start: Date, timeZone: string, now: Date): number {
  const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const [a, b] = [local(start), local(now)];
  return Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000);
}
