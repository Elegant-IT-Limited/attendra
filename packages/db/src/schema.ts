// SPDX-License-Identifier: AGPL-3.0-only
import { bigserial, boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Typed views of the SQL migrations. The SQL file is the source of truth;
// constraints and policies live there, not here.

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  plan: text('plan').notNull().default('self_hosted'),
  baaSignedAt: timestamp('baa_signed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clinics = pgTable('clinics', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  config: jsonb('config').notNull(),
});

export const phoneNumbers = pgTable('phone_numbers', {
  e164: text('e164').primaryKey(),
  clinicId: text('clinic_id').notNull(),
  twilioSid: text('twilio_sid'),
  status: text('status').notNull(),
});

export const patients = pgTable('patients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  lookupHash: text('lookup_hash').notNull(),
  firstNameEnc: text('first_name_enc').notNull(),
  lastNameEnc: text('last_name_enc').notNull(),
  dobEnc: text('dob_enc').notNull(),
  phoneEnc: text('phone_enc'),
  phoneHash: text('phone_hash'),
  externalRef: text('external_ref'),
});

export const appointments = pgTable('appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  patientId: uuid('patient_id').notNull(),
  providerId: text('provider_id').notNull(),
  visitTypeId: text('visit_type_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['booked', 'cancelled'] }).notNull().default('booked'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdByCallId: uuid('created_by_call_id'),
  cancelKey: text('cancel_key'),
  cancelledByCallId: uuid('cancelled_by_call_id'),
});

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  openaiSessionId: text('openai_session_id').notNull(),
  fromHash: text('from_hash'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  outcome: text('outcome'),
  emergencyFlag: boolean('emergency_flag').notNull().default(false),
  voiceSeconds: numeric('voice_seconds', { precision: 10, scale: 2 }),
  closeReason: text('close_reason'),
  channel: text('channel', { enum: ['phone', 'web'] }).notNull().default('phone'),
});

export const callSegments = pgTable('call_segments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clinicId: text('clinic_id').notNull(),
  callId: uuid('call_id').notNull(),
  speaker: text('speaker', { enum: ['caller', 'agent'] }).notNull(),
  textEnc: text('text_enc').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
});

export const callActions = pgTable('call_actions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clinicId: text('clinic_id').notNull(),
  callId: uuid('call_id').notNull(),
  tool: text('tool').notNull(),
  argsRedacted: jsonb('args_redacted').notNull(),
  result: jsonb('result').notNull(),
  idempotencyKey: text('idempotency_key'),
  taskRevision: integer('task_revision').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  type: text('type', { enum: ['callback', 'refill', 'voicemail', 'review'] }).notNull(),
  status: text('status', { enum: ['open', 'done'] }).notNull().default('open'),
  callId: uuid('call_id'),
  patientId: uuid('patient_id'),
  detailsEnc: text('details_enc').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  assigneeUserId: text('assignee_user_id'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  doneAt: timestamp('done_at', { withTimezone: true }),
  doneByUserId: text('done_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clinicId: text('clinic_id').notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  callId: uuid('call_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
});

export const smsMessages = pgTable('sms_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  template: text('template').notNull(),
  toHash: text('to_hash').notNull(),
  status: text('status').notNull().default('queued'),
  idempotencyKey: text('idempotency_key').notNull(),
});
