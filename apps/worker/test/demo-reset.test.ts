import { RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresTaskQueue, RIVERBEND_PETS, seedDemoClinic, setDemoBaseline, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/runtime';
import { LocalSummariser } from '../src/summarise';

// The demo clinics' nightly reset (2026-11-16): each demo clinic past 03:30 on its own clock and not reset since goes
// back to its baseline, Slack hears it with counts only, and a clinic that is not a demo clinic is never touched.
const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const DEMO = { ...RIVERBEND_CLINIC, id: 'clinic_nightly_demo', name: 'Nightly Demo Vet', phoneNumbers: ['+17205550193'] };
const OTHER = { ...RIVERBEND_CLINIC, id: 'clinic_nightly_other', name: 'Nightly Other Vet', phoneNumbers: ['+17205550194'] };
const tz = DEMO.timezone;
let t: Awaited<ReturnType<typeof openTestDatabase>>;
const notes: string[] = [];
const run = (now: Date) => handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => now,
  alerts: { alert: () => {}, resolved: () => {}, note: (text) => { notes.push(text); }, flush: async () => {} } }).demoReset();
const tasksOf = async (clinicId: string) => Number(((await withClinic(t.db, clinicId, (tx) => tx.execute(sql`select count(*)::int as n from tasks where clinic_id = ${clinicId}`))).rows as [{ n: number }])[0].n);
const addRequest = (clinicId: string, key: string) => new PostgresTaskQueue(t.db, cipher, 'voice-agent').create(clinicId, { type: 'callback', callId: null, patientId: null, idempotencyKey: key, details: { reason: 'A caller asked for a callback.' } });

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemoClinic(t.db, cipher, DEMO, 'org_nightly_demo', RIVERBEND_PETS);
  await seedDemoClinic(t.db, cipher, OTHER, 'org_nightly_other', RIVERBEND_PETS);
  await t.owner.execute(sql`update clinics set config = jsonb_set(config, '{demoClinic}', '{"enabled": true, "baselineAt": null}'::jsonb) where id = ${DEMO.id}`);
});
afterAll(() => t.close());

describe('the nightly demo reset', () => {
  it('skips a demo clinic with no baseline yet, and never lists another clinic', async () => {
    expect(await run(zonedInstant('2026-11-16', '04:00', tz))).toEqual([{ clinicId: DEMO.id, result: 'no_baseline' }]);
  });

  it('resets after 03:30 on the clinic\'s clock, once a night; Slack hears counts only; the other clinic keeps its rows', async () => {
    await setDemoBaseline(t.db, cipher, DEMO.id, 'backoffice:owner@example.com', zonedInstant('2026-11-16', '12:00', tz));
    await addRequest(DEMO.id, 'demo:1');
    await addRequest(OTHER.id, 'other:1');
    // the same evening: not due (the baseline is newer than last night's 03:30)
    expect(await run(zonedInstant('2026-11-16', '22:00', tz))).toEqual([{ clinicId: DEMO.id, result: 'not_due' }]);
    // 03:20 next morning: still not due
    expect(await run(zonedInstant('2026-11-17', '03:20', tz))).toEqual([{ clinicId: DEMO.id, result: 'not_due' }]);
    expect(await tasksOf(DEMO.id)).toBe(1);
    // 03:33: reset
    expect(await run(zonedInstant('2026-11-17', '03:33', tz))).toEqual([{ clinicId: DEMO.id, result: 'reset' }]);
    expect(await tasksOf(DEMO.id)).toBe(0);
    expect(await tasksOf(OTHER.id)).toBe(1);
    expect(notes).toEqual([`Demo clinic reset (nightly), clinic ${DEMO.id}: removed (added since the baseline): pets 0, visits 0, requests 1, notes 0; put back (changed): pets 0, visits 0, requests 0, notes 0; put back (removed): pets 0, visits 0, requests 0, notes 0; calls unlinked from removed pets: 0.`]);
    // and not again that night
    expect(await run(zonedInstant('2026-11-17', '03:43', tz))).toEqual([{ clinicId: DEMO.id, result: 'not_due' }]);
  });
});
