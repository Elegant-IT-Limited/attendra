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
  transcript: z.array(z.object({ speaker: z.enum(['caller', 'agent']), text: z.string(), startMs: z.number(), endMs: z.number() })),
  actions: z.array(z.object({ tool: z.string(), argumentNames: z.array(z.string()), result: z.record(z.string(), z.unknown()), revision: z.number(), at: z.iso.datetime() })),
  tasks: z.array(z.object({ id: z.string(), type: z.string(), status: z.string() })),
});

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
export type TaskCount = z.infer<typeof TaskCount>;
export type AuditEntry = z.infer<typeof AuditEntry>;
export type AuditList = z.infer<typeof AuditList>;
export type ApiError = z.infer<typeof ApiError>;
