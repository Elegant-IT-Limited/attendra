// SPDX-License-Identifier: AGPL-3.0-only
import type { SmsTemplateName } from '@attendra/core';
import { TEXT_NOT_SENT } from './format';

/**
 * What each kind of text is called, the one table Settings > Texting, a pet's Texts tab, the clinic's recent texts, the
 * call page and the visit panel all use (text history, 2026-11-16). A vet's or doctor's details take the clinic's word.
 */
export const TEXT_KINDS: Record<SmsTemplateName, string> = {
  booking_confirmed: 'Booking confirmed', change_confirmed: 'Visit moved', cancel_confirmed: 'Visit cancelled', reminder: 'Reminder before a visit', vet_changed: 'Visit handed to another vet',
  directions: 'Address and directions', hours: 'Opening hours', emergency_hospital: 'Emergency hospital', provider: 'A vet\'s details',
  answer: 'An answer to a common question', link: 'One of your links',
  request_ready: 'Refill ready to pick up', refill_sent: 'Refill sent to the pharmacy', refill_not_approved: 'Refill: please call us',
};

/** A kind of text by its name, with the clinic's word for who is booked ("A doctor's details" at a medical clinic). */
export const textKind = (template: string, provider = 'vet') =>
  template === 'provider' ? `A ${provider}'s details` : TEXT_KINDS[template as SmsTemplateName] ?? template.replaceAll('_', ' ');

type Status = { status: string; failureReason: string | null; errorCode: string | null };
/** Where a text is, in the team's words: "Waiting", "Sent", "Delivered", "Not sent: <plain reason>". */
export function textStatusWords(t: Status): string {
  switch (t.status) {
    case 'queued': return 'Waiting';
    case 'sent': return 'Sent';
    case 'delivered': return 'Delivered';
    case 'not_sent': return `Not sent: ${TEXT_NOT_SENT[t.failureReason ?? ''] ?? 'the reason was not recorded'}`;
    default: return `Not sent: the carrier refused it${t.errorCode ? ` (error ${t.errorCode})` : ''}`;
  }
}
export const textTone = (t: Pick<Status, 'status'>): 'ok' | 'warn' | 'danger' | 'neutral' =>
  t.status === 'delivered' || t.status === 'sent' ? 'ok' : t.status === 'queued' ? 'neutral' : t.status === 'not_sent' ? 'warn' : 'danger';
