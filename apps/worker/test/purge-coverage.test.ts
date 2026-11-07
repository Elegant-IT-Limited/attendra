import { DEMO_CLINIC } from '@attendra/core';
import { ensureWorkerJobsView, purgeClinic, saveClinic, UNFINISHED_CALL_HOURS } from '@attendra/db';
import { openTestDatabase } from '@attendra/db/testing';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, ensureQueues, QUEUES } from '../src/queue';

/**
 * A removed clinic is really deleted: the Terms promise it. Every table in every schema with a
 * clinic, organization or user column is read from the catalog, so a new table that the purge
 * forgets fails here, as a new setting with no row fails settings-coverage. Each one must hold
 * a row of the clinic before the purge (add it to `seed` below) and none after.
 */
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let boss: PgBoss;
beforeAll(async () => {
  t = await openTestDatabase();
  boss = createBoss({ pglite: t.client });
  await boss.start();
  await ensureQueues(boss);
  await ensureWorkerJobsView((text) => t.client.exec(text));
}, 60_000);
afterAll(async () => { await boss.stop({ graceful: false }); await t.close(); });

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const NOW = new Date('2026-03-01T00:00:00Z');
const q = async <T>(text: string, params: unknown[] = []) => (await t.client.query(text, params)).rows as T[];

/** Columns that name a clinic, an organization or a person, in every schema. */
type Column = { schema: string; table: string; column: string; kind: 'clinic' | 'organization' | 'user' };
async function columns(): Promise<Column[]> {
  const rows = await q<{ schema: string; table: string; column: string }>(`
    select c.table_schema as schema, c.table_name as table, c.column_name as column
    from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
    where t.table_type = 'BASE TABLE' and c.table_schema not in ('pg_catalog', 'information_schema')
      -- a migration's rollback copy, kept for one release (memberships_before_0046), is not live data
      and c.table_name !~ '_before_[0-9]{4}$'
      and (c.column_name in ('clinic_id', 'user_id', 'inviter_id') or c.column_name like '%organization_id' or c.column_name like '%\\_user\\_id')
    order by 1, 2, 3`);
  return rows.map((r) => ({ ...r, kind: r.column === 'clinic_id' ? 'clinic' : r.column.endsWith('organization_id') ? 'organization' : 'user' }));
}

/** Rows that point at what was removed: the clinic, its organization and its people, column by column; and the worker's jobs about it. */
async function scan(clinicId: string, orgId: string, userIds: string[]) {
  const found: Record<string, number> = {};
  for (const c of await columns()) {
    const values = c.kind === 'clinic' ? [clinicId] : c.kind === 'organization' ? [orgId] : userIds;
    const [row] = await q<{ n: number }>(`select count(*)::int as n from "${c.schema}"."${c.table}" where "${c.column}" = any($1)`, [values]);
    found[`${c.schema}.${c.table}.${c.column}`] = Number(row!.n);
  }
  const [jobs] = await q<{ n: number }>(`select count(*)::int as n from pgboss.job where data->>'clinicId' = $1`, [clinicId]);
  found['pgboss.job.data.clinicId'] = Number(jobs!.n);
  for (const [table, key, id] of [['clinics', 'id', clinicId], ['organizations', 'id', orgId]] as const) {
    found[`public.${table}.${key}`] = Number((await q<{ n: number }>(`select count(*)::int as n from ${table} where ${key} = $1`, [id]))[0]!.n);
  }
  found['public.auth_users.id'] = Number((await q<{ n: number }>(`select count(*)::int as n from auth_users where id = any($1)`, [userIds]))[0]!.n);
  return found;
}

/**
 * One row in every table the purge must empty, all pointing at this clinic, its organization
 * and its owner. A new table with such a column needs a line here, or the "before" check fails.
 */
