import { RIVERBEND_CLINIC } from '@attendra/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresTaskQueue, schema, seedRiverbend, withClinic } from '../src';
import { writeEmergencySettings } from '../src/emergency-settings-migration';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

// Batch 1b: how an animal's emergency on a call ended (migration 0050), the urgent request it leaves, and the emergency
// settings written for clinics saved before them. Made-up demo data only.
const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
const clinic = RIVERBEND_CLINIC.id;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedRiverbend(t.db, cipher);
});
afterAll(() => t.close());

describe('emergency records (migration 0050)', () => {
  it('keeps how the emergency ended on the call, and refuses a result it does not know', async () => {
    const calls = new CallRepository(t.db, cipher);
    const id = await calls.open(clinic, 'rtc_emergency_1', '+17205550172', 'phone', undefined, null, { engine: 'gpt-realtime', voiceFlow: 'tools' });
    await calls.close(clinic, id, { reason: 'caller_hangup', voiceSeconds: 40, outcome: 'emergency', emergency: true, emergencyResult: 'transferred' });
    const [row] = await withClinic(t.db, clinic, (tx) => tx.select({ result: schema.calls.emergencyResult, flag: schema.calls.emergencyFlag }).from(schema.calls).where(sql`id = ${id}`));
    expect(row).toEqual({ result: 'transferred', flag: true });
    await expect(withClinic(t.db, clinic, (tx) => tx.execute(sql`update calls set emergency_result = 'maybe' where id = ${id}`))).rejects.toThrow();
  });

  it('marks the urgent request an emergency leaves as from an emergency', async () => {
    const tasks = new PostgresTaskQueue(t.db, cipher);
    const task = await tasks.create(clinic, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'emergency-test-1', details: { reason: 'Emergency: the transfer did not go through.' }, urgent: true, origin: 'emergency' });
    const [row] = await withClinic(t.db, clinic, (tx) => tx.select({ urgent: schema.tasks.urgent, origin: schema.tasks.origin }).from(schema.tasks).where(eq(schema.tasks.id, task.id)));
    expect(row).toEqual({ urgent: true, origin: 'emergency' });
  });
});

describe('db:emergency-settings (batch 1e: the old fields folded in, then removed)', () => {
  // an older vet clinic's stored configuration: the on-call routing it transferred to, and its hospitals in order
  const HOSPITAL = { name: 'Front Range Pet Emergency', phone: '+17205550188', address: '1200 Larkspur Avenue, Denver' };
  const NIGHT = { name: 'Night Paws Emergency', phone: '+17205550189', address: '9 Night Road, Denver', hours: { open: '18:00', close: '08:00' } };
  const stored = async () => (await t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, clinic)))[0]!.config as Record<string, unknown>;
  const store = (config: Record<string, unknown>) => t.db.update(schema.clinics).set({ config }).where(eq(schema.clinics.id, clinic));
  const old = () => {
    const rest: Record<string, unknown> = { ...RIVERBEND_CLINIC };
    delete rest.emergencies;
    return { ...rest, emergencyTransferEnabled: true, emergencyHospital: HOSPITAL, moreEmergencyHospitals: [NIGHT] };
  };

  it('dry run by default: counts per clinic id, nothing written; --apply folds the old fields into emergencies and removes them, audited', async () => {
    await store(old());
    const before = await stored();
    const dry = await writeEmergencySettings(t.db, { apply: false });
    // the demo clinic transferred emergencies to its on-call line: "handle", its first hospital the backup, the next one after
    expect(dry.find((r) => r.clinic === clinic)).toEqual({ clinic, action: 'would write', setting: 'written', mode: 'handle', hospitals: 2, more: 1, moved: 0, dropped: 0, removed: 2 });
    // no name, no number in what is printed
    expect(JSON.stringify(dry)).not.toMatch(/Front Range|\+1720/);
    expect(await stored()).toEqual(before);

    const applied = await writeEmergencySettings(t.db, { apply: true });
    expect(applied.find((r) => r.clinic === clinic)?.action).toBe('written');
    const after = await stored();
    expect(after.emergencies).toEqual({ mode: 'handle', number: '+17205550179', backupHospital: HOSPITAL, moreHospitals: [NIGHT] });
    expect(after).not.toHaveProperty('emergencyHospital');
    expect(after).not.toHaveProperty('moreEmergencyHospitals');
    const audit = await withClinic(t.db, clinic, (tx) => tx.select({ action: schema.auditLogs.action }).from(schema.auditLogs).where(eq(schema.auditLogs.action, 'clinic.emergencies.updated')));
    expect(audit.length).toBeGreaterThan(0);
    // run again: nothing left to do
    expect((await writeEmergencySettings(t.db, { apply: true })).find((r) => r.clinic === clinic)).toMatchObject({ action: 'unchanged', setting: 'kept', removed: 0 });
  });

  it('an old hospital alone is "refer"; a clinic with a setting keeps it, gets only the old keys removed, and its old extra hospitals as next choices while it has none', async () => {
    const rest = old();
    await store({ ...rest, emergencyTransferEnabled: false });
    await writeEmergencySettings(t.db, { apply: true });
    expect((await stored()).emergencies).toEqual({ mode: 'refer', hospital: HOSPITAL, moreHospitals: [NIGHT] });

    const mine = { mode: 'refer', hospital: { name: 'Mountain Vet ER', phone: '+17205550190', address: '3 Peak Street, Denver' } };
    await store({ ...rest, emergencies: mine });
    const dry = await writeEmergencySettings(t.db, { apply: false });
    expect(dry.find((r) => r.clinic === clinic)).toMatchObject({ action: 'would write', setting: 'kept', mode: 'refer', moved: 2, removed: 2 });
    await writeEmergencySettings(t.db, { apply: true });
    const after = await stored();
    expect(after.emergencies).toEqual({ ...mine, moreHospitals: [HOSPITAL, NIGHT] });
    expect(after).not.toHaveProperty('emergencyHospital');

    // next choices already set: only the old keys go
    await store({ ...rest, emergencies: { ...mine, moreHospitals: [NIGHT] } });
    expect((await writeEmergencySettings(t.db, { apply: true })).find((r) => r.clinic === clinic)).toMatchObject({ action: 'written', setting: 'kept', moved: 0, removed: 2 });
    expect((await stored()).emergencies).toEqual({ ...mine, moreHospitals: [NIGHT] });
  });
});
