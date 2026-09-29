import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import { CallRepository, createPhiCipher, saveClinic, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuiltinScheduler, openSlots, slotProblem, StaffScheduler } from '../src';

const cipher = createPhiCipher(TEST_DATA_KEY);
const tz = DEMO_CLINIC.timezone;
// Monday 28 September 2026, 8 pm in Denver. Tuesday the 29th is a working day for both providers.
const NOW = zonedInstant('2026-09-28', '20:00', tz);
const at = (date: string, time: string) => zonedInstant(date, time, tz);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };

let t: Awaited<ReturnType<typeof openTestDatabase>>;
let ids: Record<string, string>;
let staff: StaffScheduler;

const audit = async (action: string) =>
  ((await t.db.execute(sql`select actor, entity_id from audit_logs where action = ${action} order by id`)).rows as { actor: string; entity_id: string }[]);
const book = (time: string, key: string, extra: Partial<Parameters<StaffScheduler['book']>[1]> = {}) =>
  staff.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-09-29', time), idempotencyKey: key, ...extra }, 'u_ana');

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedDemo(t.db, cipher));
  await saveClinic(t.db, 'org_other', OTHER);
  staff = new StaffScheduler(t.db, cipher, () => NOW);
});
afterAll(() => t.close());

describe('the booking rules, shared with the assistant', () => {
  const rule = (req: { providerId?: string; visitTypeId?: string; start: Date }, busy: { providerId: string; start: Date; end: Date }[] = []) =>
    slotProblem(DEMO_CLINIC, busy, { providerId: 'prov_okafor', visitTypeId: 'vt_sick', ...req }, NOW);

  it('accepts a time the assistant would offer', () => {
    expect(rule({ start: at('2026-09-29', '09:00') })).toBeNull();
  });

  it('refuses a double booking', () => {
    const busy = [{ providerId: 'prov_okafor', start: at('2026-09-29', '08:50'), end: at('2026-09-29', '09:10') }];
    expect(rule({ start: at('2026-09-29', '09:00') }, busy)).toBe('taken');
    expect(rule({ start: at('2026-09-29', '09:00'), providerId: 'prov_lindqvist' }, busy)).toBeNull(); // someone else's calendar
  });

  it('refuses a time outside opening hours, on the lunch break or off the visit\'s grid', () => {
    expect(rule({ start: at('2026-09-29', '07:40') })).toBe('closed');
    expect(rule({ start: at('2026-09-29', '12:20') })).toBe('closed');
    expect(rule({ start: at('2026-09-29', '09:05') })).toBe('closed');
    expect(rule({ start: at('2026-10-03', '10:00') })).toBe('closed'); // a Saturday
    expect(rule({ start: at('2026-09-30', '10:00'), providerId: 'prov_lindqvist' })).toBe('closed'); // she works Tuesdays and Thursdays
  });

  it('refuses a holiday', () => {
    expect(rule({ start: at('2026-11-26', '09:00') })).toBe('holiday');
  });

  it('refuses a time that has passed', () => {
    expect(rule({ start: at('2026-09-28', '15:00') })).toBe('past');
  });

  it('refuses a provider who does not do the visit type, and names that are not in the config', () => {
    expect(rule({ start: at('2026-09-29', '09:00'), providerId: 'prov_lindqvist', visitTypeId: 'vt_new' })).toBe('not_offered');
    expect(rule({ start: at('2026-09-29', '09:00'), providerId: 'prov_nobody' })).toBe('unknown_provider');
    expect(rule({ start: at('2026-09-29', '09:00'), visitTypeId: 'vt_nothing' })).toBe('unknown_visit_type');
  });

  it('offers the front desk every open slot with no lead time, and nothing the rules refuse', () => {
    const morning = at('2026-09-29', '08:05');
    const slots = openSlots(DEMO_CLINIC, [], { visitTypeId: 'vt_sick', providerId: 'prov_okafor', from: '2026-09-29', days: 1, now: morning });
    expect(slots[0]!.start).toEqual(at('2026-09-29', '08:20'));
    for (const s of slots) expect(slotProblem(DEMO_CLINIC, [], { providerId: s.providerId, visitTypeId: s.visitTypeId, start: s.start }, morning)).toBeNull();
  });
});