async function seed(clinicId: string, orgId: string, owner: string, phone: string) {
  await saveClinic(t.db, orgId, { ...DEMO_CLINIC, id: clinicId, name: `Clinic ${clinicId}`, phoneNumbers: [phone] });
  await q(`insert into auth_users (id, name, email) values ($1, 'Robin Example', $2)`, [owner, `${owner}@example.com`]);
  await q(`insert into auth_accounts (id, user_id, account_id, provider_id) values ($1, $2, $2, 'credential')`, [`acc_${owner}`, owner]);
  await q(`insert into auth_sessions (id, user_id, token, expires_at, active_organization_id) values ($1, $2, $1, now() + interval '1 day', $3)`, [`ses_${owner}`, owner, orgId]);
  await q(`insert into auth_two_factors (id, user_id, secret, backup_codes) values ($1, $2, 'x', 'x')`, [`tf_${owner}`, owner]);
  await q(`insert into user_avatars (user_id, bytes, content_type) values ($1, '\\x52494646', 'image/webp')`, [owner]);
  await q(`insert into memberships (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')`, [`mem_${owner}`, orgId, owner]);
  // and someone on the front desk of this location only
  await q(`insert into auth_users (id, name, email) values ($1, 'Dana Example', $2)`, [`${owner}_desk`, `${owner}.desk@example.com`]);
  await q(`insert into clinic_memberships (id, clinic_id, user_id, role) values ($1, $2, $3, 'staff')`, [`cm_${owner}`, clinicId, `${owner}_desk`]);
  await q(`insert into invitations (id, organization_id, email, role, inviter_id, expires_at, clinic_id) values ($1, $2, 'new.hire@example.com', 'staff', $3, now() + interval '7 days', $4)`, [`inv_${owner}`, orgId, owner, clinicId]);
  await q(`select set_config('app.clinic_id', $1, false)`, [clinicId]);
  const [patient] = await q<{ id: string }>(`insert into patients (clinic_id, lookup_hash, first_name_enc, last_name_enc, dob_enc, phone_enc, phone_hash) values ($1, 'h', 'x', 'x', 'x', 'x', 'h') returning id`, [clinicId]);
  const [call] = await q<{ id: string }>(`insert into calls (clinic_id, openai_session_id, patient_id, ended_at) values ($1, $2, $3, now()) returning id`, [clinicId, `sess_${clinicId}`, patient!.id]);
  await q(`update patients set created_by_call_id = $1 where id = $2`, [call!.id, patient!.id]);
  await q(`insert into call_segments (clinic_id, call_id, speaker, text_enc, start_ms, end_ms) values ($1, $2, 'caller', 'x', 0, 1)`, [clinicId, call!.id]);
  await q(`insert into patient_search_keys (clinic_id, key, patient_id) values ($1, 'k', $2)`, [clinicId, patient!.id]);
  await q(`insert into call_search_keys (clinic_id, key, call_id) values ($1, 'k', $2)`, [clinicId, call!.id]);
  await q(`insert into call_actions (clinic_id, call_id, tool, args_redacted, result, task_revision) values ($1, $2, 'find_slots', '{}', '{}', 0)`, [clinicId, call!.id]);
  await q(`insert into call_costs (call_id, clinic_id, engine, rates_version) values ($1, $2, 'gpt-live', 'test')`, [call!.id, clinicId]);
  await q(`insert into call_summaries (call_id, clinic_id, body_enc, intent, sentiment, needs_review, model, reviewed_by_user_id) values ($1, $2, 'x', 'book', 'calm', false, 'm', $3)`, [call!.id, clinicId, owner]);
  const [appt] = await q<{ id: string }>(`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id, cancelled_by_user_id)
    values ($1, $2, 'prov', 'vt', now(), now() + interval '15 minutes', 'k', $3, $3) returning id`, [clinicId, patient!.id, owner]);
  const [task] = await q<{ id: string }>(`insert into tasks (clinic_id, number, type, call_id, patient_id, details_enc, idempotency_key, assignee_user_id, done_by_user_id, assigned_by_user_id, created_by_user_id)
    values ($1, 1, 'callback', $2, $3, 'x', 'k', $4, $4, $4, $4) returning id`, [clinicId, call!.id, patient!.id, owner]);
  // the clinic's request counter goes with it
  await q(`insert into clinic_counters (clinic_id, next_request) values ($1, 2)`, [clinicId]);
  await q(`insert into task_notes (clinic_id, task_id, author_user_id, body_enc) values ($1, $2, $3, 'x')`, [clinicId, task!.id, owner]);
  await q(`insert into sms_messages (clinic_id, template, to_hash, idempotency_key, call_id, patient_id, task_id, appointment_id) values ($1, 'address', 'h', 'k', $2, $3, $4, $5)`, [clinicId, call!.id, patient!.id, task!.id, appt!.id]);
  await q(`insert into sms_opt_outs (clinic_id, to_hash, status, source) values ($1, 'h', 'opted_out', 'keyword')`, [clinicId]);
  const [doc] = await q<{ id: string }>(`insert into knowledge_documents (clinic_id, title, source_type, content, content_hash, size_bytes, uploaded_by_user_id) values ($1, 'Policies', 'text', 'x', 'h', 1, $2) returning id`, [clinicId, owner]);
  await q(`insert into knowledge_chunks (clinic_id, document_id, ordinal, body, token_count, embedding, model) values ($1, $2, 0, 'x', 1, $3, 'm')`, [clinicId, doc!.id, `[${new Array(1536).fill(0).join(',')}]`]);
  const [endpoint] = await q<{ id: string }>(`insert into webhook_endpoints (clinic_id, url, events, secret_enc, created_by_user_id) values ($1, 'https://hooks.example.com/x', '{request.done}', 'x', $2) returning id`, [clinicId, owner]);
  await q(`insert into webhook_events (id, clinic_id, type, data, occurred_at) values ($1, $2, 'request.done', '{}', now())`, [`evt_${clinicId}`, clinicId]);
  await q(`insert into webhook_attempts (clinic_id, endpoint_id, event_id, kind, attempt, duration_ms) values ($1, $2, $3, 'test', 1, 10)`, [clinicId, endpoint!.id, `evt_${clinicId}`]);
  await q(`insert into api_keys (clinic_id, name, prefix, key_hash, scopes, expires_at, created_by_user_id) values ($1, 'Agent', $2, $2, '{schedule:read}', now() + interval '30 days', $3)`, [clinicId, `pre_${clinicId}`, owner]);
  await q(`insert into audit_logs (clinic_id, actor, action, entity) values ($1, 'test', 'seeded', 'clinic')`, [clinicId]);
  await boss.send(QUEUES.summariseCall, { clinicId, callId: call!.id });
  await q(`select set_config('app.clinic_id', '', false)`);
  // closed as the hosting layer closes it: its numbers no longer reach it
  await q(`update clinics set closed_at = $1 where id = $2`, [LONG_AGO, clinicId]);
  await q(`update phone_numbers set status = 'released' where clinic_id = $1`, [clinicId]);
}

