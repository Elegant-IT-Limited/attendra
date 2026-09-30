import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, PostgresPatientDirectory, PostgresTaskQueue, saveClinic, seedDemo } from '../src';
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

  it('a request, an appointment, a transcript line, a call action and a webhook attempt cannot cross clinics either', async () => {
    const [demoCall] = (await t.db.execute(sql`select id from calls where openai_session_id = 'live_links_demo'`)).rows as { id: string }[];
    expect(await failure(t.db.execute(sql`insert into tasks (clinic_id, type, patient_id, details_enc, idempotency_key) values (${OTHER.id}, 'callback', ${maria}, 'x', 'links-x1')`))).toMatch(/tasks_patient_same_clinic/);
    expect(await failure(t.db.execute(sql`insert into tasks (clinic_id, type, call_id, details_enc, idempotency_key) values (${OTHER.id}, 'callback', ${demoCall!.id}, 'x', 'links-x2')`))).toMatch(/tasks_call_same_clinic/);
    const otherPatient = await new PostgresPatientDirectory(t.db, cipher).create(OTHER.id, { firstName: 'Ruth', lastName: 'Marsh', dob: '1971-06-02' });
    const appt = (patientId: string, bookedBy: string | null, cancelledBy: string | null, key: string) => t.db.execute(sql`
      insert into appointments (clinic_id, patient_id, provider_id, visit_type_id, starts_at, ends_at, idempotency_key, created_by_call_id, created_by_user_id, cancelled_by_call_id)
      values (${OTHER.id}, ${patientId}, 'prov_okafor', 'vt_sick', '2026-11-02T15:00:00Z', '2026-11-02T15:20:00Z', ${key}, ${bookedBy}, ${bookedBy ? null : 'u_otto'}, ${cancelledBy})`);
    expect(await failure(appt(maria, null, null, 'links-a1'))).toMatch(/appointments_patient_same_clinic/);
    expect(await failure(appt(otherPatient, demoCall!.id, null, 'links-a2'))).toMatch(/appointments_booked_by_call_same_clinic/);
    expect(await failure(appt(otherPatient, null, demoCall!.id, 'links-a3'))).toMatch(/appointments_cancelled_by_call_same_clinic/);
    expect(await failure(t.db.execute(sql`insert into call_segments (clinic_id, call_id, speaker, text_enc, start_ms, end_ms) values (${OTHER.id}, ${demoCall!.id}, 'caller', 'x', 0, 1)`))).toMatch(/call_segments_call_same_clinic/);
    expect(await failure(t.db.execute(sql`insert into call_actions (clinic_id, call_id, tool, args_redacted, result, task_revision) values (${OTHER.id}, ${demoCall!.id}, 't', '[]', '{}', 1)`))).toMatch(/call_actions_call_same_clinic/);
    // a webhook attempt logged under another clinic's endpoint, for this clinic's event
    await t.db.execute(sql`insert into webhook_events (id, clinic_id, type, data, occurred_at) values ('evt_links_demo', ${DEMO_CLINIC.id}, 'request.done', '{}', now())`);
    const [endpoint] = (await t.db.execute(sql`insert into webhook_endpoints (clinic_id, url, events, secret_enc, created_by_user_id)
      values (${OTHER.id}, 'https://hooks.example.com/other', '{request.done}', 'x', 'u_otto') returning id`)).rows as { id: string }[];
    expect(await failure(t.db.execute(sql`insert into webhook_attempts (clinic_id, endpoint_id, event_id, kind, attempt, duration_ms)
      values (${OTHER.id}, ${endpoint!.id}, 'evt_links_demo', 'automatic', 1, 5)`))).toMatch(/webhook_attempts_event_same_clinic/);
  });

  it('the same links inside one clinic are fine', async () => {
    const [demo] = (await t.db.execute(sql`select id from calls where openai_session_id = 'live_links_demo'`)).rows as { id: string }[];
    expect(await failure(t.db.execute(sql`update calls set patient_id = ${maria} where id = ${demo!.id}`))).toBe('ok');
    expect(await failure(t.db.execute(sql`insert into task_notes (clinic_id, task_id, author_user_id, body_enc) values (${DEMO_CLINIC.id}, ${taskId}, 'u_ana', 'x')`))).toBe('ok');
  });
});
