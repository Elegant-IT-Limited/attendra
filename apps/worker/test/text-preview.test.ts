// SPDX-License-Identifier: AGPL-3.0-only
import { callUsNumber, ClinicConfig, RIVERBEND_CLINIC, speakSlot, textPreview, Texting, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory, PostgresTaskQueue, saveClinic, schema, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { eq } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/runtime';
import { LocalSummariser } from '../src/summarise';

// Texts polish TX1 (2026-11-17): Settings > Texting showed "Hi {Owner's first name}, {Pet's name}'s request is ready to
// pick up…" while the worker sent "Your request (R-43) is ready to pick up…". The preview now renders through core
// textPreview, which keeps only the parts each text is sent with. Here every text the worker sends is compared with the
// preview of the same facts, given every part Settings offers (an owner's name included): they must be the same words.
const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const CLINIC = ClinicConfig.parse({ ...RIVERBEND_CLINIC, id: 'clinic_tx1', name: 'Harbor Vets', phoneNumbers: ['+15165550100'], texting: Texting.parse({ enabled: true, reminders: { enabled: true, hoursBefore: 24 } }) });
const tz = CLINIC.timezone;
const NOW = zonedInstant('2026-11-16', '10:00', tz);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let bella: string;
const bodies: string[] = [];
const h = () => handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => NOW,
  texts: { send: async (m) => { bodies.push(m.body); return { sid: `SM${String(bodies.length).padStart(32, '0')}` }; } } });

/** Every part Settings > Texting fills in, with this test's real facts: the preview keeps the ones each text is sent with. */
const everything = (facts: Record<string, string>) => ({
  clinic: CLINIC.name, clinicPhone: callUsNumber(CLINIC), name: 'Dana', pet: 'Bella', visit: 'vaccine appointment', provider: 'Dr. Elena Ruiz',
  pharmacy: 'Main Street Pharmacy', ref: 'R-0', when: 'Monday', from: 'Sunday', ...facts,
});

beforeAll(async () => {
  t = await openTestDatabase();
  await saveClinic(t.db, 'org_tx1', CLINIC);
  bella = await new PostgresPatientDirectory(t.db, cipher, 'seed').create(CLINIC.id, { firstName: 'Bella', lastName: 'Carter', dob: '2020-06-01', phone: '+15165550101', guardianName: 'Dana Carter' });
  await withClinic(t.db, CLINIC.id, (tx) => tx.update(schema.patients).set({ smsConsentAt: NOW, smsConsentSource: 'import' }).where(eq(schema.patients.id, bella)));
});
afterAll(() => t.close());

describe('the Settings preview is the text the worker sends (TX1)', () => {
  const refill = async (outcome: 'refill_ready' | 'refill_sent' | 'refill_declined', pet: string | null) => {
    const { id } = await new PostgresTaskQueue(t.db, cipher).create(CLINIC.id, { type: 'refill', callId: null, patientId: null, idempotencyKey: `tx1-${outcome}-${pet}`,
      details: { medication: 'carprofen 75 mg', pharmacy: 'Main Street Pharmacy', callback_number: '+15165550101', ...(pet ? { pet_name: pet } : {}) } });
    await withClinic(t.db, CLINIC.id, (tx) => tx.update(schema.tasks).set({ status: 'done', outcome }).where(eq(schema.tasks.id, id)));
    const [task] = await withClinic(t.db, CLINIC.id, (tx) => tx.select({ number: schema.tasks.number }).from(schema.tasks).where(eq(schema.tasks.id, id)));
    expect(await h().requestReady({ clinicId: CLINIC.id, taskId: id })).toBe('sent');
    return `R-${task!.number}`;
  };

  for (const [outcome, template] of [['refill_ready', 'request_ready'], ['refill_sent', 'refill_sent'], ['refill_declined', 'refill_not_approved']] as const) {
    it(`refills: ${template}, with the pet's name and without, never "Hi <owner>", always the request's number`, async () => {
      const ref = await refill(outcome, 'Bella');
      expect(bodies.at(-1)).toBe(textPreview(template, everything({ ref }), 'en'));
      expect(bodies.at(-1)).toContain(`(${ref})`);
      expect(bodies.at(-1)).not.toContain('Hi Dana');
      // a request with no pet named: "Your request…", as the preview says when it has no pet
      const bare = await refill(outcome, null);
      const noPet: Record<string, string> = everything({ ref: bare });
      delete noPet.pet;
      expect(bodies.at(-1)).toBe(textPreview(template, noPet, 'en'));
    });
  }

  it('visits: a reminder', async () => {
    const start = zonedInstant('2026-11-17', '09:00', tz);
    const [a] = await withClinic(t.db, CLINIC.id, (tx) => tx.insert(schema.appointments).values({ clinicId: CLINIC.id, patientId: bella, providerId: 'prov_ruiz', visitTypeId: 'vt_vaccines',
      startsAt: start, endsAt: new Date(start.getTime() + 15 * 60_000), idempotencyKey: 'tx1-reminder', createdByUserId: 'u_desk' }).returning({ id: schema.appointments.id }));
    expect(await h().appointmentReminders()).toEqual({ sent: 1 });
    expect(bodies.at(-1)).toBe(textPreview('reminder', everything({ when: speakSlot(start, tz, 'en') }), 'en'));
    // the visit handed to another vet, at the same time
    await withClinic(t.db, CLINIC.id, (tx) => tx.update(schema.appointments).set({ providerId: 'prov_bell' }).where(eq(schema.appointments.id, a!.id)));
    expect(await h().visitHandedOver({ clinicId: CLINIC.id, appointmentId: a!.id, providerId: 'prov_bell' })).toBe('sent');
    expect(bodies.at(-1)).toBe(textPreview('vet_changed', everything({ when: speakSlot(start, tz, 'en'), provider: 'Dr. Marcus Bell' }), 'en'));
  });
});
