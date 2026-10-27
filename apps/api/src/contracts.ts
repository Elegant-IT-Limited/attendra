// SPDX-License-Identifier: AGPL-3.0-only
import { API_SCOPES, Gender, Provider, VisitType } from '@attendra/core';
import { z } from 'zod';

// The dashboard's HTTP contract. Request schemas are enforced by the API; response
// schemas document it (OpenAPI at /api/docs) and give the web app its types.


/** A real calendar day, YYYY-MM-DD, between 1900 and 2100: "2026-02-31" or "9999-12-31" is a 422, not a crash further in. */
const realDate = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, day));
  return y >= 1900 && y <= 2100 && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
};
const day = (message = 'expected YYYY-MM-DD') => z.string().refine(realDate, message);
const STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

export const Role = z.enum(['owner', 'admin', 'staff', 'viewer']);

export const Health = z.object({
  ok: z.boolean(),
  demoMode: z.boolean(),
  // only on a local demo (`pnpm demo`); a deployed demo never publishes its password
  demoSignIn: z.object({ password: z.string(), logins: z.array(z.object({ email: z.string(), label: z.string() })) }).optional(),
  /** "Forgot password" can email a link. Without it, the sign-in page says to ask a practice manager. */
  passwordReset: z.boolean(),
  /** A hosted deployment's own sign-up page, and where to get a new confirmation link. */
  signupUrl: z.string().optional(),
  resendUrl: z.string().optional(),
});

/** A person's picture on this API, with its version (?v=), so a new one shows at once; null when they have none. */
export const AvatarUrl = z.string().nullable();

export const Me = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), twoFactorEnabled: z.boolean(), mustChangePassword: z.boolean(), avatarUrl: AvatarUrl }),
  demoMode: z.boolean(),
  /** Whether this deployment requires two-step sign-in before anything else. */
  twoFactorRequired: z.boolean(),
  /** Minutes without activity, in every tab, before the dashboard signs out. */
  idleMinutes: z.number(),
  /** Whether this deployment has a voice service for test calls from the browser. */
  testCalls: z.boolean(),
  /** Whether it can play a simulated call, with no audio, to show a live call. The local demo only. */
  simulatedCalls: z.boolean(),
  clinics: z.array(z.object({ id: z.string(), name: z.string(), timezone: z.string(), role: Role, permissions: z.array(z.string()),
    /** May approve or decline refills: marked on the Team page. */
    approvesRefills: z.boolean(),
    /** Links the deployment adds to the menu (billing, setup), for owners only. */
    accountLinks: z.array(z.object({ label: z.string(), href: z.string() })) })),
});

