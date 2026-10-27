import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPhiCipher, FrontDeskRepository, PostgresTaskQueue, saveClinic, schema, seedDemo, staffPeople, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550120'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let byAna: string;
let byOtto: string;

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
  for (const [id, name, org] of [['u_ana', 'Ana Front', 'org_demo'], ['u_otto', 'Otto Other', 'org_other']] as const) {
    await t.db.execute(sql`insert into auth_users (id, name, email, email_verified) values (${id}, ${name}, ${`${id}@example.test`}, true)`);
    await t.db.execute(sql`insert into memberships (id, organization_id, user_id, role) values (${`m_${id}`}, ${org}, ${id}, 'staff')`);
  }
  // a request written down by hand at each clinic, under the application role as the API does it
  ({ id: byAna } = await new PostgresTaskQueue(t.db, cipher, 'user:u_ana').create(DEMO_CLINIC.id, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'manual:ana', details: { reason: 'wants a call back' } }));
  ({ id: byOtto } = await new PostgresTaskQueue(t.db, cipher, 'user:u_otto').create(OTHER.id, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'manual:otto', details: { reason: 'other clinic' } }));
});
afterAll(() => t.close());

describe('who added a request by hand (migration 0040), under the application role', () => {
  it('is written and read back as attendra_app, and named through staffPeople', async () => {
    const rows = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select({ id: schema.tasks.id, createdByUserId: schema.tasks.createdByUserId }).from(schema.tasks));
    expect(rows).toEqual([{ id: byAna, createdByUserId: 'u_ana' }]);
    const people = await staffPeople(t.db, DEMO_CLINIC.id, rows.map((r) => r.createdByUserId!));
    expect(people.get('u_ana')).toMatchObject({ name: 'Ana Front', role: 'staff', avatarAt: null });
    // the front desk's own listing carries it too
    const listed = await new FrontDeskRepository(t.db, cipher).listTasks(DEMO_CLINIC.id, { status: 'open', limit: 10 }, 'u_ana');
    expect(listed.map((x) => [x.id, x.createdByUserId])).toEqual([[byAna, 'u_ana']]);
  });

  it('another clinic\'s requests and people stay out of sight', async () => {
    const other = await withClinic(t.db, OTHER.id, (tx) => tx.select({ id: schema.tasks.id, createdByUserId: schema.tasks.createdByUserId }).from(schema.tasks));
    expect(other).toEqual([{ id: byOtto, createdByUserId: 'u_otto' }]);
    expect(await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select({ id: schema.tasks.id }).from(schema.tasks).where(sql`${schema.tasks.id} = ${byOtto}`))).toEqual([]);
    // a person at another clinic is not named here, even by their id
    expect((await staffPeople(t.db, DEMO_CLINIC.id, ['u_ana', 'u_otto'])).has('u_otto')).toBe(false);
  });

  it('the assistant\'s own requests carry nobody', async () => {
    const { id } = await new PostgresTaskQueue(t.db, cipher).create(DEMO_CLINIC.id, { type: 'callback', callId: null, patientId: null, idempotencyKey: 'agent:1', details: { reason: 'from a call' } });
    const [row] = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select({ createdByUserId: schema.tasks.createdByUserId }).from(schema.tasks).where(sql`${schema.tasks.id} = ${id}`));
    expect(row).toEqual({ createdByUserId: null });
  });
});
