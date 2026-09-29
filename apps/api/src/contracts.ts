// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

// The dashboard's HTTP contract. Request schemas are enforced by the API; response
// schemas document it (OpenAPI at /api/docs) and give the web app its types.

export const Role = z.enum(['owner', 'admin', 'staff', 'viewer']);

export const Health = z.object({
  ok: z.boolean(),
  demoMode: z.boolean(),
  // only on a local demo (`pnpm demo`); a deployed demo never publishes its password
  demoSignIn: z.object({ password: z.string(), logins: z.array(z.object({ email: z.string(), label: z.string() })) }).optional(),
});

export const Me = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), twoFactorEnabled: z.boolean(), mustChangePassword: z.boolean() }),
  demoMode: z.boolean(),
  /** Whether this deployment has a voice service for test calls from the browser. */
  testCalls: z.boolean(),
  /** Whether it can play a simulated call, with no audio, to show a live call. The local demo only. */
  simulatedCalls: z.boolean(),
  clinics: z.array(z.object({ id: z.string(), name: z.string(), timezone: z.string(), role: Role, permissions: z.array(z.string()) })),
});

/** An opaque cursor: the last call's exact start time and id, so equal timestamps page correctly. */
export const callCursor = {
  encode: (c: { cursor: string; id: string }) => Buffer.from(`${c.cursor}|${c.id}`).toString('base64url'),
  decode: (s: string) => {
    const [startedAt, id] = Buffer.from(s, 'base64url').toString().split('|');
    return startedAt && id && !Number.isNaN(Date.parse(startedAt)) && z.uuid().safeParse(id).success ? { startedAt, id } : null;
  },
};

