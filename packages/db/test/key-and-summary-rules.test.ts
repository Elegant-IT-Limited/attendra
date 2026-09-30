import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyRepository, CallRepository, createPhiCipher, saveClinic, seedDemo, withClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

const cipher = createPhiCipher(TEST_DATA_KEY);
const OTHER = { ...DEMO_CLINIC, id: 'clinic_other', name: 'Other Clinic', phoneNumbers: ['+13035550200'] };
let t: Awaited<ReturnType<typeof openTestDatabase>>;
const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => String(e.cause ?? e.message));

beforeAll(async () => {
  t = await openTestDatabase();
  await seedDemo(t.db, cipher);
  await saveClinic(t.db, 'org_other', OTHER);
});
afterAll(() => t.close());

describe('API keys', () => {
  it('can have only their revocation and last use changed by the application', async () => {
    const { id } = await new ApiKeyRepository(t.db).create(DEMO_CLINIC.id, { name: 'k', scopes: ['schedule:read'], expiresAt: new Date(Date.now() + 86_400_000), userId: 'u_olga' });
    const as = (q: ReturnType<typeof sql>) => failure(withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(q)));
    expect(await as(sql`update api_keys set last_used_at = now() where id = ${id}`)).toBe('ok');
    expect(await as(sql`update api_keys set revoked_at = now() where id = ${id}`)).toBe('ok');
    for (const change of [
      sql`update api_keys set scopes = array['requests:write'] where id = ${id}`,
      sql`update api_keys set expires_at = now() + interval '10 years' where id = ${id}`,
      sql`update api_keys set revoked_at = null, key_hash = 'x' where id = ${id}`,
      sql`update api_keys set created_by_user_id = 'u_owen' where id = ${id}`,
    ]) expect(await as(change)).toMatch(/permission denied/);
  });
});

describe('call summaries', () => {
  it('belong to the clinic of their call', async () => {
    const callId = await new CallRepository(t.db, cipher).open(DEMO_CLINIC.id, 'live_summary_fk', '+13035550147');
    // the other clinic's policy lets it write its own rows; only the key stops it naming this clinic's call
    const wrong = await failure(withClinic(t.db, OTHER.id, (tx) => tx.execute(sql`insert into call_summaries (call_id, clinic_id, body_enc, intent, sentiment, needs_review, model)
      values (${callId}, ${OTHER.id}, 'x', 'other', 'calm', false, 'local')`)));
    expect(wrong).toMatch(/call_summaries_call_same_clinic|foreign key/);
  });
});
