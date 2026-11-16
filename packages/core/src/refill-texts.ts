// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which refill decisions text the caller, and when one does not: the one rule the worker sends by, the request's
 * outcome labels say and Settings > Texting explains (note 2026-11-16 RF2). A decision texts the number the request
 * was left with, once the team closes the refill with it:
 * - "Sent to the pharmacy": the "Refill sent to the pharmacy" text, naming the pharmacy (never the medicine); not when
 *   no pharmacy was given or it is picked up at the clinic;
 * - "Approved, ready to pick up": the "Refill ready to pick up" text;
 * - "Not approved": the "Refill: please call us" text.
 * Never to a caller who said no to texts on the call (a request from a call texts only on a yes); a request the team
 * wrote down itself texts unless it says no. Texting being off, a number that can't get texts or STOP are the
 * messenger's to refuse, and are recorded as a text not sent.
 */
export const REFILL_DECISIONS = ['refill_sent', 'refill_ready', 'refill_declined'] as const;
export type RefillDecision = (typeof REFILL_DECISIONS)[number];
export type RefillTextTemplate = 'refill_sent' | 'request_ready' | 'refill_not_approved';
/** Why a decision sends no text: the caller said no (or never said yes) on the call; no pharmacy to name. */
export type RefillNoText = 'no_consent' | 'no_pharmacy';

export const REFILL_TEXT_OF: Record<RefillDecision, RefillTextTemplate> = { refill_sent: 'refill_sent', refill_ready: 'request_ready', refill_declined: 'refill_not_approved' };
export const isRefillDecision = (o: string | null | undefined): o is RefillDecision => (REFILL_DECISIONS as readonly string[]).includes(o ?? '');

/** A pharmacy that is really "pick it up here". */
const PICK_UP = /pick ?up|clinic|recoger/i;

/** The text a refill decision sends on this request, or why none. Null for an outcome that never texts. */
export function refillText(outcome: string | null | undefined, task: { type: string; fromCall: boolean; details: Record<string, string | undefined> }):
  { template: RefillTextTemplate; pharmacy?: string } | { none: RefillNoText } | null {
  if (task.type !== 'refill' || !isRefillDecision(outcome)) return null;
  const said = task.details.texts;
  if (task.fromCall ? said !== 'yes' : said === 'no') return { none: 'no_consent' };
  const template = REFILL_TEXT_OF[outcome];
  if (template !== 'refill_sent') return { template };
  const pharmacy = task.details.pharmacy?.trim();
  return !pharmacy || PICK_UP.test(pharmacy) ? { none: 'no_pharmacy' } : { template, pharmacy };
}

/** Why no text went, in the team's words. */
export const REFILL_NO_TEXT: Record<RefillNoText, string> = {
  no_consent: 'the caller did not say yes to texts',
  no_pharmacy: 'no pharmacy named',
};