/** An opaque cursor: the last call's exact start time and id, so equal timestamps page correctly. */
export const callCursor = {
  encode: (c: { cursor: string; id: string }) => Buffer.from(`${c.cursor}|${c.id}`).toString('base64url'),
  decode: (s: string) => {
    const [startedAt, id] = Buffer.from(s, 'base64url').toString().split('|');
    // exactly the timestamp text Postgres gave (2026-10-19 22:40:13.123456+00): anything else it may refuse
    return startedAt && id && STAMP.test(startedAt) && realDate(startedAt.slice(0, 10)) && z.uuid().safeParse(id).success ? { startedAt, id } : null;
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
  /** The number the call came from, for the same roles as the name; null on a browser test call and once the transcript is deleted. */
  callerNumber: z.string().nullable(),
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
  from: day().optional(),
  to: day().optional(),
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
  refusal: CallFilters.shape.refusal,
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
    createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
    /** Booked on this call, and moved to another time since. */
    moved: z.boolean(),
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

export const WEBHOOK_EVENTS = ['call.completed', 'call.summary.ready', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled', 'appointment.confirmed', 'request.created', 'request.done'] as const;
export const WebhookEndpoint = z.object({
  id: z.string(), url: z.string(), description: z.string(), events: z.array(z.enum(WEBHOOK_EVENTS)), enabled: z.boolean(),
  /** repeated_failures when Attendra turned it off, turned_off when someone did. */
  disabledReason: z.string().nullable(), disabledAt: z.iso.datetime().nullable(), consecutiveFailures: z.number(), createdAt: z.iso.datetime(),
  /** A new secret was made in the last 24 hours, and deliveries carry both signatures. */
  rotating: z.boolean(),
  /** Deliveries leave out patientId. On by default: a patient id with appointment times is PHI. */
  omitPatientIds: z.boolean(),
  lastAttempt: z.object({ at: z.iso.datetime(), statusCode: z.number().nullable(), error: z.string().nullable() }).nullable(),
});
export const WebhookEndpoints = z.object({ endpoints: z.array(WebhookEndpoint) });
export const WebhookEndpointInput = z.object({
  url: z.string().trim().max(2000),
  description: z.string().trim().max(200).default(''),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'choose at least one event').max(WEBHOOK_EVENTS.length),
  omitPatientIds: z.boolean().default(true),
});
// every field optional and none defaulted: a field left out of a change is left as it is
export const WebhookEndpointPatch = z.object({
  url: z.string().trim().max(2000).optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'choose at least one event').max(WEBHOOK_EVENTS.length).optional(),
  omitPatientIds: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
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
  /** Bookings made while the clinic was closed. */
  afterHoursBookings: z.number(),
  afterHoursRequests: z.number(),
  emergencies: z.number(), refillRequests: z.number(),
  voiceMinutes: z.number(), cost: z.number(), costPerCall: z.number().nullable(), costPerBooking: z.number().nullable(),
});
export const Quality = z.object({ weeks: z.array(QualityWeek), costPerMinute: z.number() });
export const QualityQuery = z.object({ weeks: z.coerce.number().int().min(1).max(26).default(8) });

export const ApiKeyView = z.object({
  id: z.string(), name: z.string(), prefix: z.string(), scopes: z.array(z.enum(API_SCOPES)), expiresAt: z.iso.datetime(),
  createdBy: z.string().nullable(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable(),
  status: z.enum(['active', 'expired', 'revoked']),
});
export const ApiKeys = z.object({ keys: z.array(ApiKeyView), /** where an MCP client connects with a key; null when the deployment does not say */ mcpUrl: z.string().nullable() });
export const ApiKeyInput = z.object({
  name: z.string().trim().min(1, 'give the key a name').max(100),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'choose at least one scope'),
  // what Settings offers: 7 days to a year
  expiresInDays: z.number().int().min(7, 'a key lasts at least 7 days').max(365, 'a key lasts at most a year').default(90),
});
/** The only time a key is shown. */
export const ApiKeyCreated = z.object({ apiKey: ApiKeyView, key: z.string() });

const Says = z.object({ en: z.string(), es: z.string() });
const ReviewItem = z.object({ kind: z.string(), title: z.string(), examples: Says });
export const EmergencyReview = z.object({
  sheet: z.object({
    industry: z.string(), version: z.string(), animal: z.array(ReviewItem), person: z.array(ReviewItem),
    says: z.object({ animal: Says.nullable(), person: Says }), hospitalSet: z.boolean(),
  }),
  review: z.object({ reviewerName: z.string(), reviewerRole: z.string(), reviewedAt: z.string(), version: z.string() }).nullable(),
  /** The review covers the lists in use now. */
  current: z.boolean(),
});
export const EmergencyReviewInput = z.object({
  reviewerName: z.string().trim().min(2, 'the reviewer\'s full name').max(100),
  reviewerRole: z.string().trim().min(2, 'their role, like Veterinarian, DVM').max(60),
});

export const TestCallStart = z.object({ sdp: z.string().min(1).max(64 * 1024) });
export const TestCall = z.object({ callId: z.string(), sdp: z.string(), maxSeconds: z.number() });
/** A clinic's browser test-call time: its limit (null is none) and what its test calls have used. */
export const TestCallAllowance = z.object({ limitSeconds: z.number().nullable(), usedSeconds: z.number() });

export const TaskQuery = z.object({
  status: z.enum(['open', 'done']).default('open'),
  type: z.enum(['callback', 'refill', 'voicemail', 'review', 'follow_up']).optional(),
  assignee: z.enum(['me', 'unassigned']).optional(),
  /** Came in on or after this clinic-local day. */
  from: day().optional(),
  /** Came in on or before this clinic-local day. */
  to: day().optional(),
});
/** The same filters, and words to find, in a POST body: what is typed can be a name or a phone number, and URLs end up in logs. */
export const TaskSearch = TaskQuery.extend({
  /** Words or digits to find in the patient's name, the request's details or its type. Matched as typed, from the first character. */
  q: z.string().trim().max(100).default(''),
});
/** Texts about one thing: exactly one of a call, a request, a pet or patient, or a visit. */
export const TextQuery = z.object({ callId: z.uuid().optional(), taskId: z.uuid().optional(), patientId: z.uuid().optional(), appointmentId: z.uuid().optional() })
  .refine((q) => [q.callId, q.taskId, q.patientId, q.appointmentId].filter(Boolean).length === 1, 'give exactly one of callId, taskId, patientId, appointmentId');
export const TextItem = z.object({
  id: z.string(),
  template: z.string(),
  kind: z.enum(['auto', 'asked', 'reminder']),
  /** not_sent: refused before the carrier, with failureReason */
  status: z.enum(['queued', 'sent', 'delivered', 'undelivered', 'failed', 'not_sent']),
  failureReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  language: z.string(),
  callId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  consentAtMs: z.number().int().nullable(),
  /** The last four digits, only when the text is about a patient. */
  toLast4: z.string().nullable(),
});
export const TextList = z.object({ texts: z.array(TextItem) });

export const TaskOutcome = z.enum(['called_back', 'left_message', 'refill_sent', 'refill_ready', 'refill_declined', 'not_needed', 'details_confirmed']);
export const TaskDone = z.object({ outcome: TaskOutcome.optional() }).default({});
export const TaskAssign = z.object({ userId: z.string().min(1).max(100) });
/** Who a request can be given to: everyone who works requests here, the person asking included, by name, and whether they approve refills. */
export const TaskAssignees = z.object({ people: z.array(z.object({ userId: z.string(), name: z.string(), you: z.boolean(), approvesRefills: z.boolean(), avatarUrl: AvatarUrl })) });
/** Urgent or not, and the clinic's day it is due (null clears it). What is left out stays as it was. */
/** A request a person at the clinic writes down: a voicemail they listened to, a walk-in's question, a call taken by hand. */
export const NewTask = z.object({
  /** "New patient to check" is the assistant's own: it adds the patient it is about. */
  type: z.enum(['callback', 'refill', 'voicemail', 'follow_up']),
  /** For a refill: the medicine and where it goes, as staff wrote them. */
  medication: z.string().trim().max(120).nullable().optional(),
  pharmacy: z.string().trim().max(120).nullable().optional(),
  /** One of the clinic's own kinds of request (Settings, Fields and lists), when one fits. */
  topic: z.string().trim().max(80).nullable().optional(),
  reason: z.string().trim().min(3, 'say what it is about').max(300),
  callbackNumber: z.string().trim().regex(/^\+?[\d\s().-]{7,20}$/, 'a phone number, like (303) 555-0100').nullable().optional(),
  urgent: z.boolean().optional(),
  dueOn: z.iso.date().nullable().optional(),
});
export const TaskPlan = z.object({ urgent: z.boolean().optional(), dueOn: z.iso.date().nullable().optional() });
export const TaskNoteInput = z.object({ body: z.string().trim().min(1, 'write something first').max(1000) });
export const Task = z.object({
  id: z.string(),
  type: z.enum(['callback', 'refill', 'voicemail', 'review', 'follow_up']),
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
  /** Set by staff: urgent requests come first in the open queue. */
  urgent: z.boolean(),
  /** The clinic's day it is due, set by staff. */
  dueOn: z.iso.date().nullable(),
  assigneeName: z.string().nullable(),
  /** Who closed a done request, by name; null while it is open, or for someone no longer on the team. */
  doneByName: z.string().nullable(),
  /** What the call's summary suggests staff do, for a request the assistant created. */
  followUp: z.string().nullable(),
  /** The clinic's own details on the request (Settings, Fields and lists). */
  custom: z.record(z.string(), z.string()),
  notes: z.array(z.object({ id: z.number(), author: z.string().nullable(), authorAvatarUrl: AvatarUrl, at: z.iso.datetime(), body: z.string() })),
});
export const TaskList = z.object({ tasks: z.array(Task) });
export const TaskCount = z.object({ open: z.number() });

const isoDate = day();
const instant = z.iso.datetime({ offset: true });

export const CancelReason = z.enum(['patient_asked', 'clinic_asked', 'booked_in_error', 'other']);

/** Who made or cancelled a booking: the assistant on a call, or a named staff member. */
export const BookedBy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant'), callId: z.string() }),
  z.object({ kind: z.literal('staff'), name: z.string().nullable() }),
]);