describe('deleting a removed clinic leaves nothing of it', () => {
  it('every table with a clinic, organization or user column held a row before, and holds none after; another team is untouched', async () => {
    await seed('clinic_gone', 'org_gone', 'user_gone', '+13035550181');
    await seed('clinic_kept', 'org_kept', 'user_kept', '+13035550182');
    await q(`update clinics set closed_at = null where id = 'clinic_kept'`);
    // someone on both teams keeps their login and the other team
    await q(`insert into auth_users (id, name, email) values ('user_both', 'Sam Example', 'sam@example.com')`);
    await q(`insert into clinic_memberships (id, clinic_id, user_id, role) values ('mem_both_1', 'clinic_gone', 'user_both', 'staff'), ('mem_both_2', 'clinic_kept', 'user_both', 'staff')`);

    const before = await scan('clinic_gone', 'org_gone', ['user_gone', 'user_gone_desk']);
    const empty = Object.entries(before).filter(([, n]) => n === 0).map(([k]) => k);
    expect(empty, 'tables with no row of the clinic before the purge: seed one').toEqual([]);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['public.call_actions.clinic_id', 'public.call_segments.clinic_id', 'public.knowledge_chunks.clinic_id', 'public.invitations.clinic_id', 'pgboss.job.data.clinicId']));
    const kept = await scan('clinic_kept', 'org_kept', ['user_kept', 'user_kept_desk', 'user_both']);

    expect(await purgeClinic(t.db, 'clinic_gone', { now: NOW })).toMatchObject({ status: 'purged' });
    const after = await scan('clinic_gone', 'org_gone', ['user_gone', 'user_gone_desk']);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    expect(await scan('clinic_kept', 'org_kept', ['user_kept', 'user_kept_desk', 'user_both'])).toEqual({ ...kept, 'public.clinic_memberships.user_id': kept['public.clinic_memberships.user_id']! - 1 });
    expect(await q(`select clinic_id from clinic_memberships where user_id = 'user_both'`)).toEqual([{ clinic_id: 'clinic_kept' }]);
  });

  it('a location: its own rows go, and the organization, its team and its other clinic stay', async () => {
    await seed('clinic_main', 'org_two', 'user_two', '+13035550183');
    await q(`update clinics set closed_at = null where id = 'clinic_main'`);
    await saveClinic(t.db, 'org_two', { ...DEMO_CLINIC, id: 'clinic_branch', name: 'Branch', phoneNumbers: ['+13035550184'] });
    await q(`update phone_numbers set status = 'released' where clinic_id = 'clinic_branch'`);
    // the team and the main clinic, before the branch's own invitation is sent
    const main = await scan('clinic_main', 'org_two', ['user_two']);
    await q(`insert into invitations (id, organization_id, email, role, inviter_id, expires_at, clinic_id) values ('inv_branch', 'org_two', 'branch.hire@example.com', 'staff', 'user_two', now() + interval '7 days', 'clinic_branch')`);
    await boss.send(QUEUES.summariseCall, { clinicId: 'clinic_branch', callId: '00000000-0000-4000-8000-000000000001' });
    await q(`update clinics set closed_at = $1 where id = 'clinic_branch'`, [LONG_AGO]);

    expect(await purgeClinic(t.db, 'clinic_branch', { now: NOW })).toMatchObject({ status: 'purged' });
    const branch = await scan('clinic_branch', 'nothing', []);
    expect(Object.entries(branch).filter(([, n]) => n > 0)).toEqual([]);
    expect(await scan('clinic_main', 'org_two', ['user_two'])).toEqual(main);
  });
});

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
const LOGIN_TABLES = ['public.auth_users.id', 'public.auth_accounts.user_id', 'public.auth_sessions.user_id', 'public.auth_two_factors.user_id', 'public.user_avatars.user_id'];