export const Page = z.object({
  before: z.string().max(200).optional().transform((v, ctx) => {
    if (v === undefined) return undefined;
    const c = callCursor.decode(v);
    if (!c) { ctx.addIssue({ code: 'custom', message: 'not a cursor from this API' }); return z.NEVER; }
    return c;
  }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const CallSummary = z.object({
  id: z.string(),
  /** The verified patient's name, for roles that may read calls; null for everyone else, and for calls nobody was verified on. */
  patientName: z.string().nullable(),
  channel: z.enum(['phone', 'web']),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  outcome: z.string().nullable(),
  emergency: z.boolean(),
  closeReason: z.string().nullable(),
  voiceSeconds: z.number().nullable(),
  tools: z.array(z.string()),
  verified: z.boolean(),
  /** From the call's summary, once the worker has written it: codes only. */
  intent: z.enum(['book', 'reschedule', 'cancel', 'refill', 'question', 'callback', 'emergency', 'other']).nullable(),
  sentiment: z.enum(['calm', 'frustrated', 'distressed']).nullable(),
  /** Flagged for review and nobody has reviewed it yet. */
  needsReview: z.boolean(),
});
export const CallList = z.object({
  calls: z.array(CallSummary), next: z.string().nullable(),
  /** A search stopped at its cap: there may be more matches. */
  truncated: z.boolean().optional(),
});

const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');
const CallFilters = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional(),
  outcome: z.enum(['booked', 'rescheduled', 'cancelled', 'task_created', 'transferred', 'info', 'emergency', 'abandoned']).optional(),
  channel: z.enum(['phone', 'web']).optional(),
  emergency: boolParam.optional(),
  review: z.literal('needed').optional(),
  refusal: z.string().regex(/^[a-z_]{2,40}$/).optional(),
});
/** The call list's filters, in clinic-time days (`to` is inclusive). */
export const CallQuery = Page.extend(CallFilters.shape);
/** A name search is a POST: a name is PHI and stays out of URLs. */
export const CallSearch = z.object({
  query: z.string().trim().min(2, 'type at least two characters').max(100),
  from: CallFilters.shape.from, to: CallFilters.shape.to, outcome: CallFilters.shape.outcome, channel: CallFilters.shape.channel,
  emergency: z.boolean().optional(),
  review: z.literal('needed').optional(),
});

/** The worker's summary of a call, for staff. Written from the transcript; never medical advice. */
export const CallSummaryCard = z.object({
  summary: z.string(),
  intent: CallSummary.shape.intent.unwrap(),
  sentiment: CallSummary.shape.sentiment.unwrap(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  followUp: z.string().nullable(),
  /** The model that wrote it, or "local" for a summary written from the call's facts alone. */
  model: z.string(),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewedBy: z.string().nullable(),
});

export const CallDetail = CallSummary.omit({ tools: true, verified: true, patientName: true, intent: true, sentiment: true, needsReview: true }).extend({
  /** The patient the agent verified on this call, if it verified anyone. */
  patient: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** What the call booked or cancelled, for "Booked: Tue 6 Oct 3:00 PM with Dr. Okafor". */
  appointments: z.array(z.object({
    id: z.string(), startsAt: z.iso.datetime(), providerId: z.string(), visitTypeId: z.string(),
    status: z.enum(['booked', 'cancelled']), change: z.enum(['booked', 'cancelled']),
  })),
  transcript: z.array(z.object({ speaker: z.enum(['caller', 'agent']), text: z.string(), startMs: z.number(), endMs: z.number() })),
  actions: z.array(z.object({ tool: z.string(), argumentNames: z.array(z.string()), result: z.record(z.string(), z.unknown()), revision: z.number(), at: z.iso.datetime() })),
  tasks: z.array(z.object({ id: z.string(), type: z.string(), status: z.string() })),
  summary: CallSummaryCard.nullable(),
  /** While there is no summary: whether the worker is on it, or gave up. */
  summaryJob: z.object({ state: z.string(), failure: z.string().nullable() }).nullable(),
});

/** The calls going on now. Codes only; the verified caller's short name only for roles that may read calls. */
export const LiveCall = z.object({
  callId: z.string(), channel: z.enum(['phone', 'web']), startedAt: z.iso.datetime(),
  verified: z.boolean(),
  /** "Maria D.", for roles that may read calls. */
  caller: z.string().nullable(),
  doing: z.string().nullable(), waitingForYes: z.boolean(), emergency: z.boolean(),
});
export const LiveCalls = z.object({ calls: z.array(LiveCall), counts: z.object({ live: z.number(), emergencies: z.number() }) });
const actionKey = z.string().min(8).max(100);
export const LiveCoach = z.object({ note: z.string().trim().min(1, 'write a note first').max(300, 'keep it to 300 characters'), key: actionKey });
export const LiveTakeOver = z.object({ target: z.enum(['front_desk', 'me']), key: actionKey });
export const LiveEnd = z.object({ key: actionKey });
export const TransferNumber = z.object({ number: z.string().regex(/^\+[1-9]\d{7,14}$/, 'a full number with the country code, like +13035550123').nullable() });

/** A document in the clinic's knowledge. Clinic information, never patient data. */
export const KnowledgeDocument = z.object({
  id: z.string(), title: z.string(), sourceType: z.enum(['text', 'markdown', 'pdf']), sizeBytes: z.number(),
  status: z.enum(['queued', 'indexing', 'ready', 'failed']), failure: z.string().nullable(), chunkCount: z.number(),
  uploadedBy: z.string().nullable(), updatedAt: z.iso.datetime(),
});
export const KnowledgeDocuments = z.object({ documents: z.array(KnowledgeDocument) });
export const KnowledgeUpload = z.object({ title: z.string().trim().min(1, 'give the document a title').max(200), name: z.string().max(200).default('') });
export const KnowledgeAsk = z.object({ question: z.string().trim().min(2, 'ask a question').max(300) });
export const KnowledgeAnswer = z.object({
  answer: z.string(),
  citations: z.array(z.object({ documentId: z.string(), title: z.string(), text: z.string() })),
  refusal: z.enum(['medical', 'no_information']).nullable(),
});

export const WEBHOOK_EVENTS = ['call.completed', 'call.summary.ready', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'request.created', 'request.done'] as const;
export const WebhookEndpoint = z.object({
  id: z.string(), url: z.string(), description: z.string(), events: z.array(z.enum(WEBHOOK_EVENTS)), enabled: z.boolean(),
  /** repeated_failures when Attendra turned it off, turned_off when someone did. */
  disabledReason: z.string().nullable(), disabledAt: z.iso.datetime().nullable(), consecutiveFailures: z.number(), createdAt: z.iso.datetime(),
  /** A new secret was made in the last 24 hours, and deliveries carry both signatures. */
  rotating: z.boolean(),
  lastAttempt: z.object({ at: z.iso.datetime(), statusCode: z.number().nullable(), error: z.string().nullable() }).nullable(),
});
export const WebhookEndpoints = z.object({ endpoints: z.array(WebhookEndpoint) });
export const WebhookEndpointInput = z.object({
  url: z.string().trim().max(2000),
  description: z.string().trim().max(200).default(''),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'choose at least one event').max(WEBHOOK_EVENTS.length),
});
export const WebhookEndpointPatch = WebhookEndpointInput.partial().extend({ enabled: z.boolean().optional() });
/** Returned when an endpoint is made or its secret rotated: the only time the secret is shown. */
export const WebhookSecret = z.object({ endpoint: WebhookEndpoint, secret: z.string() });
export const WebhookAttempt = z.object({
  id: z.number(), eventId: z.string(), eventType: z.string(), kind: z.enum(['automatic', 'test', 'redelivery']), attempt: z.number(),
  statusCode: z.number().nullable(), durationMs: z.number(), error: z.string().nullable(), at: z.iso.datetime(),
});
export const WebhookAttempts = z.object({ attempts: z.array(WebhookAttempt) });

/** One week of how the assistant did, counted in the database. Codes and counts only. */
export const QualityWeek = z.object({
  start: z.string(), end: z.string(), calls: z.number(),
  /** Calls the assistant finished without staff: booked, moved, cancelled, or answered. */
  contained: z.number(), containmentRate: z.number().nullable(),
  bookingAttempts: z.number(), bookings: z.number(), bookingSuccess: z.number().nullable(),
  avgTurnsToBooking: z.number().nullable(),
  refusals: z.array(z.object({ code: z.string(), count: z.number() })),
  transferred: z.number(), transferredShare: z.number().nullable(),
  flagged: z.number(), flaggedShare: z.number().nullable(),
  afterHours: z.number(),
  voiceMinutes: z.number(), cost: z.number(), costPerCall: z.number().nullable(), costPerBooking: z.number().nullable(),
});
export const Quality = z.object({ weeks: z.array(QualityWeek), costPerMinute: z.number() });
export const QualityQuery = z.object({ weeks: z.coerce.number().int().min(1).max(26).default(8) });

export const API_KEY_SCOPES = ['schedule:read', 'requests:read', 'requests:write'] as const;
export const ApiKeyView = z.object({
  id: z.string(), name: z.string(), prefix: z.string(), scopes: z.array(z.enum(API_KEY_SCOPES)), expiresAt: z.iso.datetime(),
  createdBy: z.string().nullable(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable(),
  status: z.enum(['active', 'expired', 'revoked']),
});
export const ApiKeys = z.object({ keys: z.array(ApiKeyView) });
export const ApiKeyInput = z.object({
  name: z.string().trim().min(1, 'give the key a name').max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'choose at least one scope'),
  expiresInDays: z.number().int().min(1).max(365).default(90),
});
/** The only time a key is shown. */
export const ApiKeyCreated = z.object({ apiKey: ApiKeyView, key: z.string() });

export const TestCallStart = z.object({ sdp: z.string().min(1).max(64 * 1024) });
export const TestCall = z.object({ callId: z.string(), sdp: z.string(), maxSeconds: z.number() });

export const TaskQuery = z.object({
  status: z.enum(['open', 'done']).default('open'),
  type: z.enum(['callback', 'refill', 'voicemail', 'review']).optional(),
  assignee: z.enum(['me', 'unassigned']).optional(),
});
export const TaskOutcome = z.enum(['called_back', 'left_message', 'refill_sent', 'not_needed']);
export const TaskDone = z.object({ outcome: TaskOutcome.optional() }).default({});
export const TaskAssign = z.object({ userId: z.string().min(1).max(100) });
export const TaskNoteInput = z.object({ body: z.string().trim().min(1, 'write something first').max(1000) });
export const Task = z.object({
  id: z.string(),
  type: z.enum(['callback', 'refill', 'voicemail', 'review']),
  status: z.enum(['open', 'done']),
  callId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  assigneeUserId: z.string().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  doneAt: z.iso.datetime().nullable(),
  doneByUserId: z.string().nullable(),
  patientName: z.string().nullable(),
  patientId: z.string().nullable(),
  details: z.record(z.string(), z.string()),
  outcome: TaskOutcome.nullable(),
  assigneeName: z.string().nullable(),
  /** What the call's summary suggests staff do, for a request the assistant created. */
  followUp: z.string().nullable(),
  notes: z.array(z.object({ id: z.number(), author: z.string().nullable(), at: z.iso.datetime(), body: z.string() })),
});
export const TaskList = z.object({ tasks: z.array(Task) });
export const TaskCount = z.object({ open: z.number() });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const instant = z.iso.datetime({ offset: true });

export const CancelReason = z.enum(['patient_asked', 'clinic_asked', 'booked_in_error', 'other']);

/** Who made or cancelled a booking: the assistant on a call, or a named staff member. */
export const BookedBy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant'), callId: z.string() }),
  z.object({ kind: z.literal('staff'), name: z.string().nullable() }),
]);