export const ScheduleQuery = z.object({
  from: isoDate,
  // a day, a week, or a month view's six weeks
  days: z.coerce.number().int().min(1).max(42).default(1),
  providerId: z.string().max(64).optional(),
  /** booked: what is on the calendar; cancelled: only what was cancelled; all: both. */
  status: z.enum(['booked', 'cancelled', 'all']).default('all'),
});
/** Cancelled visits as a history list: a window of visit days, newest first by default. A POST body, since `q` is a patient's name. */
export const CancelledQuery = z.object({
  from: isoDate,
  to: isoDate,
  providerId: z.string().max(64).optional(),
  /** visit: by when the visit was to be; cancelled: by when it was cancelled. */
  sort: z.enum(['visit', 'cancelled']).default('cancelled'),
  order: z.enum(['newest', 'oldest']).default('newest'),
  q: z.string().trim().max(100).optional(),
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
  overrideReason: z.string().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  confirmedVia: z.enum(['text', 'staff']).nullable(),
  reminderSentAt: z.iso.datetime().nullable(),
});
export const Schedule = z.object({ from: isoDate, days: z.number(), appointments: z.array(Appointment) });
export const CancelledList = z.object({
  appointments: z.array(Appointment.extend({ cancelledAt: z.iso.datetime() })),
  /** More matched than the 200 shown. */
  truncated: z.boolean(),
});
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
  /** Who the visit is for: with no providerId, only providers who see their age (and take new patients, if they are new). */
  patientId: z.uuid().optional(),
});
/** Visits booked on a provider's day off or a holiday, by day and provider. */
export const ScheduleConflicts = z.object({ conflicts: z.array(z.object({ date: z.string(), providerId: z.string(), reason: z.enum(['holiday', 'away']), count: z.number() })) });
export type ScheduleConflicts = z.infer<typeof ScheduleConflicts>;

