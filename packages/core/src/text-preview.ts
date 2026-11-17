// SPDX-License-Identifier: AGPL-3.0-only
import type { Language } from './locales';
import { renderText, type SmsTemplateName } from './texts';

/**
 * The parts each text is sent with, besides the clinic's name: one table read by the Settings > Texting preview, so the
 * preview is the text that goes out (texts polish TX1, 2026-11-17). Settings showed a refill text as "Hi {Owner's first
 * name}, {Pet's name}'s request is ready to pick up…": the worker never sends a refill text an owner's name, and always
 * sends its request number ("Your request (R-43) is ready to pick up…"). Each sender's test compares its body with
 * textPreview of the same facts (apps/worker/test/text-preview.test.ts, packages/agent/test/text-preview.test.ts).
 *
 * A part a sender leaves out when it does not know it (the owner's name, the pet's name, the vet) is in the list: the
 * text then reads without it, as renderText words it ("Your request…", "Your visit…").
 */
export const TEXT_PARTS: Record<SmsTemplateName, readonly string[]> = {
  // a visit: the agent after a booking, a move or a cancel on a call; the worker for reminders and handovers
  booking_confirmed: ['name', 'pet', 'visit', 'provider', 'when', 'clinicPhone'],
  change_confirmed: ['name', 'pet', 'visit', 'provider', 'from', 'when', 'clinicPhone'],
  // a cancel names the pet and the time, never the vet or the kind of visit
  cancel_confirmed: ['name', 'pet', 'when', 'clinicPhone'],
  reminder: ['name', 'pet', 'visit', 'provider', 'when', 'clinicPhone'],
  vet_changed: ['name', 'pet', 'visit', 'provider', 'when', 'clinicPhone'],
  // a refill the team closed: the request's number, the pet when the request has one, the pharmacy; never a name
  request_ready: ['pet', 'ref', 'clinicPhone'],
  refill_sent: ['pet', 'ref', 'pharmacy', 'clinicPhone'],
  refill_not_approved: ['pet', 'ref', 'clinicPhone'],
  // during a call, after a yes
  directions: ['address', 'mapUrl'],
  hours: ['hours'],
  emergency_hospital: ['hospital', 'hospitalAddress', 'hospitalPhone', 'emergencyNumber'],
  provider: ['provider', 'details', 'clinicPhone'],
  answer: ['answer', 'clinicPhone'],
  link: ['label', 'url'],
};

/**
 * A text as it goes out, from every fact Settings knows (or a sender has): only the parts that text is sent with are
 * used. The Settings preview passes tags for the parts a call fills in; the tests pass a sender's real facts.
 */
export function textPreview(template: SmsTemplateName, values: Record<string, string>, language: Language = 'en', wording?: { label?: string; extra?: string }): string {
  const vars: Record<string, string> = { clinic: values.clinic ?? '' };
  for (const k of TEXT_PARTS[template]) if (values[k]) vars[k] = values[k];
  return renderText(template, vars, language, wording);
}

/** The kinds of text in the groups a clinic thinks in: Settings > Texting's sections and the Texts page's kind filter. */
export const TEXT_GROUPS = {
  visits: ['booking_confirmed', 'change_confirmed', 'cancel_confirmed', 'reminder', 'vet_changed'],
  refills: ['request_ready', 'refill_sent', 'refill_not_approved'],
  during_call: ['directions', 'hours', 'emergency_hospital', 'provider', 'answer', 'link'],
} as const satisfies Record<string, readonly SmsTemplateName[]>;
export type TextGroup = keyof typeof TEXT_GROUPS;
export const TEXT_GROUP_NAMES: Record<TextGroup, string> = { visits: 'Visits', refills: 'Refills', during_call: 'Sent during a call' };

/** "1 text", "2 texts": a count and its word, singular for one (texts polish TX6). */
export const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "1 text was not sent", "2 texts were not sent". */
export const textsNotSent = (n: number) => `${countOf(n, 'text')} ${n === 1 ? 'was' : 'were'} not sent`;
