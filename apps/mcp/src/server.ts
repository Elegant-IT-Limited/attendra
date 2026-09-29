// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, isOpen, localDateOf, qualityOf, zonedInstant } from '@attendra/core';
import { type ApiCaller, type ApiScope, auditKeyUse, type Database, FrontDeskRepository, type PhiCipher, phiContext, qualityRows, schema, taskFacts, withClinic } from '@attendra/db';
import type { Logger } from '@attendra/observability';
import { openSlots } from '@attendra/scheduling';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';

export interface McpDeps {
  db: Database;
  cipher: PhiCipher;
  log: Logger;
  now?: () => Date;
  /** Tells the clinic's webhooks when a request is closed here, as the dashboard does. */
  onRequestDone?: (clinicId: string, facts: Record<string, string | null>) => Promise<void>;
}

/** Voice minutes at the list price: the same estimate as the dashboard. */
const COST_PER_MINUTE = 0.05;
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> });
const refused = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/**
 * The front desk, for another AI agent: find open times, read today's schedule and
 * the request queue, close a request, and see how the assistant is doing. One server
 * per API key, so every tool knows which clinic and which scopes it runs with. No
 * tool books or cancels: changes to the schedule stay with people and the phone
 * assistant. Every call is audited as mcp.<tool> with the key's id.
 */
