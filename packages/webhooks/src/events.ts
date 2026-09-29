// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/** What a clinic can subscribe to. */
export const EVENT_TYPES = [
  'call.completed', 'call.summary.ready', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'request.created', 'request.done',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * An event's data: ids, times, types, outcomes and counts. Never a name, a phone
 * number, a date of birth, a transcript, a summary or a note: a receiver that needs
 * those fetches them through the API, as someone allowed to see them.
 */
export type EventData = Record<string, string | number | boolean | null>;

export interface WebhookEvent { id: string; clinicId: string; type: EventType | 'webhook.test'; occurredAt: string; data: EventData }

/** The same thing happening twice (a retried booking, a job run again) is one event. */
export const eventId = (type: string, key: string) => `evt_${createHash('sha256').update(`${type}|${key}`).digest('hex').slice(0, 24)}`;

/** The body every receiver gets, in the Standard Webhooks shape: type, timestamp, data. */
export const payloadOf = (e: WebhookEvent) => JSON.stringify({ type: e.type, timestamp: e.occurredAt, data: { clinicId: e.clinicId, ...e.data } });
