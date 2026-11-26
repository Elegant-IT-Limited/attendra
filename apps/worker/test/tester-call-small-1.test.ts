// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC, Texting, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory, saveClinic, schema, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { eq } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/runtime';
import { LocalSummariser } from '../src/summarise';

// SMALL-1, a tester's call (2026-11-24): the reminder said "with Maya Chen", no "Dr.", for a vet whose title is kept apart
// from the name (db:vet-titles). Made-up clinic and people.
const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const tz = 'America/New_York';
const at = (time: string) => zonedInstant('2026-11-16', time, tz);
const CLINIC = {
  ...DEMO_CLINIC, id: 'clinic_small1', name: 'Harbor Vets', industry: 'vet' as const, timezone: tz, phoneNumbers: ['+15165550100'],
  providers: DEMO_CLINIC.providers.map((p, i) => (i === 0 ? { ...p, name: 'Wren Abara', title: 'dr' as const } : p)),
  texting: Texting.parse({ reminders: { enabled: true, hoursBefore: 2 } }),
};
let t: Awaited<ReturnType<typeof openTestDatabase>>;
beforeAll(async () => { t = await openTestDatabase(); await saveClinic(t.db, 'org_small1', CLINIC); });
afterAll(() => t.close());

describe('SMALL-1: a vet is "Dr." in a reminder', () => {
  it('SMALL-1: the reminder names the vet with the title kept apart from the name', async () => {
    const id = await new PostgresPatientDirectory(t.db, cipher, 'seed').create(CLINIC.id, { firstName: 'Olive', lastName: 'Carter', dob: '2020-03-01', phone: '+15165550101', guardianName: 'Dana Carter' });
    await withClinic(t.db, CLINIC.id, (tx) => tx.update(schema.patients).set({ smsConsentAt: at('09:00'), smsConsentSource: 'import' }).where(eq(schema.patients.id, id)));
    const startsAt = at('16:30');
    await withClinic(t.db, CLINIC.id, (tx) => tx.insert(schema.appointments).values({
      clinicId: CLINIC.id, patientId: id, providerId: CLINIC.providers[0]!.id, visitTypeId: 'vt_sick', startsAt, endsAt: new Date(startsAt.getTime() + 20 * 60_000),
      idempotencyKey: 'small1-1', createdByUserId: 'u_desk', createdAt: at('09:00'), updatedAt: at('09:00'),
    }));
    const bodies: string[] = [];
    const texts = { send: async (m: { body: string }) => { bodies.push(m.body); return { sid: `SM${String(bodies.length).padStart(32, '0')}` }; } };
    const h = handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, texts, now: () => at('14:30') } as never);
    await h.appointmentReminders();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('with Dr. Wren Abara');
  });
});