export const ScheduleQuery = z.object({
  from: isoDate,
  days: z.coerce.number().int().min(1).max(14).default(1),
  providerId: z.string().max(64).optional(),
});
export const Appointment = z.object({
  id: z.string(),
  patientId: z.string(),
  patientName: z.string(),
  providerId: z.string(),
  visitTypeId: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: z.enum(['booked', 'cancelled']),
  cancelReason: CancelReason.nullable(),
  bookedBy: BookedBy,
  cancelledBy: BookedBy.nullable(),
  createdAt: z.iso.datetime(),
});
export const Schedule = z.object({ from: isoDate, days: z.number(), appointments: z.array(Appointment) });
export const AppointmentDetail = Appointment.extend({
  note: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  patient: z.object({ id: z.string(), name: z.string(), dob: z.string(), phone: z.string().nullable() }),
});

export const SlotQuery = z.object({
  visitTypeId: z.string().max(64),
  providerId: z.string().max(64).optional(),
  from: isoDate.optional(),
  days: z.coerce.number().int().min(1).max(14).default(7),
  partOfDay: z.enum(['morning', 'afternoon', 'any']).default('any'),
  /** The appointment being moved, so its own time counts as free. */
  excluding: z.uuid().optional(),
});
export const SlotList = z.object({ slots: z.array(z.object({ providerId: z.string(), visitTypeId: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })) });

