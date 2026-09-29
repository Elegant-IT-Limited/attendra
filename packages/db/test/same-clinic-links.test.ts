import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresTaskQueue, saveClinic, seedDemo } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let maria: string;
let otherCall: string;
let taskId: string;

// run as the owner connection on purpose: row-level security does not cover foreign key checks, so this is the database alone
const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message));

beforeAll(async () => {
  t = await openTestDatabase();
  maria = (await seedDemo(t.db, cipher)).patientIds.maria!;
  await saveClinic(t.db, 'org_other', OTHER);
  const calls = new CallRepository(t.db, cipher);
  otherCall = await calls.open(OTHER.id, 'live_links_other', null);
  const demoCall = await calls.open(DEMO_CLINIC.id, 'live_links_demo', null);
  ({ id: taskId } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, { type: 'callback', callId: demoCall, patientId: null, idempotencyKey: 'links-1', details: {} }));
});
afterAll(() => t.close());

describe('links between clinic rows', () => {
  it('a call cannot name another clinic\'s patient', async () => {
    expect(await failure(t.db.execute(sql`update calls set patient_id = ${maria} where id = ${otherCall}`))).toMatch(/calls_patient_same_clinic/);
  });

  it('a note cannot hang off another clinic\'s request', async () => {
    expect(await failure(t.db.execute(sql`insert into task_notes (clinic_id, task_id, author_user_id, body_enc) values (${OTHER.id}, ${taskId}, 'u_otto', 'x')`))).toMatch(/task_notes_task_same_clinic/);
  });

  it('the same links inside one clinic are fine', async () => {
    const [demo] = (await t.db.execute(sql`select id from calls where openai_session_id = 'live_links_demo'`)).rows as { id: string }[];
    expect(await failure(t.db.execute(sql`update calls set patient_id = ${maria} where id = ${demo!.id}`))).toBe('ok');
    expect(await failure(t.db.execute(sql`insert into task_notes (clinic_id, task_id, author_user_id, body_enc) values (${DEMO_CLINIC.id}, ${taskId}, 'u_ana', 'x')`))).toBe('ok');
  });
});
