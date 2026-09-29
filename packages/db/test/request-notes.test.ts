import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, FrontDeskRepository, PostgresTaskQueue, saveClinic, schema, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let desk: FrontDeskRepository;
let taskId: string;

const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => String(e.cause ?? e.message));

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_notes', null);
  ({ id: taskId } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, { type: 'callback', callId, patientId: null, idempotencyKey: 'notes-1', details: { reason: 'x' } }));
  desk = new FrontDeskRepository(t.db, cipher);
  await desk.addTaskNote(DEMO_CLINIC.id, taskId, 'u_ana', 'Called twice, no answer.');
});
afterAll(() => t.close());

describe('request notes', () => {
  it('another clinic cannot read them, even with no filter in the query', async () => {
    expect(await withClinic(t.db, OTHER.id, (tx) => tx.select().from(schema.taskNotes))).toEqual([]);
    expect(await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.taskNotes))).toHaveLength(1);
  });

  it('another clinic cannot add one to this clinic\'s request', async () => {
    expect(await desk.addTaskNote(OTHER.id, taskId, 'u_otto', 'sneaky')).toBe('not_found');
    expect(await failure(withClinic(t.db, OTHER.id, (tx) => tx.insert(schema.taskNotes).values({ clinicId: DEMO_CLINIC.id, taskId, authorUserId: 'u_otto', bodyEnc: 'x' })))).toMatch(/row-level security/);
  });

  it('stores the body only as ciphertext, and notes cannot be edited or removed', async () => {
    expect(JSON.stringify((await t.db.execute(sql`select * from task_notes`)).rows)).not.toContain('no answer');
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`update task_notes set body_enc = 'x'`)))).toMatch(/permission denied/);
    expect(await failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`delete from task_notes`)))).toMatch(/permission denied/);
  });
});
