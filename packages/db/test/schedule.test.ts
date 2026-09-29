import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, FrontDeskRepository, patientSetKey, phiContext, saveClinic, ScheduleRepository, schema, seedDemo, seedDemoSchedule, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const tz = DEMO_CLINIC.timezone;
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
const day = (date: string) => ({ from: zonedInstant(date, '00:00', tz), to: zonedInstant(date, '23:59', tz) });
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let schedule: ScheduleRepository;
let ids: Record<string, string>;
let callId: string;
let byCall: string;
let byStaff: string;

const audit = async (action: string) =>
  ((await t.db.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[]);

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedDemo(t.db, cipher));
  await saveClinic(t.db, 'org_other', OTHER);
  await t.db.execute(sql`insert into auth_users (id, name, email) values ('u_ana', 'Ana Front', 'ana@example.test'), ('u_otto', 'Otto Other', 'otto@example.test')`);
  await t.db.execute(sql`insert into memberships (id, organization_id, user_id, role) values ('m1', 'org_demo', 'u_ana', 'staff'), ('m2', 'org_other', 'u_otto', 'owner')`);
  callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_sched_1', null);
  const insert = (values: Partial<typeof schema.appointments.$inferInsert>) => withClinic(t.db, DEMO_CLINIC.id, async (tx) => {
    const [row] = await tx.insert(schema.appointments).values({
      clinicId: DEMO_CLINIC.id, patientId: ids.maria!, providerId: 'prov_okafor', visitTypeId: 'vt_sick',
      startsAt: zonedInstant('2026-09-29', '09:00', tz), endsAt: zonedInstant('2026-09-29', '09:20', tz), idempotencyKey: crypto.randomUUID(), ...values,
    }).returning({ id: schema.appointments.id });
    return row!.id;
  });
  byCall = await insert({ createdByCallId: callId });
  byStaff = await insert({
    patientId: ids.james!, startsAt: zonedInstant('2026-09-29', '10:00', tz), endsAt: zonedInstant('2026-09-29', '10:20', tz), createdByUserId: 'u_ana',
    noteEnc: cipher.encrypt('Bring the knee brace.', phiContext(DEMO_CLINIC.id, 'appointments.note')), status: 'cancelled', cancelledByUserId: 'u_otto', cancelReason: 'patient_asked',
  });
  schedule = new ScheduleRepository(t.db, cipher);
});
afterAll(() => t.close());

describe('the schedule', () => {
  it('lists the day with patient names and who booked each appointment', async () => {
    const rows = await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-29'), label: '2026-09-29+1' }, 'u_ana');
    expect(rows.map((r) => [r.patientName, r.bookedBy, r.status])).toEqual([
      ['Maria Delgado', { kind: 'assistant', callId }, 'booked'],
      ['James Whitaker', { kind: 'staff', userId: 'u_ana', name: 'Ana Front' }, 'cancelled'],
    ]);
  });

  it('never names someone outside the clinic\'s organization, even when their id is on a row', async () => {
    const [, cancelled] = await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-29'), label: '2026-09-29+1' }, 'u_ana');
    expect(cancelled!.cancelledBy).toEqual({ kind: 'staff', userId: 'u_otto', name: null });
  });

  it('writes one audit row for a view, and the same view refreshed within 5 minutes is covered by it', async () => {
    const key = `2026-09-29+1;provider=all;${patientSetKey([ids.maria!, ids.james!])}`;
    expect(await audit('schedule.viewed')).toEqual([{ actor: 'user:u_ana', entity_id: key }]);
    await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-29'), label: '2026-09-29+1' }, 'u_ana'); // an identical refresh
    expect(await audit('schedule.viewed')).toHaveLength(1);
    await t.db.execute(sql`update audit_logs set at = at - interval '6 minutes' where action = 'schedule.viewed'`);
    await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-29'), label: '2026-09-29+1' }, 'u_ana');
    expect((await audit('schedule.viewed')).map((r) => r.entity_id)).toEqual([key, key]);
  });

  it('writes a new row when anything that changes what is shown changes: the provider filter, the range, or who is on it', async () => {
    const before = (await audit('schedule.viewed')).length;
    await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-29'), providerId: 'prov_okafor', label: '2026-09-29+1' }, 'u_ana');
    await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-30'), label: '2026-09-30+1' }, 'u_ana');
    expect((await audit('schedule.viewed')).length).toBe(before + 2);
    // a new appointment appears on the same day, within the window: a new patient on screen, a new row
    await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.appointments).values({
      clinicId: DEMO_CLINIC.id, patientId: ids.sam_a!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', createdByUserId: 'u_ana', idempotencyKey: 'new-in-window',
      startsAt: zonedInstant('2026-09-29', '11:00', tz), endsAt: zonedInstant('2026-09-29', '11:20', tz),
    }));
    await schedule.range(DEMO_CLINIC.id, { ...day('2026-09-29'), label: '2026-09-29+1' }, 'u_ana');
    const rows = await audit('schedule.viewed');
    expect(rows.length).toBe(before + 3);
    expect(rows.at(-1)!.entity_id).toBe(`2026-09-29+1;provider=all;${patientSetKey([ids.maria!, ids.james!, ids.sam_a!])}`);
  });

  it('opens one appointment with contact details and the decrypted note, audited', async () => {
    const a = await schedule.appointment(DEMO_CLINIC.id, byStaff, 'u_ana');
    expect(a).toMatchObject({ note: 'Bring the knee brace.', cancelReason: 'patient_asked', patient: { firstName: 'James', lastName: 'Whitaker', dob: '1962-09-09', phone: '+13035550163' } });
    expect(await audit('appointment.viewed')).toEqual([{ actor: 'user:u_ana', entity_id: byStaff }]);
  });

  it('shows another clinic nothing, even by id', async () => {
    expect(await schedule.range(OTHER.id, { ...day('2026-09-29'), label: 'x' }, 'u_otto')).toEqual([]);
    expect(await schedule.appointment(OTHER.id, byCall, 'u_otto')).toBeNull();
  });

  it('links a call to what it booked', async () => {
    const call = await new FrontDeskRepository(t.db, cipher).getCall(DEMO_CLINIC.id, callId, 'u_ana');
    expect(call!.appointments).toEqual([expect.objectContaining({ id: byCall, change: 'booked', status: 'booked', providerId: 'prov_okafor' })]);
  });

  it('keeps the note encrypted at rest', async () => {
    const dump = JSON.stringify((await t.db.execute(sql`select note_enc from appointments`)).rows);
    expect(dump).not.toContain('knee brace');
  });
});

describe('the demo schedule', () => {
  it('fills about 60 percent of two weeks, all booked by staff, with a few cancellations, and runs once', async () => {
    const now = zonedInstant('2026-09-29', '10:00', tz);
    const first = await seedDemoSchedule(t.db, cipher, { patientIds: ids, staffUserIds: ['u_ana'], now });
    expect(first.created).toBeGreaterThan(120);
    const stats = (await t.db.execute(sql`select count(*) filter (where status = 'cancelled')::int as cancelled, count(*) filter (where created_by_user_id is null)::int as by_nobody
      from appointments where idempotency_key like 'seed:%'`)).rows[0] as { cancelled: number; by_nobody: number };
    expect(stats.by_nobody).toBe(0);
    expect(stats.cancelled).toBeGreaterThan(2);
    expect((await seedDemoSchedule(t.db, cipher, { patientIds: ids, staffUserIds: ['u_ana'], now })).created).toBe(0);
  });
});
