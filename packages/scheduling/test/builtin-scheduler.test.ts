import { DEMO_CLINIC, findSlots, zonedInstant } from '@attendra/core';
import { CallRepository, createPhiCipher, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuiltinScheduler } from '../src';

const cipher = createPhiCipher(TEST_DATA_KEY);
const tz = DEMO_CLINIC.timezone;
const sick = DEMO_CLINIC.visitTypes.find((v) => v.id === 'vt_sick')!;
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let ids: Record<string, string>;
let callId: string;
let scheduler: BuiltinScheduler;

const slotAt = (time: string, minutes = 20) => {
  const start = zonedInstant('2026-09-29', time, tz);
  return { id: `prov_okafor@${start.toISOString()}`, providerId: 'prov_okafor', visitTypeId: 'vt_sick', start, end: new Date(start.getTime() + minutes * 60_000) };
};

beforeAll(async () => {
  t = await openTestDatabase();
  ({ patientIds: ids } = await seedDemo(t.db, cipher));
  callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_sched', null);
  scheduler = new BuiltinScheduler(t.db);
});
afterAll(() => t.close());

describe('the built-in scheduler', () => {
  it('books a slot, and a retry with the same key returns the same appointment', async () => {
    const input = { patientId: ids.maria!, slot: slotAt('09:00'), callId, idempotencyKey: 'k-book-1' };
    const first = await scheduler.book(DEMO_CLINIC.id, input);
    const again = await scheduler.book(DEMO_CLINIC.id, input);
    if (first.status !== 'booked' || again.status !== 'already_done') throw new Error(`unexpected ${first.status} / ${again.status}`);
    expect(again.appointment.id).toBe(first.appointment.id);
  });

  it('never double books: an overlapping slot for the same provider is refused by the database', async () => {
    const clash = await scheduler.book(DEMO_CLINIC.id, { patientId: ids.james!, slot: slotAt('09:10'), callId, idempotencyKey: 'k-book-2' });
    expect(clash).toEqual({ status: 'slot_taken' });
  });

  it('booked time disappears from the slots offered next', async () => {
    const busy = await scheduler.busy(DEMO_CLINIC.id, ['prov_okafor'], zonedInstant('2026-09-29', '00:00', tz), zonedInstant('2026-09-30', '00:00', tz));
    const slots = findSlots(DEMO_CLINIC, busy, {
      visitType: sick, providers: DEMO_CLINIC.providers.filter((p) => p.id === 'prov_okafor'), from: '2026-09-29', days: 1,
      now: zonedInstant('2026-09-28', '20:00', tz), limit: 8,
    });
    expect(slots.map((s) => s.start.toISOString())).not.toContain(slotAt('09:00').start.toISOString());
  });

  it('a caller can only cancel their own appointment, and a repeated cancel is harmless', async () => {
    const [mine] = await scheduler.upcoming(DEMO_CLINIC.id, ids.maria!, zonedInstant('2026-09-28', '20:00', tz));
    expect(await scheduler.cancel(DEMO_CLINIC.id, { patientId: ids.james!, appointmentId: mine!.id, callId, idempotencyKey: 'k-cancel-x' })).toEqual({ status: 'not_found' });
    expect(await scheduler.cancel(DEMO_CLINIC.id, { patientId: ids.maria!, appointmentId: mine!.id, callId, idempotencyKey: 'k-cancel-1' })).toEqual({ status: 'cancelled' });
    expect(await scheduler.cancel(DEMO_CLINIC.id, { patientId: ids.maria!, appointmentId: mine!.id, callId, idempotencyKey: 'k-cancel-1' })).toEqual({ status: 'already_done' });
    expect(await scheduler.upcoming(DEMO_CLINIC.id, ids.maria!, zonedInstant('2026-09-28', '20:00', tz))).toEqual([]);
  });
});
