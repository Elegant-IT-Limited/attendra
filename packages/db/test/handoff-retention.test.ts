// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CallRepository, createPhiCipher, purgeCallRecords, recordHandoff, saveClinic } from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

// Note 47: a handoff's masked excerpt goes with its call's transcript (the retention purge); its codes stay with the
// call row, and the row goes when the call does. Same Row Level Security as the call: no clinic set, no row.
const cipher = createPhiCipher(TEST_DATA_KEY);
const C = 'clinic_handoffs';
let t: Awaited<ReturnType<typeof openTestDatabase>>;
beforeAll(async () => { t = await openTestDatabase(); await saveClinic(t.db, 'org_handoffs', { ...DEMO_CLINIC, id: C, phoneNumbers: ['+13035550111'] }); });
afterAll(() => t.close());

it('clears the excerpt with the transcript, keeps the codes, and is unseen without the clinic set', async () => {
  const callId = await new CallRepository(t.db, cipher).open(C, 'live_handoff_1', '+13035550147');
  await recordHandoff(t.db, cipher, C, callId, { kind: 'callback', reason: 'caller_asked_person', lineId: 'callback_taken', steps: [{ tool: 'create_callback', result: 'ok' }], excerpt: [{ speaker: 'caller', text: 'Call me back.' }] });
  const row = async () => (await t.owner.execute(sql`select kind, reason, excerpt_enc is not null as has_excerpt from handoffs where call_id = ${callId}`)).rows[0];
  expect(await row()).toEqual({ kind: 'callback', reason: 'caller_asked_person', has_excerpt: true });
  // the application role without a clinic sees nothing
  const unseen = await t.db.transaction(async (tx) => { await tx.execute(sql`set local role attendra_app`); return (await tx.execute(sql`select count(*)::int as n from handoffs`)).rows[0]; });
  expect(unseen).toEqual({ n: 0 });
  await purgeCallRecords(t.db, C, new Date(Date.now() + 60_000));
  expect(await row()).toEqual({ kind: 'callback', reason: 'caller_asked_person', has_excerpt: false });
  await t.owner.execute(sql`delete from calls where id = ${callId}`);
  expect(await row()).toBeUndefined();
});