export const BookAppointment = z.object({
  patientId: z.uuid(),
  providerId: z.string().max(64),
  visitTypeId: z.string().max(64),
  startsAt: instant,
  note: z.string().trim().max(500).optional(),
  /** A new one per booking attempt: the same key twice is one booking. */
  idempotencyKey: z.string().min(8).max(100),
});
export const RescheduleAppointment = z.object({ startsAt: instant, providerId: z.string().max(64).optional() });
export const CancelAppointment = z.object({ reason: CancelReason.optional() });
export const AppointmentChange = z.object({ appointmentId: z.string(), status: z.enum(['done', 'already_done']) });

const personName = z.string().trim().min(1, 'required').max(80);
const phoneNumber = z.string().trim().max(30).refine((v) => v === '' || v.replace(/\D/g, '').length >= 10, 'a phone number has at least 10 digits');

export const PatientSearch = z.object({ query: z.string().trim().min(2, 'type at least two characters').max(100) });
export const PatientCard = z.object({ id: z.string(), name: z.string(), firstName: z.string(), lastName: z.string(), dob: z.string(), phone: z.string().nullable() });
export const PatientList = z.object({
  patients: z.array(PatientCard),
  /** The search read its whole cap of patients: someone further on may match too. */
  truncated: z.boolean().optional(),
});
export const PatientInput = z.object({
  firstName: personName,
  lastName: personName,
  // "not in the future" is checked against the clinic's own date by the route, not the server's
  dob: isoDate.refine((d) => !Number.isNaN(Date.parse(d)) && d >= '1890-01-01', 'a real date of birth'),
  phone: phoneNumber.optional(),
});
export const PatientSaved = z.object({ id: z.string() });
export const PatientProfile = PatientCard.extend({
  createdAt: z.iso.datetime(),
  /** The provider they have seen most, when they have seen one. */
  usualProviderId: z.string().nullable(),
  appointments: z.array(z.object({
    id: z.string(), providerId: z.string(), visitTypeId: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
    status: z.enum(['booked', 'cancelled']), bookedBy: BookedBy,
  })),
  calls: z.array(z.object({ id: z.string(), startedAt: z.iso.datetime(), outcome: z.string().nullable(), emergency: z.boolean(), channel: z.enum(['phone', 'web']), voiceSeconds: z.number().nullable() })),
  requests: z.array(z.object({
    id: z.string(), type: z.enum(['callback', 'refill', 'voicemail', 'review']), status: z.enum(['open', 'done']), callId: z.string().nullable(),
    createdAt: z.iso.datetime(), doneAt: z.iso.datetime().nullable(), details: z.record(z.string(), z.string()),
  })),
});

export const Member = z.object({
  userId: z.string(), name: z.string(), email: z.string(), role: Role, twoFactorEnabled: z.boolean(),
  /** Still on the temporary password they were given. */
  mustChangePassword: z.boolean(),
  addedAt: z.iso.datetime(), you: z.boolean(),
});
export const MemberList = z.object({ members: z.array(Member) });
export const AddMember = z.object({ name: z.string().trim().min(1, 'required').max(80), email: z.email().max(200), role: Role });
/** The temporary password is shown once, for the manager to pass on in person. It must be changed at first sign-in and expires after 72 hours. */
export const AddedMember = z.object({ userId: z.string(), temporaryPassword: z.string(), expiresInHours: z.number() });
export const ChangeRole = z.object({ role: Role });

