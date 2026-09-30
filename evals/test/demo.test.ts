import { DEMO_CLINIC, isOpen, qualityOf, zonedInstant } from '@attendra/core';
import { createPhiCipher, FrontDeskRepository, qualityRows, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CALL_DIR, recordDemoCalls, shiftByWeeks } from '../src/demo';
import { loadScenarios } from '../src/scenario';

const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let results: Awaited<ReturnType<typeof recordDemoCalls>>;
const NOW = new Date('2026-09-28T18:00:00Z');

beforeAll(async () => {
  t = await openTestDatabase();
  const { patientIds } = await seedDemo(t.db, cipher);
  await seedDemoKnowledge(t.db, new LocalEmbedder());
  results = await recordDemoCalls(t.db, cipher, patientIds, NOW);
}, 60_000);
afterAll(() => t.close());

describe('demo calls', () => {
  it('every scenario still passes when they all share one database', () => {
    expect(results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.failures.join('; ')}`)).toEqual([]);
  });

  it('writes one call per scenario and per ordinary demo call, all in the past, over about two weeks', async () => {
    const calls = await new FrontDeskRepository(t.db, cipher).listCalls(DEMO_CLINIC.id, { limit: 100 });
    expect(calls).toHaveLength(loadScenarios().filter((s) => s.clinic === 'maple').length + loadScenarios(DEMO_CALL_DIR).length);
    expect(calls[0]!.startedAt.getTime()).toBeLessThan(NOW.getTime());
    expect(NOW.getTime() - calls.at(-1)!.startedAt.getTime()).toBeLessThan(15 * 24 * 3_600_000);
  });

  it('gives the current week a working clinic\'s numbers, from calls that really went through the assistant', async () => {
    const weekStart = zonedInstant('2026-09-28', '00:00', DEMO_CLINIC.timezone); // NOW is Monday midday in Denver
    const q = async (from: Date, to: Date) => qualityOf((await qualityRows(t.db, DEMO_CLINIC.id, from, to)).map((r) => ({ ...r, afterHours: !isOpen(DEMO_CLINIC, r.startedAt) })), 0.05);
    const week = await q(weekStart, NOW);
    expect(week.containmentRate).toBeGreaterThanOrEqual(0.7);
    expect(week.containmentRate).toBeLessThanOrEqual(0.85);
    expect(week.bookingAttempts).toBeGreaterThanOrEqual(4);
    expect(week.bookingSuccess).toBeGreaterThanOrEqual(0.75);
    expect(week.refusals.length).toBeGreaterThanOrEqual(3); // a few, of different kinds
    // the weeks before hold the hard cases, so the trend goes up
    const before = await q(new Date(weekStart.getTime() - 14 * 86_400_000), weekStart);
    expect(before.containmentRate!).toBeLessThan(week.containmentRate!);
  });

  it('records a readable transcript with the greeting, the caller and the agent', async () => {
    const booking = results.find((r) => r.id === 'booking-happy-path')!;
    const call = await new FrontDeskRepository(t.db, cipher).getCall(DEMO_CLINIC.id, booking.callId, 'test');
    expect(call!.transcript[0]).toMatchObject({ speaker: 'agent', text: DEMO_CLINIC.greeting });
    expect(call!.transcript.map((s) => s.text).join(' ')).toMatch(/Maria Delgado.*You're all set for \w+day, \w+ \d+ at/);
    expect(call!.actions.map((a) => a.tool)).toEqual(['verify_caller', 'find_slots', 'propose_booking', 'commit_pending']);
    const hedge = await new FrontDeskRepository(t.db, cipher).getCall(DEMO_CLINIC.id, results.find((r) => r.id === 'hedge-is-not-yes')!.callId, 'test');
    expect(hedge!.transcript.map((s) => s.text).join(' ')).toContain('for an annual physical');
  });

  it('links each call to the patient the agent verified, and leaves the rest unlinked', async () => {
    const patientOf = async (id: string) => ((await t.db.execute(sql`select patient_id from calls where id = ${results.find((r) => r.id === id)!.callId}`)).rows[0] as { patient_id: string | null }).patient_id;
    const { patientIds } = await seedDemo(t.db, cipher);
    expect(await patientOf('booking-happy-path')).toBe(patientIds.maria);
    expect(await patientOf('no-identity-no-records')).toBeNull();
    expect(await patientOf('shared-name-and-dob')).toBeNull(); // two records match: nobody is verified
  });

  it('puts back no more than two upcoming visits per patient, however many calls booked for them', async () => {
    const most = (await t.db.execute(sql`select count(*)::int as n from appointments where clinic_id = ${DEMO_CLINIC.id} and status = 'booked'
      and starts_at > ${NOW.toISOString()}::timestamptz group by patient_id order by n desc limit 1`)).rows[0] as { n: number } | undefined;
    expect(most?.n ?? 0).toBeLessThanOrEqual(2);
  });

  it('keeps transcripts encrypted at rest', async () => {
    const dump = JSON.stringify((await t.db.execute(sql`select text_enc from call_segments`)).rows);
    expect(dump).not.toContain('Maria');
  });

  it('moves a booking by whole weeks of local time, keeping 8:00 at 8:00 across the 2026-11-01 clock change', () => {
    const tz = DEMO_CLINIC.timezone;
    const tuesday = zonedInstant('2026-10-27', '08:00', tz); // daylight time, 14:00 UTC
    expect(tuesday.toISOString()).toBe('2026-10-27T14:00:00.000Z');
    const moved = shiftByWeeks(tuesday, 1, tz);
    expect(moved.toISOString()).toBe('2026-11-03T15:00:00.000Z'); // standard time: an hour later in UTC
    expect(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(moved)).toBe('Tuesday 8:00 AM');
    expect(shiftByWeeks(tuesday, 0, tz)).toEqual(tuesday);
  });

  it('refuses to run on a database that already has real calls', async () => {
    await t.db.execute(sql`insert into calls (clinic_id, openai_session_id) values (${DEMO_CLINIC.id}, 'live_real_call')`);
    await expect(recordDemoCalls(t.db, cipher, {})).rejects.toThrow(/real calls/);
  });
});