export const SlotList = z.object({ slots: z.array(z.object({ providerId: z.string(), visitTypeId: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })) });

export const BookAppointment = z.object({
  patientId: z.uuid(),
  providerId: z.string().max(64),
  visitTypeId: z.string().max(64),
  startsAt: instant,
  note: z.string().trim().max(500).optional(),
  /** A new one per booking attempt: the same key twice is one booking. */
  idempotencyKey: z.string().min(8).max(100),
  /** Squeeze it in outside the hours or on a day off, with why. Front desk and up; never the assistant. */
  override: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(120).optional(),
}).refine((b) => !b.override || !!b.overrideReason, { path: ['overrideReason'], message: 'say why it is booked outside the hours' });
export const RescheduleAppointment = z.object({
  startsAt: instant, providerId: z.string().max(64).optional(),
  override: z.boolean().default(false),
  overrideReason: z.string().trim().min(3).max(120).optional(),
}).refine((b) => !b.override || !!b.overrideReason, { path: ['overrideReason'], message: 'say why it is moved outside the hours' });
export const CancelAppointment = z.object({ reason: CancelReason.optional() });
export const AppointmentChange = z.object({ appointmentId: z.string(), status: z.enum(['done', 'already_done']) });

const personName = z.string().trim().min(1, 'required').max(80);
// required: with name and date of birth it is how a patient is told apart from anyone else
const phoneNumber = z.string().trim().max(30).refine((v) => v.replace(/\D/g, '').length >= 10, 'a phone number with at least 10 digits');
const PatientStatus = z.enum(['active', 'new']);

