// SPDX-License-Identifier: AGPL-3.0-only
import type { Gender } from './clinic';
import type { Language, LanguagePack } from './locales';
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
  type: 'call.completed' | 'call.summary.ready' | 'appointment.booked' | 'appointment.rescheduled' | 'appointment.cancelled' | 'appointment.confirmed' | 'request.created' | 'request.done';
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

/** A verified patient as a call knows them: enough to book, confirm by text and pick a doctor who sees their age. */
export interface CallPatient { id: string; firstName: string; phone: string | null; dob: string; isNew: boolean; gender: Gender | null; /** The kind of animal, for a pet. */ species?: string | null; /** They agreed to reminder texts. */ textsOk?: boolean }

export type PatientLookup =
  | { status: 'found'; patient: CallPatient } // phone on file, for confirmations
  | { status: 'not_found' }
  | { status: 'ambiguous' }; // two records share name, date of birth and phone; staff must sort it out

export type Registration =
  | { status: 'created'; patient: CallPatient; similar: boolean } // similar: someone else has this name and date of birth with another phone
  | { status: 'exists'; patient: CallPatient } // the same person is already on file: they are simply verified
  | { status: 'limited' }; // this phone number already added MAX_NEW_PATIENTS_PER_PHONE_PER_DAY patients in the last 24 hours

/**
 * How many new patients the assistant may add on one phone number in 24 hours,
 * across all calls. A family shares a phone, so this leaves room for a parent and
 * their children; past it, a caller cannot fill the clinic with made-up records.
 */
export const MAX_NEW_PATIENTS_PER_PHONE_PER_DAY = 5;

/**
 * Patients as a call reaches them. A patient is one person: name, date of birth and
 * the phone number on file together. Names and birthdays repeat, and a family shares
 * one phone (a parent and their children), so no one of them is enough on its own.
 */
export interface PatientDirectory {
  findByIdentity(clinicId: string, fullName: string, dob: string, phone: string): Promise<PatientLookup>;
  register(clinicId: string, p: { firstName: string; lastName: string; dob: string; gender: Gender; phone: string; guardianName: string | null; callId: string; species?: string | null }): Promise<Registration>;
  /**
   * A pet, by its owner's name (the record's guardian), its own name and the phone on
   * file. The same answer as findByIdentity: found, nobody, or two records only staff
   * can tell apart.
   */
  findPet(clinicId: string, ownerName: string, petName: string, phone: string): Promise<PatientLookup>;
  /** Records that they said yes to reminder texts on a call. */
  setTextConsent?(clinicId: string, patientId: string, callId: string): Promise<void>;
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
  | { status: 'slot_taken' }
  | { status: 'patient_busy' }; // the patient already has a visit that overlaps it

export interface SchedulerAdapter {
  busy(clinicId: string, providerIds: string[], from: Date, to: Date): Promise<{ providerId: string; start: Date; end: Date; visitTypeId?: string }[]>;
  /** `replacesAppointmentId`: the visit this booking moves, which does not count as a clash. */
  book(clinicId: string, input: { patientId: string; slot: Slot; callId: string; idempotencyKey: string; replacesAppointmentId?: string | null }): Promise<BookingResult>;
  cancel(clinicId: string, input: { patientId: string; appointmentId: string; callId: string; idempotencyKey: string }): Promise<{ status: 'cancelled' | 'already_done' | 'not_found' }>;
  upcoming(clinicId: string, patientId: string, now: Date): Promise<AppointmentSummary[]>;
  /** Past visits, for the patient's usual provider. Without it, nobody counts as usual. */
  history?(clinicId: string, patientId: string, now: Date): Promise<{ providerId: string; start: Date }[]>;
}

/** follow_up: a call that ended with the caller's request unfinished, opened after the call for staff to pick up. */
export type TaskType = 'callback' | 'refill' | 'voicemail' | 'review' | 'follow_up';

export interface TaskQueue {
  create(clinicId: string, input: {
    type: TaskType; callId: string; patientId: string | null; idempotencyKey: string;
    details: Record<string, string>; // stored encrypted; shown to staff, never logged
  }): Promise<{ id: string; created: boolean }>;
}

export interface AuditLog {
  record(clinicId: string, entry: { actor: string; action: string; entity: string; entityId: string | null; callId?: string }): Promise<void>;
}

export type SmsTemplate = keyof LanguagePack['sms'];
/** Why a text did not go: refused before the carrier, or refused by it. */
export type TextRefusal = 'opted_out' | 'rate_limited' | 'monthly_limit' | 'not_textable' | 'no_number' | 'texting_off' | 'unregistered' | 'carrier' | 'test_call';

export interface TextRequest {
  to: string; template: SmsTemplate; vars: Record<string, string>; idempotencyKey: string; language?: Language;
  /** 'auto' a confirmation, 'asked' sent in a call after the caller said yes, 'reminder'. */
  kind?: 'auto' | 'asked' | 'reminder';
  /** What the text is about, so staff can see it was sent. Ids only. */
  about?: { callId?: string | null; patientId?: string | null; taskId?: string | null; appointmentId?: string | null };
  /** Where on the call the caller said yes (kind 'asked'). */
  consentAtMs?: number | null;
  /** A browser test call: recorded as not sent, never sent, so staff see what a caller would have got. */
  testCall?: boolean;
}

export type TextResult =
  | { status: 'sent'; messageId: string }
  | { status: 'already'; messageId: string } // the same key was already sent
  | { status: 'not_sent'; reason: TextRefusal; messageId: string | null };

export interface Messenger {
  // templates only: free text could carry PHI to a carrier that has no BAA.
  // Never throws: the caller (a booking, a job) decides what to say about a text that did not go.
  sendTemplate(clinicId: string, input: TextRequest): Promise<TextResult>;
  /** Whether a number has opted out of this clinic's texts (replied STOP), so the assistant does not offer one. */
  optedOut?(clinicId: string, to: string): Promise<boolean>;
}
