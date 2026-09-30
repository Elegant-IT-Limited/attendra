import { DEMO_CLINIC, isOpen, localDateOf, qualityOf, speakSlot, zonedInstant } from '@attendra/core';
import { createPhiCipher, FrontDeskRepository, qualityRows, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { LocalEmbedder, seedDemoKnowledge } from '@attendra/knowledge';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_CALL_DIR, recordDemoCalls } from '../src/demo';
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

  it('puts this week\'s ordinary calls in opening hours once the week has enough of them', async () => {
    const fresh = await openTestDatabase();
    try {
      const { patientIds } = await seedDemo(fresh.db, cipher);
      await seedDemoKnowledge(fresh.db, new LocalEmbedder());
      const wednesday = new Date('2026-09-30T21:00:00Z'); // 3 pm in Denver
      await recordDemoCalls(fresh.db, cipher, patientIds, wednesday);
      const rows = (await fresh.db.execute(sql`select started_at from calls where openai_session_id like 'demo_demo-%'`)).rows as { started_at: string }[];
      expect(rows).toHaveLength(loadScenarios(DEMO_CALL_DIR).length);
      expect(rows.every((r) => isOpen(DEMO_CLINIC, new Date(r.started_at)))).toBe(true);
    } finally { await fresh.close(); }
  }, 60_000);

    it('keeps transcripts encrypted at rest', async () => {
    const dump = JSON.stringify((await t.db.execute(sql`select text_enc from call_segments`)).rows);
    expect(dump).not.toContain('Maria');
  });

  it('says only dates on or after the day of each call, and books the very time it read back', async () => {
    const desk = new FrontDeskRepository(t.db, cipher);
    const tz = DEMO_CLINIC.timezone;
    const EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const problems: string[] = [];
    for (const r of results) {
      const call = (await desk.getCall(DEMO_CLINIC.id, r.callId, 'test'))!;
      const day = localDateOf(new Date(call.startedAt), tz);
      const said = call.transcript.filter((x) => x.speaker === 'agent').map((x) => x.text).join(' ');
      // "Tuesday, September 29" and "martes, 29 de septiembre": a weekday, then the date
      const dates = [
        ...[...said.matchAll(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday), (\w+) (\d{1,2})\b/gi)].map((m) => [EN.indexOf(m[1]!.toLowerCase()), Number(m[2])] as const),
        ...[...said.matchAll(/\b(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo), (\d{1,2}) de (\w+)/gi)].map((m) => [ES.indexOf(m[2]!.toLowerCase()), Number(m[1])] as const),
      ].filter(([month]) => month >= 0);
      for (const [month, d] of dates) {
        const year = Number(day.slice(0, 4)) + (month + 1 < Number(day.slice(5, 7)) - 6 ? 1 : 0);
        const spoken = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (spoken < day) problems.push(`${r.id}: said ${spoken} on a call of ${day}`);
      }
      for (const a of call.appointments.filter((x) => x.change === 'booked')) {
        const start = new Date(a.startsAt);
        if (!said.includes(speakSlot(start, tz, 'en')) && !said.includes(speakSlot(start, tz, 'es'))) problems.push(`${r.id}: booked ${start.toISOString()}, never read back`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('leaves no patient with two open requests of the same kind, and keeps them all', async () => {
    const open = (await t.db.execute(sql`select type, patient_id from tasks where clinic_id = ${DEMO_CLINIC.id} and status = 'open' and patient_id is not null`)).rows as { type: string; patient_id: string }[];
    const kinds = open.map((r) => `${r.patient_id}|${r.type}`);
    expect(new Set(kinds).size).toBe(kinds.length);
    // every call that made a request still made it
    expect((await t.db.execute(sql`select count(*)::int as n from tasks where clinic_id = ${DEMO_CLINIC.id}`)).rows[0]).toEqual({ n: 6 });
  });

  it('refuses to run on a database that already has real calls', async () => {
    await t.db.execute(sql`insert into calls (clinic_id, openai_session_id) values (${DEMO_CLINIC.id}, 'live_real_call')`);
    await expect(recordDemoCalls(t.db, cipher, {})).rejects.toThrow(/real calls/);
  });
});