export const PatientSearch = z.object({
  query: z.string().trim().min(1, 'type something to search for').max(100),
  /** new: only patients the assistant added that nobody has checked yet. */
  status: PatientStatus.optional(),
});
export const PatientListQuery = z.object({ status: PatientStatus.optional() });
export const PatientCard = z.object({
  id: z.string(), name: z.string(), firstName: z.string(), lastName: z.string(), dob: z.string(),
  /** Null only for a patient added before phone numbers were required: add one so the assistant can verify them. */
  phone: z.string().nullable(),
  /** The parent or guardian, for a patient under 18. */
  guardianName: z.string().nullable(),
  /** female, male, other, or undisclosed (prefers not to say). Null only for a patient added before v0.5.1. */
  gender: Gender.nullable(),
  /** The kind of animal, at a veterinary clinic: dog, cat, rabbit. Null for people. */
  species: z.string().nullable(),
  /** new: added by the assistant on a call; the front desk checks the details and confirms them. */
  status: PatientStatus,
  createdAt: z.iso.datetime(),
  /** The clinic's own details on the record, for the fields it still has. */
  custom: z.record(z.string(), z.string()),
  /** They agreed to reminder texts, and where: on a call, at the desk, in an import. */
  textsOk: z.boolean(),
  textsOkSource: z.enum(['call', 'staff', 'import']).nullable(),
});
export const PatientList = z.object({
  patients: z.array(PatientCard),
  /** The search read its whole cap of patients: someone further on may match too. */
  truncated: z.boolean().optional(),
});
export const PatientInput = z.object({
  firstName: personName,
  // required for a person, checked by the route; a pet's family name is its owner's last name, empty for an owner with one name
  lastName: z.string().trim().max(80).default(''),
  // "not in the future" is checked against the clinic's own date by the route, not the server's
  dob: isoDate.refine((d) => !Number.isNaN(Date.parse(d)) && d >= '1890-01-01', 'a real date of birth'),
  phone: phoneNumber,
  gender: Gender,
  // required for a patient under 18, and for every pet (its owner), checked by the route
  guardianName: z.string().trim().max(120).nullable().optional(),
  /** The kind of animal, for a pet. Left out, an edit keeps what was there. */
  species: z.string().trim().max(40).nullable().optional(),
  /** They agreed to reminder texts. Left out, an edit keeps what was there. */
  textsOk: z.boolean().optional(),
});
export const PatientSaved = z.object({
  id: z.string(),
  /** Someone else is on file with this name and date of birth, on another phone. Saved anyway: worth a look. */
  similar: z.boolean().optional(),
});
/** The clinic's own details on a record, the whole set: an empty value leaves a field blank. */
/** A POST: a field's value can be anything staff wrote, and URLs end up in logs. */
export const PatientFilter = z.object({
  species: z.string().trim().min(1).max(40).optional(),
  field: z.object({ id: z.string().max(40), value: z.string().trim().min(1).max(200) }).optional(),
});
export const CustomFieldValues = z.object({ values: z.record(z.string().max(40), z.string().max(400)) });
/** A managed list saved whole, in order; renamed: { old value: new value }, carried to every doctor. */
export const ListChange = z.object({ values: z.array(z.string().trim().min(1).max(40)).max(60), renamed: z.record(z.string().max(40), z.string().max(40)).default({}) });

