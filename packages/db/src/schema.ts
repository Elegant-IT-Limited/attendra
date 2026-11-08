// SPDX-License-Identifier: AGPL-3.0-only
import { EMERGENCY_RESULTS } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { bigserial, boolean, customType, date, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';

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
  /** Seconds of browser test calls the clinic may use in all; null is no limit. Not part of the settings staff edit. */
  testSecondsLimit: integer('test_seconds_limit'),
  /** The hosting layer's plan (status, minutes included, period, trial end); null on a self-hosted install. Not part of the settings staff edit. */
  hostingPlan: jsonb('hosting_plan'),
  /** When the organization closed this clinic (a location removed): it leaves the dashboard and answers no calls. Null while open. */
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** One more on every save of the settings, so a save made from an older copy is refused. */
  configVersion: integer('config_version').notNull().default(1),
  configUpdatedAt: timestamp('config_updated_at', { withTimezone: true }),
  configUpdatedBy: text('config_updated_by'),
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
  identityHash: text('identity_hash'),
  guardianNameEnc: text('guardian_name_enc'),
  genderEnc: text('gender_enc'),
  speciesEnc: text('species_enc'),
  customEnc: text('custom_enc'),
  /** Keyed hashes of each word of the owner's and the patient's names, and of the phone's last four digits (migration 0042). Search reads patient_search_keys since 0049. */
  ownerWordsHash: text('owner_words_hash').array(),
  phoneSuffixHash: text('phone_suffix_hash'),
  /** They agreed to reminder texts: when, and how (on a call, at the desk, in an import). */
  smsConsentAt: timestamp('sms_consent_at', { withTimezone: true }),
  smsConsentSource: text('sms_consent_source', { enum: ['call', 'staff', 'import'] }),
  status: text('status', { enum: ['active', 'new'] }).notNull().default('active'),
  createdByCallId: uuid('created_by_call_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** A record staff deleted (migration 0054): no name, number, date of birth or details left, kept so its past visits still count. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
});

/** A patient's search keys (migration 0049): shortened keyed hashes, looked up by equality so the index serves them under Row Level Security. */
export const patientSearchKeys = pgTable('patient_search_keys', {
  clinicId: text('clinic_id').notNull(),
  key: text('key').notNull(),
  patientId: uuid('patient_id').notNull(),
}, (t) => [primaryKey({ columns: [t.clinicId, t.key, t.patientId] })]);

/** A call's search keys (migration 0049): the digit runs of the number it came from. Deleted with the number. */
export const callSearchKeys = pgTable('call_search_keys', {
  clinicId: text('clinic_id').notNull(),
  key: text('key').notNull(),
  callId: uuid('call_id').notNull(),
}, (t) => [primaryKey({ columns: [t.clinicId, t.key, t.callId] })]);

/** A POST's idempotency key and its kept answer (migration 0052; idempotency.ts): per sender and path, 24 hours, the answer encrypted. */
export const idempotencyKeys = pgTable('idempotency_keys', {
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  /** Null while the first request is still being answered. */
  status: integer('status'),
  response: text('response'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.scope, t.key] })]);

