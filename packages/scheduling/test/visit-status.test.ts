import { DEMO_CLINIC, deskStatusProblem, HOLDS_TIME, zonedInstant } from '@attendra/core';
import { createPhiCipher, saveClinic, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuiltinScheduler, StaffScheduler } from '../src';

const cipher = createPhiCipher(TEST_DATA_KEY);
const tz = DEMO_CLINIC.timezone;
const at = (date: string, time: string) => zonedInstant(date, time, tz);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550120'] };

let t: Awaited<ReturnType<typeof openTestDatabase>>;
let ids: Record<string, string>;
let clock = at('2026-09-28', '20:00');
let staff: StaffScheduler;

const audit = async (action: string) =>
  ((await t.owner.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[]);
const row = async (id: string) =>
  ((await t.owner.execute(sql`select status, status_changed_at, status_changed_by from appointments where id = ${id}`)).rows[0] as { status: string; status_changed_at: string | null; status_changed_by: string | null });

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedDemo(t.db, cipher));
  await saveClinic(t.db, 'org_other', OTHER);
  staff = new StaffScheduler(t.db, cipher, () => clock);
});
afterAll(() => t.close());

describe('the rule for when the desk may mark a visit', () => {
  const visit = { status: 'booked', startsAt: at('2026-09-29', '10:00') };
  it('arrived and completed from the visit\'s own day, a no-show once it has started, back to booked any time', () => {
    expect(deskStatusProblem(visit, 'arrived', at('2026-09-28', '23:00'), tz)).toBe('too_early');
    expect(deskStatusProblem(visit, 'arrived', at('2026-09-29', '07:00'), tz)).toBeNull();
    expect(deskStatusProblem(visit, 'completed', at('2026-09-29', '09:59'), tz)).toBeNull();
    expect(deskStatusProblem(visit, 'no_show', at('2026-09-29', '09:59'), tz)).toBe('not_started');
    expect(deskStatusProblem(visit, 'no_show', at('2026-09-29', '10:00'), tz)).toBeNull();
    expect(deskStatusProblem({ ...visit, status: 'no_show' }, 'booked', at('2026-09-20', '10:00'), tz)).toBeNull();
    expect(deskStatusProblem({ ...visit, status: 'cancelled' }, 'arrived', at('2026-09-29', '10:00'), tz)).toBe('cancelled');
  });

  it('the database guard and the code agree on which states keep the vet\'s time', async () => {
    const [c] = (await t.owner.execute(sql`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'appointments'::regclass and contype = 'x'`)).rows as { d: string }[];
    const listed = [...c!.d.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...HOLDS_TIME].sort());
  });
});

describe('marking visits at the desk', () => {
  it('marks arrived, then completed, each audited with who and kept on the row with when; the same state again changes nothing', async () => {
    clock = at('2026-09-28', '20:00');
    const booked = await staff.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-09-29', '09:00'), idempotencyKey: 'mark-1' }, 'u_ana');
    const id = (booked as { appointmentId: string }).appointmentId;
    expect(await staff.setStatus(DEMO_CLINIC, id, 'arrived', 'u_ana')).toEqual({ status: 'refused', reason: 'too_early' });
    clock = at('2026-09-29', '08:55');
    expect(await staff.setStatus(DEMO_CLINIC, id, 'arrived', 'u_ana')).toEqual({ status: 'done', appointmentId: id, from: 'booked', to: 'arrived' });
    expect(await staff.setStatus(DEMO_CLINIC, id, 'arrived', 'u_ana')).toEqual({ status: 'already_done', appointmentId: id });
    expect(await row(id)).toMatchObject({ status: 'arrived', status_changed_by: 'u_ana' });
    clock = at('2026-09-29', '09:25');
    expect(await staff.setStatus(DEMO_CLINIC, id, 'completed', 'u_ben')).toMatchObject({ status: 'done', from: 'arrived', to: 'completed' });
    expect(await audit('appointment.status.arrived')).toEqual([{ actor: 'user:u_ana', entity_id: id }]);
    expect(await audit('appointment.status.completed')).toEqual([{ actor: 'user:u_ben', entity_id: id }]);
    // the assistant no longer counts it as upcoming, and still counts it as a visit that took place
    const assistant = new BuiltinScheduler(t.db);
    expect(await assistant.upcoming(DEMO_CLINIC.id, ids.james!, at('2026-09-29', '08:00'))).toEqual([]);
    expect((await assistant.history(DEMO_CLINIC.id, ids.james!, at('2026-09-30', '08:00'))).map((h) => h.providerId)).toContain('prov_okafor');
  });

  it('a completed visit keeps the vet\'s time; a no-show frees it, and back to booked is refused once another visit took it', async () => {
    clock = at('2026-09-28', '20:00');
    const first = await staff.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-09-29', '11:00'), idempotencyKey: 'mark-2' }, 'u_ana');
    const id = (first as { appointmentId: string }).appointmentId;
    clock = at('2026-09-29', '10:00');
    await staff.setStatus(DEMO_CLINIC, id, 'arrived', 'u_ana');
    // arrived early: its time is still held, so a walk-in cannot be put there
    const clash = await staff.book(DEMO_CLINIC, { patientId: ids.maria!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-09-29', '11:00'), idempotencyKey: 'mark-3', overrideReason: 'walk-in' }, 'u_ana');
    expect(clash).toEqual({ status: 'refused', reason: 'taken' });
    expect(await staff.setStatus(DEMO_CLINIC, id, 'no_show', 'u_ana')).toEqual({ status: 'refused', reason: 'not_started' });
    clock = at('2026-09-29', '11:10');
    expect(await staff.setStatus(DEMO_CLINIC, id, 'no_show', 'u_ana')).toMatchObject({ status: 'done', to: 'no_show' });
    const assistant = new BuiltinScheduler(t.db);
    expect((await assistant.busy(DEMO_CLINIC.id, ['prov_okafor'], at('2026-09-29', '11:00'), at('2026-09-29', '11:30'))).length).toBe(0);
    // the time is free: a walk-in goes there (straight into the database, as the slot has started), and the no-show cannot come back over it
    await t.owner.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_user_id)
      values (${DEMO_CLINIC.id}, ${ids.maria!}, 'prov_okafor', 'vt_sick', ${at('2026-09-29', '11:00')}, ${at('2026-09-29', '11:20')}, 'walk-in-1', 'u_ana')`);
    expect(await staff.setStatus(DEMO_CLINIC, id, 'booked', 'u_ana')).toEqual({ status: 'refused', reason: 'taken' });
    expect((await row(id)).status).toBe('no_show');
  });

  it('a cancelled visit cannot be marked, and another clinic\'s visit is not found', async () => {
    clock = at('2026-09-28', '20:00');
    const r = await staff.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-09-29', '14:00'), idempotencyKey: 'mark-4' }, 'u_ana');
    const id = (r as { appointmentId: string }).appointmentId;
    await staff.cancel(DEMO_CLINIC, id, { reason: 'patient_asked' }, 'u_ana');
    clock = at('2026-09-29', '15:00');
    expect(await staff.setStatus(DEMO_CLINIC, id, 'completed', 'u_ana')).toEqual({ status: 'refused', reason: 'cancelled' });
    expect(await staff.setStatus(OTHER, id, 'completed', 'u_otto')).toEqual({ status: 'not_found' });
  });
});