export const PatientProfile = PatientCard.extend({
  /** The call the assistant added them on, for a patient it added. */
  createdByCallId: z.string().nullable(),
  /** The clinic's own details on this record, by field id: only fields the clinic still has. */
  customFields: z.record(z.string(), z.string()),
  /** Everyone else on the same phone number: a parent and their children. */
  household: z.array(PatientCard),
  /** The provider they have seen most, when they have seen one. */
  usualProviderId: z.string().nullable(),
  appointments: z.array(z.object({
    id: z.string(), providerId: z.string(), visitTypeId: z.string(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
    status: z.enum(['booked', 'cancelled']), bookedBy: BookedBy,
  })),
  /** Every call from this record's phone number, as one profile for the number: verified on this record, or from the number only. */
  calls: z.array(z.object({ id: z.string(), startedAt: z.iso.datetime(), outcome: z.string().nullable(), emergency: z.boolean(), channel: z.enum(['phone', 'web']), voiceSeconds: z.number().nullable(), forThisRecord: z.boolean() })),
  /** The requests of anyone on the same phone, and of the calls from it. patientId says whose it is, when anyone's. */
  requests: z.array(z.object({
    id: z.string(), type: z.enum(['callback', 'refill', 'voicemail', 'review', 'follow_up']), status: z.enum(['open', 'done']), callId: z.string().nullable(), patientId: z.string().nullable(),
    createdAt: z.iso.datetime(), doneAt: z.iso.datetime().nullable(), details: z.record(z.string(), z.string()),
  })),
});

/** A doctor (or a room) as the Doctors page edits them. The id is made from the name when a new one has none. */
export const DoctorInput = Provider.omit({ id: true }).extend({
  id: z.string().regex(/^[A-Za-z0-9_-]{2,64}$/, 'an id is 2 to 64 letters, digits, dashes or underscores').optional(),
  name: z.string().trim().min(2, 'a name of at least 2 letters').max(80),
  gender: Gender,
});
export const DoctorList = z.object({ providers: z.array(Provider), visitTypes: z.array(VisitType) });
/** A CSV file as text: doctors or patients. `dryRun` checks every row and changes nothing. */
export const ImportInput = z.object({ csv: z.string().min(1, 'the file is empty').max(2_000_000, 'the file is larger than 2 MB'), dryRun: z.boolean().default(true) });
export const ImportResult = z.object({
  dryRun: z.boolean(),
  rows: z.array(z.object({
    line: z.number().int(), name: z.string(),
    /** add: new; update: an existing doctor; skip: already on file; error: not imported, see message */
    status: z.enum(['add', 'update', 'skip', 'error']),
    message: z.string().nullable(),
  })),
  counts: z.object({ add: z.number().int(), update: z.number().int(), skip: z.number().int(), error: z.number().int() }),
});

export const Member = z.object({
  userId: z.string(), name: z.string(), email: z.string(), role: Role, twoFactorEnabled: z.boolean(),
  /** Still on the temporary password they were given. */
  mustChangePassword: z.boolean(),
  addedAt: z.iso.datetime(), you: z.boolean(),
  /** May approve or decline refills. */
  approvesRefills: z.boolean(),
  avatarUrl: AvatarUrl,
});
export const MemberList = z.object({ members: z.array(Member) });
/** The name is used only when the email is new to Attendra; without one, the part of the email before the @. */
export const AddMember = z.object({ name: z.string().trim().max(80).optional(), email: z.email().max(200), role: Role, approvesRefills: z.boolean().default(false) });
/** Your own name, as it shows to your team. */
export const ProfileName = z.object({ name: z.string().trim().min(2, 'at least 2 characters').max(80, 'at most 80 characters') });
export const AvatarSaved = z.object({ avatarUrl: z.string() });
/** The temporary password is shown once, for the manager to pass on in person. It must be changed at first sign-in and expires after 72 hours. */
export const AddedMember = z.object({ userId: z.string(), temporaryPassword: z.string(), expiresInHours: z.number() });
/**
 * The answer to adding a person: "invite sent", whatever the email. Where the deployment
 * cannot send email, a new person instead gets an account and a temporary password, shown
 * once, as before.
 */
export const AddResult = z.object({
  status: z.literal('invite_sent'), email: z.string(),
  userId: z.string().optional(), temporaryPassword: z.string().optional(), expiresInHours: z.number().optional(),
});
/** The invitations a team is waiting on. */
export const TeamInvitationList = z.object({
  invitations: z.array(z.object({ id: z.string(), email: z.string(), role: Role, approvesRefills: z.boolean(), invitedBy: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() })),
});
/** The invitations waiting for the signed-in person, from any clinic. */
export const MyInvitationList = z.object({
  invitations: z.array(z.object({ id: z.string(), clinicId: z.string(), clinicName: z.string(), role: Role, approvesRefills: z.boolean(), expiresAt: z.iso.datetime() })),
});
/** Accepted: the clinic to open. */
export const AcceptedInvitation = z.object({ clinicId: z.string() });
/** A new role, whether they may approve refills, or both. */
export const ChangeMember = z.object({ role: Role.optional(), approvesRefills: z.boolean().optional() })
  .refine((b) => b.role !== undefined || b.approvesRefills !== undefined, 'give a role or approvesRefills');

export const OverviewQuery = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });
const Activity = z.object({
  callsAnswered: z.number(),
  booked: z.number(),
  rescheduled: z.number(),
  cancelled: z.number(),
  requestsTaken: z.number(),
  handedToStaff: z.number(),
  afterHours: z.number(),
  /** Calls where the emergency script ran. */
  emergencies: z.number(),
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
/** A link the hosting layer gives: a path on this site or an https address, nothing a browser would run. */
const SafeLink = z.string().max(300).refine((v) => (v.startsWith('/') && !v.startsWith('//')) || v.startsWith('https://'), 'expected a path or an https address');
/** The hosting layer's plan for a clinic, as it sets it: what the dashboard shows of the month's minutes and the trial. */
export const HostingPlan = z.object({
  status: z.enum(['trial', 'active', 'past_due', 'suspended', 'canceled']),
  /** Call minutes a month included at this clinic. */
  includedMinutes: z.number().int().min(0).max(100_000),
  /** Texts a month included at this clinic; a hosting layer from before texts were counted leaves it out. */
  includedTexts: z.number().int().min(0).max(1_000_000).optional(),
  /** The minutes' month: phone calls from periodStart count toward includedMinutes; it starts again at periodEnd. */
  periodStart: z.iso.datetime().nullable(),
  periodEnd: z.iso.datetime().nullable(),
  trialEndsAt: z.iso.datetime().nullable(),
  /** The trial's length, for its countdown. */
  trialDays: z.number().int().min(1).max(365).default(14),
  /** When the plan ends, its renewal turned off. */
  endsAt: z.iso.datetime().nullable(),
  /** Where an owner manages the plan. */
  manageUrl: SafeLink.nullable(),
  /** Where an owner adds another location to this business (same business, one bill); a hosting layer from before leaves it out. */
  addLocationUrl: SafeLink.nullable().optional(),
  /** Where an owner opens a separate business on the same login (its own plan, trial, setup and team). */
  newClinicUrl: SafeLink.nullable().optional(),
  /**
   * A line the hosting layer wants on every page (free minutes nearly used, the assistant paused until a card
   * is added): what the owner reads, with the link to the plan, and what the rest of the team reads.
   */
  notice: z.object({ level: z.enum(['warn', 'danger']), owner: z.string().min(1).max(300), team: z.string().min(1).max(300) }).nullable().optional(),
  /**
   * The owner's steps from a finished setup to real calls (the plan, a number, forwarding, texting), as the
   * hosting layer keeps them: a card on Today until they are done. `optional`: real calls do not wait for it.
   */
  goLive: z.object({
    setupUrl: SafeLink.nullable(),
    steps: z.array(z.object({
      title: z.string().min(1).max(80),
      status: z.string().min(1).max(80),
      state: z.enum(['done', 'todo', 'wait', 'problem']),
      href: SafeLink.nullable(),
      optional: z.boolean().default(false),
    })).min(1).max(8),
  }).nullable().optional(),
});
export const AssistantChoicesQuery = z.object({ assistantName: z.string().trim().regex(/^[\p{L}\p{M}]{2,24}$/u, 'the assistant name is one word of 2 to 24 letters').optional() });
/** What setting up the assistant offers: the voices with a sample, and the greeting each language suggests for a name. */
export const AssistantChoices = z.object({
  voices: z.array(z.object({ id: z.string(), label: z.string() })),
  /** The suggested greeting per language, for the name asked about (or the saved one). */
  suggested: z.record(z.string(), z.string()),
  /** The saved greeting is still the suggested one for the saved name, so it can follow a new name. */
  savedIsSuggested: z.boolean(),
});
/** The plan and this month's phone minutes, for every member. Counts only; a self-hosted install has no plan. */
export const ClinicPlan = z.object({ plan: HostingPlan.nullable(), minutesUsed: z.number().int().nullable(), textsUsed: z.number().int().nullable().default(null) });

// the oldest 20, and how many are waiting in all
export const WaitingTasks = z.object({ tasks: z.array(z.object({ id: z.string(), type: z.enum(['callback', 'refill', 'voicemail', 'review', 'follow_up']), createdAt: z.iso.datetime(), callId: z.string().nullable() })), total: z.number().int(),
  /** How many are waiting, by type: a vet clinic's refill queue on the home screen. */
  byType: z.record(z.string(), z.number().int()) });

export const AuditEntry = z.object({
  id: z.number(), at: z.iso.datetime(), actor: z.string(), action: z.string(),
  entity: z.string(), entityId: z.string().nullable(), callId: z.string().nullable(),
  /** How much, never what: { characters: 24 }, { transcriptLines: 412 }. */
  counts: z.record(z.string(), z.number()).nullable(),
});
export const AuditPage = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const AuditList = z.object({ entries: z.array(AuditEntry), next: z.number().nullable() });

export const ApiError = z.object({ error: z.string(), message: z.string().optional(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() });

export type Health = z.infer<typeof Health>;
export type Me = z.infer<typeof Me>;
export type AvatarSaved = z.infer<typeof AvatarSaved>;
export type HostingPlan = z.infer<typeof HostingPlan>;
export type ClinicPlan = z.infer<typeof ClinicPlan>;
export type AssistantChoices = z.infer<typeof AssistantChoices>;
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
export type TextItem = z.infer<typeof TextItem>;
export type TextList = z.infer<typeof TextList>;
export type TestCall = z.infer<typeof TestCall>;
export type EmergencyReview = z.infer<typeof EmergencyReview>;
export type TestCallAllowance = z.infer<typeof TestCallAllowance>;
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
export type CancelledList = z.infer<typeof CancelledList>;
export type PatientList = z.infer<typeof PatientList>;
export type PatientInput = z.infer<typeof PatientInput>;
export type PatientSaved = z.infer<typeof PatientSaved>;
export type PatientProfile = z.infer<typeof PatientProfile>;
export type Overview = z.infer<typeof Overview>;
export type WaitingTasks = z.infer<typeof WaitingTasks>;
export type TaskAssignees = z.infer<typeof TaskAssignees>;
export type Member = z.infer<typeof Member>;
export type MemberList = z.infer<typeof MemberList>;
export type AddedMember = z.infer<typeof AddedMember>;
export type AddResult = z.infer<typeof AddResult>;
export type TeamInvitationList = z.infer<typeof TeamInvitationList>;
export type MyInvitationList = z.infer<typeof MyInvitationList>;
export type AcceptedInvitation = z.infer<typeof AcceptedInvitation>;
export type DoctorInput = z.infer<typeof DoctorInput>;
export type DoctorList = z.infer<typeof DoctorList>;
export type ImportResult = z.infer<typeof ImportResult>;