export function createMcpServer(caller: ApiCaller, d: McpDeps): McpServer {
  const server = new McpServer({ name: 'attendra', version: '0.4.0' }, {
    instructions: 'Attendra is a medical clinic\'s front desk. You can find open appointment times, read today\'s schedule and the request queue, close a request, and read quality numbers. You cannot book or cancel.',
  });
  const now = d.now ?? (() => new Date());
  const desk = new FrontDeskRepository(d.db, d.cipher);
  const has = (s: ApiScope) => caller.scopes.includes(s);
  const clinic = async () => ClinicConfig.parse(await desk.settings(caller.clinicId));
  /** Checks the scope, runs the tool, and audits the use, whatever the answer. */
  const tool = <T>(name: string, scope: ApiScope | null, fn: (args: T) => Promise<{ result: unknown; counts?: Record<string, number> }>) => async (args: T) => {
    if (scope && !has(scope)) {
      await auditKeyUse(d.db, caller, `${name}.refused`);
      return refused(`This key does not have the ${scope} scope. Ask the clinic's owner or practice manager for a key that does.`);
    }
    try {
      const { result, counts } = await fn(args);
      await auditKeyUse(d.db, caller, name, counts);
      return text(result);
    } catch (err) {
      d.log.warn({ clinic_id: caller.clinicId, tool: name, err: { name: (err as Error).name } }, 'mcp tool failed');
      await auditKeyUse(d.db, caller, `${name}.failed`);
      return refused('That did not work. Try again, or check the arguments.');
    }
  };

  server.registerTool('find_open_slots', {
    title: 'Find open appointment times',
    description: 'Open times for a visit type, over the next days, optionally for one provider. No patient data. Needs schedule:read. It does not book: offer the times to a person or the caller.',
    inputSchema: {
      visitTypeId: z.string().describe('A visit type id from the clinic, like vt_sick'),
      providerId: z.string().optional().describe('Only this provider'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day, YYYY-MM-DD in the clinic\'s time zone; today if left out'),
      days: z.number().int().min(1).max(14).default(7),
      partOfDay: z.enum(['morning', 'afternoon', 'any']).default('any'),
    },
    annotations: { readOnlyHint: true },
  }, tool('find_open_slots', 'schedule:read', async (a: { visitTypeId: string; providerId?: string; from?: string; days: number; partOfDay: 'morning' | 'afternoon' | 'any' }) => {
    const c = await clinic();
    const from = a.from ?? localDateOf(now(), c.timezone);
    const busy = await desk.busy(c.id, { from: zonedInstant(from, '00:00', c.timezone), to: zonedInstant(addDays(from, a.days + 1), '00:00', c.timezone) });
    const slots = openSlots(c, busy, { visitTypeId: a.visitTypeId, providerId: a.providerId, from, days: a.days, partOfDay: a.partOfDay, now: now(), limit: 20 });
    const names = (id: string) => c.providers.find((p) => p.id === id)?.name ?? id;
    return {
      result: { timezone: c.timezone, visitTypes: c.visitTypes.map((v) => ({ id: v.id, name: v.name })), slots: slots.map((s) => ({ providerId: s.providerId, provider: names(s.providerId), startsAt: s.start.toISOString(), endsAt: s.end.toISOString() })) },
      counts: { slots: slots.length },
    };
  }));

  server.registerTool('list_todays_schedule', {
    title: 'Today\'s schedule',
    description: 'Today\'s appointments, by provider, in the clinic\'s time zone. Patient names are shown only to a key with schedule:read, and that view is audited.',
    inputSchema: { providerId: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, tool('list_todays_schedule', null, async (a: { providerId?: string }) => {
    const c = await clinic();
    const today = localDateOf(now(), c.timezone);
    const names = has('schedule:read');
    const rows = await withClinic(d.db, c.id, (tx) => tx.select({ a: schema.appointments, first: schema.patients.firstNameEnc, last: schema.patients.lastNameEnc })
      .from(schema.appointments).innerJoin(schema.patients, eq(schema.patients.id, schema.appointments.patientId))
      .where(and(eq(schema.appointments.clinicId, c.id), eq(schema.appointments.status, 'booked'), gt(schema.appointments.startsAt, zonedInstant(today, '00:00', c.timezone)),
        lt(schema.appointments.startsAt, zonedInstant(addDays(today, 1), '00:00', c.timezone)), a.providerId ? eq(schema.appointments.providerId, a.providerId) : undefined))
      .orderBy(asc(schema.appointments.startsAt)));
    const ctx = (col: string) => phiContext(c.id, col);
    return {
      result: {
        date: today, timezone: c.timezone,
        appointments: rows.map(({ a: x, first, last }) => ({
          appointmentId: x.id, providerId: x.providerId, visitTypeId: x.visitTypeId, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(),
          ...(names ? { patient: `${d.cipher.decrypt(first, ctx('patients.first_name'))} ${d.cipher.decrypt(last, ctx('patients.last_name'))}` } : {}),
        })),
      },
      counts: { appointments: rows.length, names: names ? rows.length : 0 },
    };
  }));

  server.registerTool('list_open_requests', {
    title: 'Open requests',
    description: 'Refill and callback requests waiting for staff, oldest first, with the patient and the details. Needs requests:read, and each request shown is audited.',
    inputSchema: { type: z.enum(['refill', 'callback', 'voicemail', 'review']).optional() },
    annotations: { readOnlyHint: true },
  }, tool('list_open_requests', 'requests:read', async (a: { type?: 'refill' | 'callback' | 'voicemail' | 'review' }) => {
    // read as the key's creator, so every request shown writes its task.viewed row too
    const tasks = await desk.listTasks(caller.clinicId, { status: 'open', type: a.type, limit: 50 }, caller.createdByUserId);
    return {
      result: { requests: tasks.map((t) => ({ requestId: t.id, type: t.type, createdAt: t.createdAt.toISOString(), claimed: !!t.assigneeUserId, patient: t.patientName, details: t.details, suggestedFollowUp: t.followUp })) },
      counts: { requests: tasks.length },
    };
  }));

  server.registerTool('mark_request_done', {
    title: 'Close a request',
    description: 'Mark an open request done, with what came of it. Needs requests:write. It fails if someone else holds the request.',
    inputSchema: { requestId: z.uuid(), outcome: z.enum(['called_back', 'left_message', 'refill_sent', 'not_needed']) },
    annotations: { destructiveHint: false, idempotentHint: true },
  }, tool('mark_request_done', 'requests:write', async (a: { requestId: string; outcome: 'called_back' | 'left_message' | 'refill_sent' | 'not_needed' }) => {
    // closed in the name of the person who made the key: a key never acts on its own authority
    const done = await desk.completeTask(caller.clinicId, a.requestId, caller.createdByUserId, a.outcome);
    if (done === 'done') {
      const facts = await taskFacts(d.db, caller.clinicId, a.requestId);
      if (facts) await d.onRequestDone?.(caller.clinicId, facts).catch(() => {});
    }
    return { result: { requestId: a.requestId, status: done === 'done' ? 'done' : done === 'taken' ? 'held_by_someone_else' : 'not_found' } };
  }));

  server.registerTool('get_quality_summary', {
    title: 'How the assistant is doing',
    description: 'The last 7 days: calls handled without staff, booking success, refusals, transfers, calls flagged for review, after-hours calls and cost. Counts only.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, tool('get_quality_summary', null, async () => {
    const c = await clinic();
    const to = now();
    const rows = await qualityRows(d.db, c.id, new Date(to.getTime() - 7 * 86_400_000), to);
    return { result: { days: 7, ...qualityOf(rows.map((r) => ({ ...r, afterHours: !isOpen(c, r.startedAt) })), COST_PER_MINUTE) } };
  }));

  return server;
}
