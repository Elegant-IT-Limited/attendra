import { DEMO_CLINIC, renderText, Texting, zonedInstant } from '@attendra/core';
import { createPhiCipher, PostgresPatientDirectory, saveClinic, schema, seedDemo, withClinic } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/runtime';
import { LocalSummariser } from '../src/summarise';

const cipher = createPhiCipher(TEST_DATA_KEY);
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const tz = DEMO_CLINIC.timezone;
// a vet clinic with texting on, and one with no number of its own (a test clinic): it texts nobody
const VETS = { ...DEMO_CLINIC, id: 'clinic_handover', name: 'Handover Vets', industry: 'vet' as const, phoneNumbers: ['+13035550125'], texting: Texting.parse({ enabled: true }) };
const NOW = zonedInstant('2026-10-06', '10:00', tz);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let patientId: string;
const bodies: { to: string; body: string }[] = [];
const h = () => handlers({ boss: { send: async () => null }, db: t.db, cipher, summariser: new LocalSummariser(), log, now: () => NOW,
  texts: { send: async (m) => { bodies.push({ to: m.to, body: m.body }); return { sid: `SM${'h'.repeat(31)}${bodies.length}` }; } } });
const visit = async (start: Date, providerId = 'prov_lindqvist') => (await withClinic(t.db, VETS.id, (tx) => tx.insert(schema.appointments).values({
  clinicId: VETS.id, patientId, providerId, visitTypeId: 'vt_sick', startsAt: start, endsAt: new Date(start.getTime() + 20 * 60_000),
  idempotencyKey: `handover-${start.toISOString()}-${providerId}`, createdByUserId: 'u_ana',
}).returning({ id: schema.appointments.id })))[0]!.id;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_handover', VETS);
  patientId = await new PostgresPatientDirectory(t.db, cipher, 'seed').create(VETS.id, { firstName: 'Biscuit', lastName: 'Okoye', dob: '2019-05-01', phone: '+13035550182', guardianName: 'Sam Okoye' });
});
afterAll(() => t.close());

describe('the text after a visit is handed to another vet', () => {
  it('goes only to an owner who agreed to texts, once, naming the vet it is now with and the same time, never why', async () => {
    const id = await visit(zonedInstant('2026-10-08', '10:00', tz));
    const job = { clinicId: VETS.id, appointmentId: id, providerId: 'prov_lindqvist' };
    expect(await h().visitHandedOver(job)).toBe('skipped'); // no yes to texts yet
    await withClinic(t.db, VETS.id, (tx) => tx.update(schema.patients).set({ smsConsentAt: new Date(), smsConsentSource: 'staff' }).where(eq(schema.patients.id, patientId)));
    expect(await h().visitHandedOver(job)).toBe('sent');
    expect(await h().visitHandedOver(job)).toBe('sent'); // the same job again is not a second text
    expect(bodies).toEqual([{ to: '+13035550182', body: expect.stringMatching(/^Handover Vets: Hi Sam, Biscuit's sick visit on Thursday, October 8, at 10:00 AM is now with Dr\. Ann Lindqvist, at the same time\. To change or cancel, call \(303\) 555-0125\. Reply STOP to opt out\.$/) }]);
  });

  it('has its Spanish twin, with the same facts', () => {
    const es = renderText('vet_changed', { clinic: 'Handover Vets', name: 'Sam', pet: 'Biscuit', when: 'el jueves 8 de octubre a las 10:00 de la mañana', provider: 'la Dra. Ann Lindqvist', clinicPhone: '+13035550125' }, 'es');
    expect(es).toBe('Handover Vets: Hola Sam, la cita de Biscuit del jueves 8 de octubre a las 10:00 de la mañana ahora es con la Dra. Ann Lindqvist, a la misma hora. Para cambiarla o cancelarla, llame al (303) 555-0125. Responda STOP para no recibir más mensajes.');
  });

  it('a visit moved again since, cancelled or past is left alone', async () => {
    bodies.length = 0;
    const moved = await visit(zonedInstant('2026-10-09', '10:00', tz), 'prov_okafor');
    expect(await h().visitHandedOver({ clinicId: VETS.id, appointmentId: moved, providerId: 'prov_lindqvist' })).toBe('skipped');
    const gone = await visit(zonedInstant('2026-10-09', '11:00', tz));
    await t.owner.execute(sql`update appointments set status = 'cancelled' where id = ${gone}`);
    expect(await h().visitHandedOver({ clinicId: VETS.id, appointmentId: gone, providerId: 'prov_lindqvist' })).toBe('skipped');
    const past = await visit(zonedInstant('2026-10-05', '11:00', tz));
    expect(await h().visitHandedOver({ clinicId: VETS.id, appointmentId: past, providerId: 'prov_lindqvist' })).toBe('skipped');
    expect(bodies).toEqual([]);
  });

  it('with the clinic\'s texting off, or no number of its own, nobody is texted and the reason is kept', async () => {
    bodies.length = 0;
    await saveClinic(t.db, 'org_handover', { ...VETS, texting: Texting.parse({ enabled: false }) });
    const id = await visit(zonedInstant('2026-10-12', '10:00', tz));
    expect(await h().visitHandedOver({ clinicId: VETS.id, appointmentId: id, providerId: 'prov_lindqvist' })).toBe('off');
    const [row] = (await t.owner.execute(sql`select status, failure_reason from sms_messages where appointment_id = ${id}`)).rows;
    expect(row).toEqual({ status: 'not_sent', failure_reason: 'texting_off' });
    expect(bodies).toEqual([]);
  });
});