export const appointments = pgTable('appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  patientId: uuid('patient_id').notNull(),
  providerId: text('provider_id').notNull(),
  visitTypeId: text('visit_type_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** booked, arrived, completed, no_show or cancelled (core visit-status.ts; migration 0054). */
  status: text('status', { enum: ['booked', 'arrived', 'completed', 'no_show', 'cancelled'] }).notNull().default('booked'),
  /** When, and by whom (a staff member's id), the desk last set arrived, completed, no-show or back to booked (migration 0054). */
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
  statusChangedBy: text('status_changed_by'),
  idempotencyKey: text('idempotency_key').notNull(),
  createdByCallId: uuid('created_by_call_id'),
  createdByUserId: text('created_by_user_id'),
  cancelKey: text('cancel_key'),
  cancelledByCallId: uuid('cancelled_by_call_id'),
  cancelledByUserId: text('cancelled_by_user_id'),
  cancelReason: text('cancel_reason', { enum: ['patient_asked', 'clinic_asked', 'booked_in_error', 'other'] }),
  noteEnc: text('note_enc'),
  /** The reminder text, once claimed and sent. */
  reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
  reminderSmsId: uuid('reminder_sms_id'),
  /** The owner confirmed the visit (replied C to the reminder), or staff marked it. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmedVia: text('confirmed_via', { enum: ['text', 'staff'] }),
  /** Why the front desk booked it outside the hours, when it did. */
  overrideReason: text('override_reason'),
  /**
   * ends_at plus the visit type's buffer (cleaning time), set by the database on every write (migration 0053): the
   * double-booking exclusion covers [starts_at, blocks_until). Never written by the application.
   */
  blocksUntil: timestamp('blocks_until', { withTimezone: true }),
  /** When it was cancelled: set by the cancel (and by the database when a cancel did not say). */
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  openaiSessionId: text('openai_session_id').notNull(),
  fromHash: text('from_hash'),
  /** The caller's number, encrypted: for calling them back. Cleared with the transcript. */
  fromEnc: text('from_enc'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  outcome: text('outcome'),
  emergencyFlag: boolean('emergency_flag').notNull().default(false),
  /** The language the call ended in, for texts sent after it. */
  language: text('language'),
  voiceSeconds: numeric('voice_seconds', { precision: 10, scale: 2 }),
  closeReason: text('close_reason'),
  channel: text('channel', { enum: ['phone', 'web'] }).notNull().default('phone'),
  patientId: uuid('patient_id'),
  /** A browser test call started "as" a number: its last four digits only (migration 0043). Null on every phone call. */
  calledAsLast4: text('called_as_last4'),
  /** How long after the answer the caller first heard the assistant; null when they never did (migration 0044). */
  firstAudioMs: integer('first_audio_ms'),
  /** Caller turns met by 5 s of silence with nothing coming back (migration 0044). */
  stalls: integer('stalls'),
  /** Answers past the 60 s limit, apologised for (migration 0044). */
  answerTimeouts: integer('answer_timeouts'),
  /** Which engine answered, its own id for the call, and how the turns were answered (migration 0045). */
  engine: text('engine', { enum: ['gpt-live', 'gpt-realtime', 'vapi'] }),
  engineSessionId: text('engine_session_id'),
  voiceFlow: text('voice_flow', { enum: ['planner', 'tools'] }),
  /** How an animal's emergency on the call ended (migration 0050); null when the call had none. */
  emergencyResult: text('emergency_result', { enum: EMERGENCY_RESULTS }),
  /** The longest the caller waited after speaking for the assistant to start its reply, in ms (migration 0055); null when none. */
  maxGapMs: integer('max_gap_ms'),
  /** Questions the assistant asked again after they were answered (migration 0055, core repeatedQuestions). */
  repeatedQuestions: integer('repeated_questions'),
});

/** What one call cost us, from the rates table in core (call-costs.ts): numbers only (migration 0045). */
export const callCosts = pgTable('call_costs', {
  callId: uuid('call_id').primaryKey(),
  clinicId: text('clinic_id').notNull(),
  engine: text('engine', { enum: ['gpt-live', 'gpt-realtime', 'vapi'] }).notNull(),
  voiceSeconds: numeric('voice_seconds', { precision: 10, scale: 2 }),
  voiceUsd: numeric('voice_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  modelTokens: jsonb('model_tokens').notNull().default({}),
  modelUsd: numeric('model_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  texts: integer('texts').notNull().default(0),
  textsUsd: numeric('texts_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  telephonyUsd: numeric('telephony_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  totalUsd: numeric('total_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  ratesVersion: text('rates_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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

/** The next request number per clinic: advanced in the insert's own transaction, so numbers are consecutive and never reused. */
export const clinicCounters = pgTable('clinic_counters', {
  clinicId: text('clinic_id').primaryKey(),
  nextRequest: integer('next_request').notNull().default(1),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: text('clinic_id').notNull(),
  /** The request's own number at this clinic, shown as R-1042: in the order they came in, never reused (migration 0041). */
  number: integer('number').notNull(),
  /** The household it belongs to: the owner's phone as the keyed hash patients carry, when the number is on file. */
  householdHash: text('household_hash'),
  type: text('type', { enum: ['callback', 'refill', 'voicemail', 'review', 'follow_up'] }).notNull(),
  status: text('status', { enum: ['open', 'done'] }).notNull().default('open'),
  callId: uuid('call_id'),
  patientId: uuid('patient_id'),
  detailsEnc: text('details_enc').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  assigneeUserId: text('assignee_user_id'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  doneAt: timestamp('done_at', { withTimezone: true }),
  doneByUserId: text('done_by_user_id'),
  outcome: text('outcome', { enum: ['called_back', 'left_message', 'refill_sent', 'refill_ready', 'refill_declined', 'not_needed', 'details_confirmed'] }),
  assignedByUserId: text('assigned_by_user_id'),
  /** Who at the clinic wrote it down by hand (migration 0040); null for the assistant's own. */
  createdByUserId: text('created_by_user_id'),
  urgent: boolean('urgent').notNull().default(false),
  /** 'emergency' for the urgent request an emergency leaves (migration 0050); null for every other request. */
  origin: text('origin', { enum: ['emergency'] }),
  dueOn: date('due_on', { mode: 'string' }),
  /** The clinic's own details on the request, encrypted JSON. */
  customEnc: text('custom_enc'),
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
  kind: text('kind', { enum: ['auto', 'asked', 'reminder'] }).notNull().default('auto'),
  callId: uuid('call_id'),
  patientId: uuid('patient_id'),
  taskId: uuid('task_id'),
  appointmentId: uuid('appointment_id'),
  language: text('language').notNull().default('en'),
  consentAtMs: integer('consent_at_ms'),
  errorCode: text('error_code'),
  failureReason: text('failure_reason'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

/** A number's standing with a clinic: the latest STOP or START wins. Only the number's hash. */
export const smsOptOuts = pgTable('sms_opt_outs', {
  clinicId: text('clinic_id').notNull(),
  toHash: text('to_hash').notNull(),
  status: text('status', { enum: ['opted_out', 'opted_in'] }).notNull(),
  source: text('source', { enum: ['keyword', 'carrier', 'staff'] }).notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.clinicId, t.toHash] })]);

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
  extractedChars: integer('extracted_chars'),
  pageCount: integer('page_count'),
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
