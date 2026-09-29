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
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), twoFactorEnabled: z.boolean() }),
  demoMode: z.boolean(),
  /** Whether this deployment has a voice service for test calls from the browser. */
  testCalls: z.boolean(),
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
  channel: z.enum(['phone', 'web']),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  outcome: z.string().nullable(),
  emergency: z.boolean(),
  closeReason: z.string().nullable(),
  voiceSeconds: z.number().nullable(),
  tools: z.array(z.string()),
  verified: z.boolean(),
});
export const CallList = z.object({ calls: z.array(CallSummary), next: z.string().nullable() });

export const CallDetail = CallSummary.omit({ tools: true, verified: true }).extend({
  /** What the call booked or cancelled, for "Booked: Tue 6 Oct 3:00 PM with Dr. Okafor". */
  appointments: z.array(z.object({
    id: z.string(), startsAt: z.iso.datetime(), providerId: z.string(), visitTypeId: z.string(),
    status: z.enum(['booked', 'cancelled']), change: z.enum(['booked', 'cancelled']),
  })),
  transcript: z.array(z.object({ speaker: z.enum(['caller', 'agent']), text: z.string(), startMs: z.number(), endMs: z.number() })),
  actions: z.array(z.object({ tool: z.string(), argumentNames: z.array(z.string()), result: z.record(z.string(), z.unknown()), revision: z.number(), at: z.iso.datetime() })),
  tasks: z.array(z.object({ id: z.string(), type: z.string(), status: z.string() })),
});

export const TestCallStart = z.object({ sdp: z.string().min(1).max(64 * 1024) });
export const TestCall = z.object({ callId: z.string(), sdp: z.string(), maxSeconds: z.number() });

export const TaskQuery = z.object({ status: z.enum(['open', 'done']).default('open') });
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
  details: z.record(z.string(), z.string()),
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
