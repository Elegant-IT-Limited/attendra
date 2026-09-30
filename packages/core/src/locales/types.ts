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
  };

  /** The fixed emergency instruction, with the clinic's emergency number. */
  emergencyScript: (emergencyNumber: string) => string;
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