describe('wiping a test clinic: force, keepLogins and a dry run', () => {
  it('a dry run counts what a real run deletes, row for row, and changes nothing', async () => {
    await seed('clinic_dry', 'org_dry', 'user_dry', '+13035550185');
    const before = await scan('clinic_dry', 'org_dry', ['user_dry', 'user_dry_desk']);
    const dry = await purgeClinic(t.db, 'clinic_dry', { now: NOW, dryRun: true });
    expect(dry).toMatchObject({ status: 'dry_run', blockers: [] });
    expect(await scan('clinic_dry', 'org_dry', ['user_dry', 'user_dry_desk'])).toEqual(before);
    const done = await purgeClinic(t.db, 'clinic_dry', { now: NOW });
    expect(done.status).toBe('purged');
    expect(done.status === 'purged' && done.counts).toEqual(dry.status === 'dry_run' && dry.counts);
    expect(dry.status === 'dry_run' && dry.counts).toMatchObject({ clinics: 1, organizations: 1, calls: 1, patients: 1, auth_users: 2, 'pgboss.job': 1, clinic_memberships: 1 });
  });

  it('force takes an open clinic; without it the clinic is refused and kept', async () => {
    await seed('clinic_open', 'org_open', 'user_open', '+13035550186');
    await q(`update clinics set closed_at = null where id = 'clinic_open'`);
    expect(await purgeClinic(t.db, 'clinic_open')).toEqual({ status: 'refused', blockers: ['not_closed'] });
    await q(`update clinics set closed_at = now() where id = 'clinic_open'`);
    expect(await purgeClinic(t.db, 'clinic_open')).toEqual({ status: 'refused', blockers: ['closed_recently'] });
    await q(`update clinics set closed_at = null where id = 'clinic_open'`);
    expect(total((await scan('clinic_open', 'org_open', ['user_open'])))).toBeGreaterThan(0);
    expect(await purgeClinic(t.db, 'clinic_open', { force: true })).toMatchObject({ status: 'purged' });
    expect(Object.entries(await scan('clinic_open', 'org_open', ['user_open', 'user_open_desk'])).filter(([, n]) => n > 0)).toEqual([]);
  });

  it('keepLogins: the logins stay with their sign-in, the clinic\'s and organization\'s memberships go, and another team is untouched', async () => {
    await seed('clinic_tester', 'org_tester', 'user_tester', '+13035550187');
    await seed('clinic_other', 'org_other', 'user_other', '+13035550188');
    const other = await scan('clinic_other', 'org_other', ['user_other', 'user_other_desk']);
    const result = await purgeClinic(t.db, 'clinic_tester', { force: true, keepLogins: true });
    expect(result.status).toBe('purged');
    expect(result.status === 'purged' && result.counts.auth_users).toBeUndefined();
    const after = await scan('clinic_tester', 'org_tester', ['user_tester', 'user_tester_desk']);
    expect(Object.entries(after).filter(([k, n]) => n > 0 && !LOGIN_TABLES.includes(k)).map(([k]) => k)).toEqual([]);
    expect(await q(`select id from auth_users where id in ('user_tester', 'user_tester_desk') order by id`)).toEqual([{ id: 'user_tester' }, { id: 'user_tester_desk' }]);
    expect(await q(`select id from auth_accounts where user_id = 'user_tester'`)).toHaveLength(1);
    expect(await q(`select active_organization_id from auth_sessions where user_id = 'user_tester'`)).toEqual([{ active_organization_id: null }]);
    expect(await q(`select 1 from memberships where user_id = 'user_tester' union all select 1 from clinic_memberships where user_id = 'user_tester_desk'`)).toEqual([]);
    expect(await scan('clinic_other', 'org_other', ['user_other', 'user_other_desk'])).toEqual(other);
  });

  it('refuses while a call is going or a number still reaches the clinic, even with force; a dry run says why and still counts', async () => {
    await seed('clinic_busy', 'org_busy', 'user_busy', '+13035550189');
    const before = await scan('clinic_busy', 'org_busy', ['user_busy']);
    await q(`select set_config('app.clinic_id', 'clinic_busy', false)`);
    await q(`insert into calls (clinic_id, openai_session_id) values ('clinic_busy', 'sess_live')`);
    // a call a crash left open days ago is not going
    await q(`insert into calls (clinic_id, openai_session_id, started_at) values ('clinic_busy', 'sess_stale', now() - interval '${UNFINISHED_CALL_HOURS + 1} hours')`);
    await q(`select set_config('app.clinic_id', '', false)`);
    await q(`update phone_numbers set status = 'active' where clinic_id = 'clinic_busy'`);
    expect(await purgeClinic(t.db, 'clinic_busy', { force: true })).toEqual({ status: 'refused', blockers: ['call_in_progress', 'number_assigned'] });
    const dry = await purgeClinic(t.db, 'clinic_busy', { force: true, dryRun: true });
    expect(dry).toMatchObject({ status: 'dry_run', blockers: ['call_in_progress', 'number_assigned'], counts: { calls: 3, clinics: 1 } });

    await q(`update phone_numbers set status = 'released' where clinic_id = 'clinic_busy'`);
    expect(await purgeClinic(t.db, 'clinic_busy', { force: true })).toEqual({ status: 'refused', blockers: ['call_in_progress'] });
    await q(`select set_config('app.clinic_id', 'clinic_busy', false)`);
    await q(`update calls set ended_at = now() where openai_session_id = 'sess_live'`);
    await q(`select set_config('app.clinic_id', '', false)`);
    expect(await purgeClinic(t.db, 'clinic_busy', { force: true })).toMatchObject({ status: 'purged', blockers: [] });
    expect(total(before)).toBeGreaterThan(0);
    expect(await purgeClinic(t.db, 'clinic_busy', { force: true })).toEqual({ status: 'not_found' });
  });
});
