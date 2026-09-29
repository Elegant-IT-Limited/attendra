import { DEMO_CLINIC } from '@attendra/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, clinicsForUser, createPhiCipher, FrontDeskRepository, PostgresTaskQueue, saveClinic, schema, seedDemo, staffRole, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let desk: FrontDeskRepository;
let callId: string;
let otherCallId: string;
let refillId: string;

const audit = async (action: string) =>
  (await t.db.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[];

beforeAll(async () => {
  t = await openTestDatabase();
  const { patientIds } = await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  await t.db.execute(sql`insert into auth_users (id, name, email) values ('u_ana', 'Ana Front', 'ana@example.test'), ('u_ben', 'Ben Desk', 'ben@example.test')`);
  await t.db.execute(sql`insert into memberships (id, organization_id, user_id, role) values ('m1', 'org_demo', 'u_ana', 'staff'), ('m2', 'org_demo', 'u_ben', 'staff')`);

  const repo = new CallRepository(t.db, cipher);
  callId = await repo.open(DEMO_CLINIC.id, 'live_fd_1', '+13035550147');
  await repo.appendSegment(DEMO_CLINIC.id, callId, { speaker: 'caller', text: 'This is Maria Delgado, I need my lisinopril refilled.', startMs: 0, endMs: 900 });
  await repo.recordAction(DEMO_CLINIC.id, callId, { tool: 'verify_identity', argsRedacted: ['full_name', 'dob'], result: { ok: true, verified: true }, idempotencyKey: null, taskRevision: 1 });
  await repo.close(DEMO_CLINIC.id, callId, { reason: 'caller_hangup', voiceSeconds: 61.5, outcome: 'task_created', emergency: false });
  otherCallId = await repo.open(OTHER.id, 'live_fd_2', null);
  ({ id: refillId } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, {
    type: 'refill', callId, patientId: patientIds.maria!, idempotencyKey: 'fd-refill', details: { medication: 'lisinopril', pharmacy: 'Main St', callback_number: '+13035550147' },
  }));
  desk = new FrontDeskRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('access', () => {
  it('a member sees the clinics of their organization and nothing else', async () => {
    expect((await clinicsForUser(t.db, 'u_ana')).map((c) => c.clinicId)).toEqual([DEMO_CLINIC.id]);
    expect(await staffRole(t.db, 'u_ana', DEMO_CLINIC.id)).toBe('staff');
    expect(await staffRole(t.db, 'u_ana', OTHER.id)).toBeNull();
  });
});

describe('calls', () => {
  it('lists calls without patient data, with the tools that ran', async () => {
    const [row, ...rest] = await desk.listCalls(DEMO_CLINIC.id, { limit: 50 });
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ id: callId, outcome: 'task_created', verified: true, tools: ['verify_identity'], voiceSeconds: 61.5 });
    expect(JSON.stringify(row)).not.toContain('Maria');
  });

  it('shows a transcript and audits the view', async () => {
    const call = await desk.getCall(DEMO_CLINIC.id, callId, 'u_ana');
    expect(call?.transcript[0]?.text).toContain('lisinopril');
    expect(call?.tasks).toEqual([{ id: refillId, type: 'refill', status: 'open' }]);
    expect(await audit('call.transcript.viewed')).toEqual([{ actor: 'user:u_ana', entity_id: callId }]);
  });

  it('cannot open another clinic\'s call, even by id', async () => {
    expect(await desk.getCall(DEMO_CLINIC.id, otherCallId, 'u_ana')).toBeNull();
    expect(await desk.listCalls(OTHER.id, { limit: 50 })).toHaveLength(1);
  });
});

describe('task queue', () => {
  it('decrypts details and the patient name for staff, one audit row per task shown', async () => {
    const [task] = await desk.listTasks(DEMO_CLINIC.id, { status: 'open', limit: 50 }, 'u_ana');
    expect(task).toMatchObject({ id: refillId, type: 'refill', patientName: 'Maria Delgado', details: { medication: 'lisinopril' } });
    expect((await audit('task.viewed')).map((r) => r.entity_id)).toEqual([refillId]);
  });

  it('lets one person hold a task; a second claim or close by someone else is refused', async () => {
    expect(await desk.claimTask(DEMO_CLINIC.id, refillId, 'u_ana')).toBe('claimed');
    expect(await desk.claimTask(DEMO_CLINIC.id, refillId, 'u_ben')).toBe('taken');
    expect(await desk.completeTask(DEMO_CLINIC.id, refillId, 'u_ben')).toBe('taken');
    expect(await desk.completeTask(DEMO_CLINIC.id, refillId, 'u_ana')).toBe('done');
    expect(await desk.completeTask(DEMO_CLINIC.id, refillId, 'u_ana')).toBe('taken'); // already closed
    expect(await desk.claimTask(OTHER.id, refillId, 'u_ana')).toBe('not_found');
    expect((await desk.listTasks(DEMO_CLINIC.id, { status: 'done', limit: 50 }, 'u_ana'))[0]).toMatchObject({ id: refillId, doneByUserId: 'u_ana' });
  });
});

describe('release and count', () => {
  it('counts open tasks and lets the holder, or an override, give one back', async () => {
    const { id } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, {
      type: 'callback', callId, patientId: null, idempotencyKey: 'fd-callback', details: { reason: 'billing question', callback_number: '+13035550147' },
    });
    expect(await desk.openTaskCount(DEMO_CLINIC.id)).toBe(1);
    expect(await desk.openTaskCount(OTHER.id)).toBe(0);
    expect(await desk.claimTask(DEMO_CLINIC.id, id, 'u_ana')).toBe('claimed');
    expect(await desk.releaseTask(DEMO_CLINIC.id, id, 'u_ben', false)).toBe('taken');
    expect(await desk.releaseTask(DEMO_CLINIC.id, id, 'u_ben', true)).toBe('released');
    expect((await audit('task.released.override')).map((r) => r.actor)).toEqual(['user:u_ben']);
    expect(await desk.releaseTask(DEMO_CLINIC.id, id, 'u_ana', false)).toBe('taken'); // nobody holds it now
  });
});

describe('settings', () => {
  it('saves inside the clinic\'s own scope and audits the change', async () => {
    const config = { ...DEMO_CLINIC, greeting: 'Thanks for calling Maple Street. I am the clinic\'s AI assistant.' };
    await desk.saveSettings(DEMO_CLINIC.id, config, 'u_ana');
    expect(await desk.settings(DEMO_CLINIC.id)).toMatchObject({ greeting: config.greeting });
    expect((await desk.settings(OTHER.id)) as { greeting: string }).toMatchObject({ greeting: DEMO_CLINIC.greeting });
    expect((await desk.auditTrail(DEMO_CLINIC.id, { limit: 5, actions: ['clinic.settings.updated'] }))[0]).toMatchObject({ actor: 'user:u_ana' });
  });

  it('the application role cannot rename another clinic, even with its id in the query', async () => {
    const touched = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.update(schema.clinics).set({ name: 'Hijacked' }).where(eq(schema.clinics.id, OTHER.id)).returning());
    expect(touched).toHaveLength(0);
    const [other] = (await t.db.execute(sql`select name from clinics where id = ${OTHER.id}`)).rows as { name: string }[];
    expect(other?.name).toBe('Other Clinic');
  });
});

describe('auth tables', () => {
  it('are out of reach of the application role', async () => {
    const r = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role attendra_app`);
      return tx.execute(sql`select * from auth_users`).then(() => 'read', (e: { cause?: { message?: string } }) => e.cause?.message ?? 'failed');
    });
    expect(r).toMatch(/permission denied/);
  });
});
