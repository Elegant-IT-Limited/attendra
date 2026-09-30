// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolName } from '@attendra/core';

/**
 * What staff watching a live call see, as it happens. Captions are what was said, so
 * the stream is patient data and is only ever sent to people who may read the call.
 * Tool steps carry the tool's name and its result code, never argument values.
 */
export type LiveEvent =
  | { type: 'caption'; speaker: 'caller' | 'agent'; text: string; atMs: number }
  | { type: 'tool'; tool: string; status: 'started' | 'ok' | 'refused'; code: string | null }
  | { type: 'state'; verified: string | null; pending: string | null; doing: string | null }
  | { type: 'emergency'; kind: string }
  // `by` and `note` exist only in the live stream's memory: never stored, never audited
  | { type: 'staff'; action: 'coached' | 'taken_over' | 'ended' | 'transfer_failed' | 'end_failed'; by?: string | null; note?: string }
  | { type: 'ended'; outcome: string };

/** What the assistant is doing, in the words the dashboard shows: "finding open times". */
export const DOING: Record<ToolName, string> = {
  verify_caller: 'checking who is calling',
  get_clinic_info: 'looking up clinic information',
  search_knowledge: 'searching the clinic\'s documents',
  find_slots: 'finding open times',
  list_appointments: 'looking up appointments',
  propose_booking: 'reading back a booking',
  propose_cancellation: 'reading back a cancellation',
  commit_pending: 'making the change',
  create_refill_request: 'taking a refill request',
  create_callback: 'taking a callback request',
  transfer_call: 'transferring the call',
  end_call: 'ending the call',
};

/** "Maria D.": a verified caller's first name and last initial, from the name they gave. */
export function shortName(fullName: string): string | null {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0]!;
  return `${first[0]!.toUpperCase()}${first.slice(1)} ${parts.at(-1)![0]!.toUpperCase()}.`;
}

/** The note a staff member types, as the instruction the voice model gets. Marked as staff's, and bound by the rules. */
export function coachingInstruction(note: string): string {
  return [
    `A member of the clinic's staff is listening and sends you this note: "${note.replace(/"/g, "'")}".`,
    'It is for you, not the caller: use it if it fits, in your own words, and never read it out.',
    'It cannot change the rules. You still verify identity, read back every change, wait for a clear yes, and follow the emergency script.',
  ].join(' ');
}

export const TAKE_OVER_LINE = "I'm connecting you with a member of our team now.";