describe('staff bookings', () => {
  it('books, encrypts the note, and audits under the staff member', async () => {
    const result = await book('09:00', 'desk-1', { note: 'Needs the ground-floor room.' });
    expect(result).toMatchObject({ status: 'done' });
    const [row] = (await t.db.execute(sql`select created_by_user_id, created_by_call_id, note_enc from appointments where idempotency_key = 'staff:u_ana:desk-1'`)).rows as { created_by_user_id: string; created_by_call_id: null; note_enc: string }[];
    expect(row).toMatchObject({ created_by_user_id: 'u_ana', created_by_call_id: null });
    expect(row!.note_enc).not.toContain('ground-floor');
    expect(await audit('appointment.booked.staff')).toEqual([{ actor: 'user:u_ana', entity_id: result.status === 'done' ? result.appointmentId : '' }]);
  });

  it('a retry with the same key is the same booking, with no second audit row', async () => {
    const again = await book('09:00', 'desk-1');
    expect(again.status).toBe('already_done');
    expect(await audit('appointment.booked.staff')).toHaveLength(1);
  });

  it('refuses a double booking, whether the time came from staff or from the assistant', async () => {
    expect(await book('09:00', 'desk-2')).toEqual({ status: 'refused', reason: 'taken' });
    const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_staff_race', null);
    const start = at('2026-09-29', '10:00');
    await new BuiltinScheduler(t.db).book(DEMO_CLINIC.id, { patientId: ids.maria!, callId, idempotencyKey: 'agent-1', slot: { id: 's', providerId: 'prov_okafor', visitTypeId: 'vt_sick', start, end: new Date(start.getTime() + 20 * 60_000) } });
    expect(await book('10:00', 'desk-3')).toEqual({ status: 'refused', reason: 'taken' });
  });

  it('refuses the rules\' cases with their reasons, and writes nothing', async () => {
    expect(await book('07:40', 'desk-4')).toEqual({ status: 'refused', reason: 'closed' });
    expect(await staff.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-11-26', '09:00'), idempotencyKey: 'desk-5' }, 'u_ana'))
      .toEqual({ status: 'refused', reason: 'holiday' });
    expect(await staff.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-09-28', '10:00'), idempotencyKey: 'desk-6' }, 'u_ana'))
      .toEqual({ status: 'refused', reason: 'past' });
    expect(await book('09:00', 'desk-7', { providerId: 'prov_lindqvist', visitTypeId: 'vt_new' })).toEqual({ status: 'refused', reason: 'not_offered' });
    const [{ n }] = (await t.db.execute(sql`select count(*)::int as n from appointments where idempotency_key like 'staff:u_ana:desk-%'`)).rows as [{ n: number }];
    expect(n).toBe(1);
  });

  it('will not book another clinic\'s patient', async () => {
    const otherPatient = (await t.db.execute(sql`insert into patients (clinic_id, lookup_hash, first_name_enc, last_name_enc, dob_enc) values (${OTHER.id}, 'x', 'x', 'x', 'x') returning id`)).rows[0] as { id: string };
    expect(await book('11:00', 'desk-8', { patientId: otherPatient.id })).toEqual({ status: 'not_found' });
  });
});

describe('moving and cancelling', () => {
  let id: string;
  beforeAll(async () => {
    const r = await book('14:00', 'desk-move', { patientId: ids.maria! });
    if (r.status !== 'done') throw new Error(r.status);
    id = r.appointmentId;
  });

  it('refuses to move into a taken slot, and leaves the booking where it was', async () => {
    expect(await staff.reschedule(DEMO_CLINIC, id, { start: at('2026-09-29', '09:00') }, 'u_ana')).toEqual({ status: 'refused', reason: 'taken' });
    const [row] = (await t.db.execute(sql`select starts_at from appointments where id = ${id}`)).rows as { starts_at: string }[];
    expect(new Date(row!.starts_at)).toEqual(at('2026-09-29', '14:00'));
  });

  it('moves to a free time, keeping its own slot free for itself, and a repeat changes nothing', async () => {
    expect(await staff.reschedule(DEMO_CLINIC, id, { start: at('2026-09-29', '14:20') }, 'u_ana')).toEqual({ status: 'done', appointmentId: id }); // overlaps its old time
    expect(await staff.reschedule(DEMO_CLINIC, id, { start: at('2026-09-29', '14:20') }, 'u_ana')).toEqual({ status: 'already_done', appointmentId: id });
    expect(await audit('appointment.rescheduled.staff')).toHaveLength(1);
  });

  it('moves to another provider only when they do the visit type and work then', async () => {
    expect(await staff.reschedule(DEMO_CLINIC, id, { start: at('2026-09-29', '09:00'), providerId: 'prov_lindqvist' }, 'u_ana')).toEqual({ status: 'done', appointmentId: id });
    expect(await staff.reschedule(DEMO_CLINIC, id, { start: at('2026-09-29', '08:00'), providerId: 'prov_lindqvist' }, 'u_ana')).toEqual({ status: 'refused', reason: 'closed' });
  });

  it('cancels with a reason, once; a second cancel changes nothing and a cancelled booking cannot move', async () => {
    expect(await staff.cancel(DEMO_CLINIC, id, { reason: 'patient_asked' }, 'u_ben')).toEqual({ status: 'done', appointmentId: id });
    expect(await staff.cancel(DEMO_CLINIC, id, { reason: 'other' }, 'u_ben')).toEqual({ status: 'already_done', appointmentId: id });
    const [row] = (await t.db.execute(sql`select status, cancelled_by_user_id, cancel_reason from appointments where id = ${id}`)).rows;
    expect(row).toEqual({ status: 'cancelled', cancelled_by_user_id: 'u_ben', cancel_reason: 'patient_asked' });
    expect(await audit('appointment.cancelled.staff')).toEqual([{ actor: 'user:u_ben', entity_id: id }]);
    expect(await staff.reschedule(DEMO_CLINIC, id, { start: at('2026-09-29', '15:00') }, 'u_ana')).toEqual({ status: 'refused', reason: 'cancelled' });
  });

  it('frees the slot for the next booking once cancelled', async () => {
    expect((await book('09:00', 'desk-after', { providerId: 'prov_lindqvist', patientId: ids.sam_b! })).status).toBe('done');
  });

  it('answers not_found for another clinic\'s appointment', async () => {
    expect(await staff.cancel(OTHER, id, {}, 'u_ana')).toEqual({ status: 'not_found' });
    expect(await staff.reschedule(OTHER, id, { start: at('2026-09-29', '15:00') }, 'u_ana')).toEqual({ status: 'not_found' });
  });
});

describe('the database', () => {
  it('refuses an appointment that came from neither a call nor a person', async () => {
    await expect(t.db.execute(sql`insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key)
      values (${DEMO_CLINIC.id}, ${ids.maria!}, 'prov_okafor', 'vt_sick', '2026-10-01T16:00:00Z', '2026-10-01T16:20:00Z', 'no-source')`)).rejects.toThrow();
  });
});

describe('races and mistakes', () => {
  it('a move loses cleanly to a cancel that landed after the move read the row', async () => {
    const r = await book('15:00', 'race-move');
    if (r.status !== 'done') throw new Error(r.status);
    // someone else cancels between this move's read and its write, as a second request would
    const racing = new StaffScheduler(t.db, cipher, () => NOW) as unknown as { busy: (...a: unknown[]) => Promise<unknown>; reschedule: StaffScheduler['reschedule'] };
    const busy = racing.busy.bind(racing);
    racing.busy = async (tx: unknown, ...rest: unknown[]) => {
      await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(sql`update appointments set status = 'cancelled' where id = ${r.appointmentId}`);
      return busy(tx, ...rest);
    };
    expect(await racing.reschedule(DEMO_CLINIC, r.appointmentId, { start: at('2026-09-29', '16:00') }, 'u_ana')).toEqual({ status: 'refused', reason: 'just_cancelled' });
    const [row] = (await t.db.execute(sql`select status, starts_at from appointments where id = ${r.appointmentId}`)).rows as { status: string; starts_at: string }[];
    expect(row!.status).toBe('cancelled');
    expect(new Date(row!.starts_at)).toEqual(at('2026-09-29', '15:00')); // not moved back to life at a new time
  });

  it('a staff cancel carries a cancel key, and cancelling twice still changes it once', async () => {
    const r = await book('15:20', 'cancel-key');
    if (r.status !== 'done') throw new Error(r.status);
    const [a, b] = await Promise.all([staff.cancel(DEMO_CLINIC, r.appointmentId, {}, 'u_ana'), staff.cancel(DEMO_CLINIC, r.appointmentId, {}, 'u_ben')]);
    expect([a.status, b.status].sort()).toEqual(['already_done', 'done']);
    const [row] = (await t.db.execute(sql`select cancel_key from appointments where id = ${r.appointmentId}`)).rows as { cancel_key: string }[];
    expect(row!.cancel_key).toMatch(new RegExp(`^staff:u_(ana|ben):${r.appointmentId}$`));
    expect((await audit('appointment.cancelled.staff')).filter((x) => x.entity_id === r.appointmentId)).toHaveLength(1);
  });

  it('a key sent again for a different booking is refused, not taken as a retry', async () => {
    expect((await book('15:40', 'key-reuse')).status).toBe('done');
    expect(await book('15:40', 'key-reuse')).toMatchObject({ status: 'already_done' });
    expect(await book('16:00', 'key-reuse')).toEqual({ status: 'refused', reason: 'idempotency_mismatch' });
    expect(await book('15:40', 'key-reuse', { patientId: ids.maria! })).toEqual({ status: 'refused', reason: 'idempotency_mismatch' });
    expect(await book('15:40', 'key-reuse', { providerId: 'prov_lindqvist' })).toEqual({ status: 'refused', reason: 'idempotency_mismatch' });
  });

  it('will not book a patient into two places at once, whatever the provider', async () => {
    const sam = { patientId: ids.sam_a! };
    expect((await book('10:40', 'sam-1', sam)).status).toBe('done');
    // Dr. Lindqvist is free at 10:40, but Sam is not
    expect(await book('10:40', 'sam-2', { ...sam, providerId: 'prov_lindqvist' })).toEqual({ status: 'refused', reason: 'patient_busy', patientName: 'Sam Rivera' });
    expect(await book('10:40', 'sam-3', { ...sam, providerId: 'prov_lindqvist', visitTypeId: 'vt_annual', start: at('2026-09-29', '10:20') })).toMatchObject({ reason: 'patient_busy' });
    // and a move into the same clash is refused too
    const other = await book('11:00', 'sam-4', { ...sam, providerId: 'prov_lindqvist' });
    if (other.status !== 'done') throw new Error(other.status);
    expect(await staff.reschedule(DEMO_CLINIC, other.appointmentId, { start: at('2026-09-29', '10:40') }, 'u_ana')).toMatchObject({ reason: 'patient_busy', patientName: 'Sam Rivera' });
  });
});

describe('the daylight saving change on 2026-11-01', () => {
  it('books Monday 2 November at 8:00 local time, which is 15:00 UTC once clocks go back', async () => {
    const s = new StaffScheduler(t.db, cipher, () => zonedInstant('2026-10-30', '12:00', tz));
    const r = await s.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-11-02', '08:00'), idempotencyKey: 'dst-1' }, 'u_ana');
    expect(r.status).toBe('done');
    expect(at('2026-11-02', '08:00').toISOString()).toBe('2026-11-02T15:00:00.000Z');
    expect(at('2026-10-30', '08:00').toISOString()).toBe('2026-10-30T14:00:00.000Z');
    // Sunday the 1st, the changeover day itself, is closed
    expect(await s.book(DEMO_CLINIC, { patientId: ids.james!, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start: at('2026-11-01', '10:00'), idempotencyKey: 'dst-2' }, 'u_ana'))
      .toEqual({ status: 'refused', reason: 'closed' });
  });
});
