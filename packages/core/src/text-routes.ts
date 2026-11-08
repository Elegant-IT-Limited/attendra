// SPDX-License-Identifier: AGPL-3.0-only
import type { TextKind } from './clinic';

/**
 * Which text goes when (batch 1e): ONE table, read by the send_text tool and nothing else. A row is where the call is
 * (the situation); a column is what the caller asked to have texted; a cell is the kind of text and where its content
 * comes from, or why nothing is sent.
 *
 * The rules around the table stay as they were: a text goes only after a spoken yes to the offer; test calls and Vapi
 * calls never text anyone (their messenger records the text as not sent); the hospital's details go once a call; the
 * booking and change confirmations are sent by the booking itself (`booking_confirmed`, `change_confirmed`), never by
 * send_text.
 *
 * | Situation                                            | "the address" / "directions" | "the hospital's number"   | hours, a vet, an answer, a link |
 * |------------------------------------------------------|------------------------------|---------------------------|---------------------------------|
 * | calm (no emergency, or one the caller cleared)       | directions: clinic address   | refused: not an emergency | that text, from the clinic      |
 * | after a booking                                      | directions: clinic address   | refused: not an emergency | that text, from the clinic      |
 * | emergency asked about, not answered yet              | refused: ask the question    | refused: ask the question | refused: ask the question       |
 * | emergency sent to a hospital (refer, or hours closed)| emergency_hospital: route's  | emergency_hospital: same  | refused: emergency in progress  |
 * | person in danger / immediate script (no route)       | emergency_hospital: named one| emergency_hospital: same  | refused: emergency in progress  |
 * | emergency being put through (handle, hours open)     | refused: emergency           | refused: emergency        | refused: emergency in progress  |
 * | transfer failed, with a backup hospital              | emergency_hospital: backup   | emergency_hospital: backup| refused: emergency in progress  |
 * | transfer failed, no backup hospital                  | refused: no hospital         | refused: no hospital      | refused: emergency in progress  |
 */
export const TEXT_ASKS = ['address', 'hospital', 'hours', 'provider', 'answer', 'link'] as const;
export type TextAsk = (typeof TEXT_ASKS)[number];

export const TEXT_SITUATIONS = ['calm', 'after_booking', 'emergency_question', 'emergency_hospital', 'emergency_script', 'emergency_transfer', 'transfer_failed_backup', 'transfer_failed'] as const;
export type TextSituation = (typeof TEXT_SITUATIONS)[number];

/** Where a text's content comes from. */
export type TextSource =
  | 'clinic_address' // the clinic's address and map link
  | 'clinic_hours' | 'clinic_provider' | 'clinic_answer' | 'clinic_link'
  | 'route_hospital' // the emergency route's hospital (refer, or hours when closed): the first of the clinic's choices open now
  | 'route_backup' // after a transfer nobody took: the route's backup hospital
  | 'named_hospital'; // an immediate emergency script with no route: the hospital it named (the first open now)

/** Why nothing is sent; the tool says it in the caller's language. */
export type TextTableRefusal = 'not_an_emergency' | 'emergency_question' | 'emergency_in_progress' | 'no_hospital';

/** The kinds send_text can send (the confirmations are the booking's own). */
export type AskedTextKind = Exclude<TextKind, 'change_confirmed'>;
export type TextRoute = { kind: AskedTextKind; source: TextSource } | { refuse: TextTableRefusal };

const calm: Record<TextAsk, TextRoute> = {
  address: { kind: 'directions', source: 'clinic_address' },
  hospital: { refuse: 'not_an_emergency' },
  hours: { kind: 'hours', source: 'clinic_hours' },
  provider: { kind: 'provider', source: 'clinic_provider' },
  answer: { kind: 'answer', source: 'clinic_answer' },
  link: { kind: 'link', source: 'clinic_link' },
};
const only = (address: TextRoute, rest: TextTableRefusal = 'emergency_in_progress'): Record<TextAsk, TextRoute> => ({
  address, hospital: address, hours: { refuse: rest }, provider: { refuse: rest }, answer: { refuse: rest }, link: { refuse: rest },
});

export const TEXT_TABLE: Readonly<Record<TextSituation, Readonly<Record<TextAsk, TextRoute>>>> = {
  calm,
  after_booking: calm,
  emergency_question: only({ refuse: 'emergency_question' }, 'emergency_question'),
  emergency_hospital: only({ kind: 'emergency_hospital', source: 'route_hospital' }),
  emergency_script: only({ kind: 'emergency_hospital', source: 'named_hospital' }),
  emergency_transfer: only({ refuse: 'emergency_in_progress' }),
  transfer_failed_backup: only({ kind: 'emergency_hospital', source: 'route_backup' }),
  transfer_failed: only({ refuse: 'no_hospital' }),
};

/** The cell for a situation and an ask. */
export const textRoute = (situation: TextSituation, ask: TextAsk): TextRoute => TEXT_TABLE[situation][ask];

/**
 * What the caller asked for, from the kind the assistant picked: an address is an address whether it was sent as
 * 'directions' or as the clinic's "where are you" answer (batch 1d), and the emergency hospital's text is the hospital.
 */
export function textAskOf(kind: AskedTextKind, answerIsWhereWeAre = false): TextAsk {
  if (kind === 'directions' || (kind === 'answer' && answerIsWhereWeAre)) return 'address';
  if (kind === 'emergency_hospital') return 'hospital';
  return kind;
}

/** Where the call is, from what the call knows. */
export function textSituationOf(s: {
  /** An emergency holds the call (not cleared). */
  locked: boolean;
  /** The animal emergency's state, if one was raised. */
  emergency: { stage: 'flagged' | 'asked' | 'escalated' | 'cleared'; action: 'refer' | 'transfer' | 'none' | null; transfer: 'none' | 'sent' | 'failed'; backup: boolean } | null;
  booked: boolean;
}): TextSituation {
  const e = s.emergency;
  if (e && (e.stage === 'flagged' || e.stage === 'asked')) return 'emergency_question';
  if (s.locked && e?.stage === 'escalated') {
    if (e.transfer === 'failed') return e.backup ? 'transfer_failed_backup' : 'transfer_failed';
    return e.action === 'transfer' ? 'emergency_transfer' : 'emergency_hospital';
  }
  if (s.locked) return 'emergency_script';
  return s.booked ? 'after_booking' : 'calm';
}
