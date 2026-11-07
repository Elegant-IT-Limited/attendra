import { RIVERBEND_CLINIC } from '@attendra/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresTaskQueue, schema, seedRiverbend, withClinic } from '../src';
import { writeEmergencySettings } from '../src/repositories/provisioning';
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

describe('db:emergency-settings', () => {
  it('writes what an older clinic\'s fields meant, only with --apply, and keeps a setting already chosen', async () => {
    const before = await t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, clinic));
    const dry = await writeEmergencySettings(t.db, { apply: false });
    // the demo clinic transfers emergencies to its on-call line: "handle"
    expect(dry.find((r) => r.clinic === clinic)).toEqual({ clinic, mode: 'handle', action: 'would write' });
    expect(await t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, clinic))).toEqual(before);
    const applied = await writeEmergencySettings(t.db, { apply: true });
    expect(applied.find((r) => r.clinic === clinic)).toEqual({ clinic, mode: 'handle', action: 'written' });
    const [after] = await t.db.select({ config: schema.clinics.config }).from(schema.clinics).where(eq(schema.clinics.id, clinic));
    expect((after!.config as { emergencies?: unknown }).emergencies).toMatchObject({ mode: 'handle', number: '+17205550179' });
    expect((await writeEmergencySettings(t.db, { apply: true })).find((r) => r.clinic === clinic)?.action).toBe('kept');
  });
});