export const OverviewQuery = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });
const Activity = z.object({
  callsAnswered: z.number(),
  booked: z.number(),
  rescheduled: z.number(),
  cancelled: z.number(),
  requestsTaken: z.number(),
  handedToStaff: z.number(),
  afterHours: z.number(),
  talkMinutes: z.number(),
  /** talkMinutes at the per-minute rate below, in US dollars. */
  estimatedCost: z.number(),
});
/** Counts only, for the home screen. No patient data, so a viewer sees it too. */
export const Overview = z.object({
  days: z.number(), costPerMinute: z.number(), today: Activity, period: Activity,
  /** Per clinic-time day, oldest first: for the trend lines. Counts only. */
  daily: z.array(z.object({ date: z.string(), calls: z.number(), booked: z.number(), requests: z.number() })),
});
export const WaitingTasks = z.object({ tasks: z.array(z.object({ id: z.string(), type: z.enum(['callback', 'refill', 'voicemail', 'review']), createdAt: z.iso.datetime(), callId: z.string().nullable() })) });

export const AuditEntry = z.object({
  id: z.number(), at: z.iso.datetime(), actor: z.string(), action: z.string(),
  entity: z.string(), entityId: z.string().nullable(), callId: z.string().nullable(),
});
export const AuditPage = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const AuditList = z.object({ entries: z.array(AuditEntry), next: z.number().nullable() });

export const ApiError = z.object({ error: z.string(), message: z.string().optional(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() });

export type Health = z.infer<typeof Health>;
export type Me = z.infer<typeof Me>;
export type CallSummary = z.infer<typeof CallSummary>;
export type CallList = z.infer<typeof CallList>;
export type CallDetail = z.infer<typeof CallDetail>;
export type CallSummaryCard = z.infer<typeof CallSummaryCard>;
export type LiveCall = z.infer<typeof LiveCall>;
export type ApiKeyView = z.infer<typeof ApiKeyView>;
export type ApiKeys = z.infer<typeof ApiKeys>;
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;
export type Quality = z.infer<typeof Quality>;
export type QualityWeek = z.infer<typeof QualityWeek>;
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;
export type KnowledgeDocuments = z.infer<typeof KnowledgeDocuments>;
export type KnowledgeAnswer = z.infer<typeof KnowledgeAnswer>;
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;
export type WebhookEndpoints = z.infer<typeof WebhookEndpoints>;
export type WebhookSecret = z.infer<typeof WebhookSecret>;
export type WebhookAttempt = z.infer<typeof WebhookAttempt>;
export type WebhookAttempts = z.infer<typeof WebhookAttempts>;
export type LiveCalls = z.infer<typeof LiveCalls>;
export type Task = z.infer<typeof Task>;
export type TaskList = z.infer<typeof TaskList>;
export type TestCall = z.infer<typeof TestCall>;
export type TaskCount = z.infer<typeof TaskCount>;
export type AuditEntry = z.infer<typeof AuditEntry>;
export type AuditList = z.infer<typeof AuditList>;
export type ApiError = z.infer<typeof ApiError>;
export type Appointment = z.infer<typeof Appointment>;
export type AppointmentDetail = z.infer<typeof AppointmentDetail>;
export type Schedule = z.infer<typeof Schedule>;
export type SlotList = z.infer<typeof SlotList>;
export type BookAppointment = z.infer<typeof BookAppointment>;
export type AppointmentChange = z.infer<typeof AppointmentChange>;
export type CancelReason = z.infer<typeof CancelReason>;
export type BookedBy = z.infer<typeof BookedBy>;
export type PatientCard = z.infer<typeof PatientCard>;
export type PatientList = z.infer<typeof PatientList>;
export type PatientInput = z.infer<typeof PatientInput>;
export type PatientSaved = z.infer<typeof PatientSaved>;
export type PatientProfile = z.infer<typeof PatientProfile>;
export type Overview = z.infer<typeof Overview>;
export type WaitingTasks = z.infer<typeof WaitingTasks>;
export type Member = z.infer<typeof Member>;
export type MemberList = z.infer<typeof MemberList>;
export type AddedMember = z.infer<typeof AddedMember>;
