// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { bigserial, boolean, customType, integer, jsonb, numeric, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  createdByUserId: text('created_by_user_id'),
  cancelKey: text('cancel_key'),
  cancelledByCallId: uuid('cancelled_by_call_id'),
  cancelledByUserId: text('cancelled_by_user_id'),
  cancelReason: text('cancel_reason', { enum: ['patient_asked', 'clinic_asked', 'booked_in_error', 'other'] }),
  noteEnc: text('note_enc'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
  patientId: uuid('patient_id'),
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
  outcome: text('outcome', { enum: ['called_back', 'left_message', 'refill_sent', 'not_needed'] }),
  assignedByUserId: text('assigned_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const taskNotes = pgTable('task_notes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clinicId: text('clinic_id').notNull(),
  taskId: uuid('task_id').notNull(),
  authorUserId: text('author_user_id').notNull(),
  bodyEnc: text('body_enc').notNull(),
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
  // how much, never what: { transcriptLines: 412, summaries: 9 }
  counts: jsonb('counts').$type<Record<string, number>>(),
});

export const callSummaries = pgTable('call_summaries', {
  callId: uuid('call_id').primaryKey(),
  clinicId: text('clinic_id').notNull(),
  bodyEnc: text('body_enc').notNull(),
  intent: text('intent', { enum: ['book', 'reschedule', 'cancel', 'refill', 'question', 'callback', 'emergency', 'other'] }).notNull(),
  sentiment: text('sentiment', { enum: ['calm', 'frustrated', 'distressed'] }).notNull(),
  needsReview: boolean('needs_review').notNull(),
  model: text('model').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedByUserId: text('reviewed_by_user_id'),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const smsMessages = pgTable('sms_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  template: text('template').notNull(),
  toHash: text('to_hash').notNull(),
  status: text('status').notNull().default('queued'),
  idempotencyKey: text('idempotency_key').notNull(),
  providerSid: text('provider_sid'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
// generated by Postgres from heading and body; never written
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  title: text('title').notNull(),
  sourceType: text('source_type', { enum: ['text', 'markdown', 'pdf'] }).notNull(),
  content: bytea('content').notNull(),
  contentHash: text('content_hash').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  status: text('status', { enum: ['queued', 'indexing', 'ready', 'failed'] }).notNull().default('queued'),
  failure: text('failure'),
  chunkCount: integer('chunk_count').notNull().default(0),
  indexedHash: text('indexed_hash'),
  embeddingModel: text('embedding_model'),
  uploadedByUserId: text('uploaded_by_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clinicId: text('clinic_id').notNull(),
  documentId: uuid('document_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  heading: text('heading'),
  body: text('body').notNull(),
  tokenCount: integer('token_count').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  model: text('model').notNull(),
  tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(heading, '') || ' ' || body)`),
});

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  url: text('url').notNull(),
  description: text('description').notNull().default(''),
  events: text('events').array().notNull(),
  secretEnc: text('secret_enc').notNull(),
  previousSecretEnc: text('previous_secret_enc'),
  previousExpiresAt: timestamp('previous_expires_at', { withTimezone: true }),
  enabled: boolean('enabled').notNull().default(true),
  disabledReason: text('disabled_reason'),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  omitPatientIds: boolean('omit_patient_ids').notNull().default(true),
});

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  clinicId: text('clinic_id').notNull(),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookAttempts = pgTable('webhook_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  clinicId: text('clinic_id').notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  eventId: text('event_id').notNull(),
  kind: text('kind', { enum: ['automatic', 'test', 'redelivery'] }).notNull(),
  attempt: integer('attempt').notNull(),
  statusCode: integer('status_code'),
  durationMs: integer('duration_ms').notNull(),
  error: text('error'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes').array().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
