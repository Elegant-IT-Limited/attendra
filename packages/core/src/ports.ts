// SPDX-License-Identifier: AGPL-3.0-only
import type { Language } from './locales';
import type { Slot } from './slots';

/**
 * The backend's ports. The agent depends only on these; packages/db and
 * packages/scheduling implement them on Postgres, and the tests and the eval
 * simulator implement them in memory. Every method takes the clinic id first so
 * no call can forget which tenant it acts for.
 */

/**
 * Something that happened, for the clinic's webhooks. `key` makes it one event however
 * often it is emitted (a retried booking is the same booking). Data is ids, times,
 * codes and counts only: never a name, a number, a date of birth or free text.
 */
export interface DomainEvent {
  type: 'call.completed' | 'call.summary.ready' | 'appointment.booked' | 'appointment.rescheduled' | 'appointment.cancelled' | 'request.created' | 'request.done';
  key: string;
  occurredAt?: Date;
  data: Record<string, string | number | boolean | null>;
}

export interface EventSink {
  emit(clinicId: string, event: DomainEvent): Promise<void>;
}

/** A passage from one of the clinic's own documents: policies, directions, preparation, provider bios. Never patient data. */
export interface KnowledgePassage { documentId: string; title: string; text: string }

export interface KnowledgeBase {
  /** The best passages for a question, at most four, or none. */
  search(clinicId: string, question: string): Promise<KnowledgePassage[]>;
}

export type PatientLookup =
  | { status: 'found'; patient: { id: string; firstName: string; phone: string | null } } // phone on file, for confirmations
  | { status: 'not_found' }
  | { status: 'ambiguous' }; // two records share name and DOB; staff must sort it out

export interface PatientDirectory {
  findByNameAndDob(clinicId: string, fullName: string, dob: string): Promise<PatientLookup>;
}

export interface AppointmentSummary {
  id: string;
  providerId: string;
  visitTypeId: string;
  start: Date;
  end: Date;
}

export type BookingResult =
  | { status: 'booked'; appointment: AppointmentSummary }
  | { status: 'already_done'; appointment: AppointmentSummary } // same idempotency key seen before
  | { status: 'slot_taken' };

export interface SchedulerAdapter {
  busy(clinicId: string, providerIds: string[], from: Date, to: Date): Promise<{ providerId: string; start: Date; end: Date }[]>;
  book(clinicId: string, input: { patientId: string; slot: Slot; callId: string; idempotencyKey: string }): Promise<BookingResult>;
  cancel(clinicId: string, input: { patientId: string; appointmentId: string; callId: string; idempotencyKey: string }): Promise<{ status: 'cancelled' | 'already_done' | 'not_found' }>;
  upcoming(clinicId: string, patientId: string, now: Date): Promise<AppointmentSummary[]>;
}

export type TaskType = 'callback' | 'refill' | 'voicemail' | 'review';

export interface TaskQueue {
  create(clinicId: string, input: {
    type: TaskType; callId: string; patientId: string | null; idempotencyKey: string;
    details: Record<string, string>; // stored encrypted; shown to staff, never logged
  }): Promise<{ id: string; created: boolean }>;
}

export interface AuditLog {
  record(clinicId: string, entry: { actor: string; action: string; entity: string; entityId: string | null; callId?: string }): Promise<void>;
}

export interface Messenger {
  // templates only: free text could carry PHI to a carrier that has no BAA
  sendTemplate(clinicId: string, input: { to: string; template: 'booking_confirmed' | 'booking_cancelled'; vars: Record<string, string>; idempotencyKey: string; language?: Language }): Promise<void>;
}
