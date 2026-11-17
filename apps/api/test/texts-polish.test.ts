import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, DEMO_PATIENTS, phiContext, smsNumberHash } from '@attendra/db';
import { TEST_DATA_KEY } from '@attendra/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

// Texts polish (2026-11-17): the Texts page's search, filters, paging and counts (TX3), a text not sent marked handled
// with who and when (TX2), Today's count of every such text however many (TX2), the pet each text is about (TX4) and
// since when the words are kept (TX5). Made-up data.
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
const cipher = createPhiCipher(TEST_DATA_KEY);
const [maria, james] = DEMO_PATIENTS;
let api: Awaited<ReturnType<typeof startApi>>;
let staff: string;
let viewer: string;
const refills: { id: string; number: number }[] = [];
type Text = { id: string; template: string; status: string; taskNumber: number | null; patientName: string | null; patientFirstName: string | null; toLast4: string | null; handledAt: string | null; handledBy: string | null };
type Page = { texts: Text[]; next: string | null; wordsKeptSince: string | null };

const insert = async (o: { template: string; status: string; to?: string; minutesAgo: number; taskId?: string | null; patientId?: string | null; body?: string }) =>
  (await api.t.owner.execute(sql`insert into sms_messages (clinic_id, template, to_hash, status, idempotency_key, task_id, patient_id, body_enc, created_at, failure_reason)
    values (${DEMO_CLINIC.id}, ${o.template}, ${smsNumberHash(cipher, DEMO_CLINIC.id, o.to ?? maria.phone)}, ${o.status}, ${`k-${Math.random()}`}, ${o.taskId ?? null}, ${o.patientId ?? null},
      ${o.body ? cipher.encrypt(o.body, phiContext(DEMO_CLINIC.id, 'sms_messages.body')) : null}, now() - make_interval(mins => ${o.minutesAgo}), ${o.status === 'not_sent' ? 'texting_off' : null}) returning id`)).rows[0] as { id: string };
const search = async (body: Record<string, unknown>, cookie = staff) => {
  const res = await api.request('POST', `${C}/texts/search`, { cookie, body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Page;
};
const problems = async () => (await api.request('GET', `${C}/tasks/text-problems`, { cookie: staff })).json() as { total: number; problems: { textId: string }[] };

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  staff = await api.signIn('ana@maple.example', true);
  viewer = await api.signIn('vic@maple.example', true);
  // 25 refills whose ready text was not sent: more than Today's list of 20
  for (let i = 0; i < 25; i++) {
    const r = (await api.request('POST', `${C}/tasks`, { cookie: staff, body: { type: 'refill', medication: 'Carprofen 75 mg', callbackNumber: maria.phone } })).json() as { id: string; number: number };
    refills.push(r);
    await insert({ template: 'request_ready', status: 'not_sent', minutesAgo: 60 + i, taskId: r.id });
  }
  for (let i = 0; i < 12; i++) await insert({ template: 'reminder', status: 'delivered', minutesAgo: 10 + i, patientId: api.patientIds.maria, body: `Maple Street Family Medicine: A reminder ${i}.` });
  await insert({ template: 'hours', status: 'sent', to: james.phone, minutesAgo: 5, patientId: api.patientIds.james });
  // a sent text with no words: from before the history kept them
  await insert({ template: 'directions', status: 'delivered', to: '+13035550188', minutesAgo: 3 * 24 * 60 });
});
afterAll(() => api.close());

describe('Today counts every text not sent, and Handled takes one off (TX2)', () => {
  it('counts all 25 though it lists the newest 20', async () => {
    const p = await problems();
    expect(p.total).toBe(25);
    expect(p.problems).toHaveLength(20);
  });

  it('a text marked handled leaves Today, says who and when, is audited, and can be put back', async () => {
    const [first] = (await problems()).problems;
    const done = await api.request('POST', `${C}/texts/${first!.textId}/handled`, { cookie: staff, body: { handled: true } });
    expect(done.statusCode).toBe(200);
    expect((await problems()).total).toBe(24);
    const shown = (await search({ status: 'not_sent', kind: 'refills', limit: 50 })).texts.find((t) => t.id === first!.textId)!;
    expect(shown).toMatchObject({ handledBy: expect.stringMatching(/Ana/), handledAt: expect.any(String) });
    expect((await search({ status: 'needs_handling', kind: 'refills', limit: 50 })).texts.map((t) => t.id)).not.toContain(first!.textId);
    const audit = await api.t.owner.execute(sql`select actor from audit_logs where action = 'sms.handled' and entity_id = ${first!.textId}`);
    expect(audit.rows).toHaveLength(1);
    await api.request('POST', `${C}/texts/${first!.textId}/handled`, { cookie: staff, body: { handled: false } });
    expect((await problems()).total).toBe(25);
  });

  it('a text that went has nothing to handle; a viewer cannot mark one', async () => {
    const [sent] = (await search({ status: 'sent', limit: 1 })).texts;
    expect((await api.request('POST', `${C}/texts/${sent!.id}/handled`, { cookie: staff, body: { handled: true } })).statusCode).toBe(409);
    const [first] = (await problems()).problems;
    expect((await api.request('POST', `${C}/texts/${first!.textId}/handled`, { cookie: viewer, body: { handled: true } })).statusCode).toBe(403);
  });
});

describe('the Texts page (TX3)', () => {
  it('pages 10 at a time, newest first, to the end', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await search({ limit: 10, ...(cursor ? { cursor } : {}) });
      seen.push(...page.texts.map((t) => t.id));
      cursor = page.next;
    } while (cursor);
    expect(seen).toHaveLength(39);
    expect(new Set(seen).size).toBe(39);
  });

  it('finds by request number, the last four digits, and a pet\'s or owner\'s name (the household\'s texts too)', async () => {
    const r = refills[3]!;
    expect((await search({ q: `R-${r.number}` })).texts.map((t) => t.taskNumber)).toEqual([r.number]);
    const byDigits = await search({ q: james.phone.replace(/\D/g, '').slice(-4), limit: 50 });
    expect(byDigits.texts.map((t) => t.template)).toEqual(['hours']);
    const byName = await search({ q: 'maria', limit: 50 });
    expect(byName.texts.length).toBe(12 + 25); // her reminders, and the refill texts to her number
    expect((await search({ q: 'nobody-like-this' })).texts).toEqual([]);
  });

  it('filters by kind, group and status, and says which pet each is about (TX4)', async () => {
    expect((await search({ kind: 'reminder', limit: 50 })).texts).toHaveLength(12);
    expect((await search({ kind: 'visits', limit: 50 })).texts).toHaveLength(12);
    expect((await search({ kind: 'during_call', limit: 50 })).texts.map((t) => t.template).sort()).toEqual(['directions', 'hours']);
    expect((await search({ status: 'not_sent', limit: 50 })).texts).toHaveLength(25);
    const reminder = (await search({ kind: 'reminder', limit: 1 })).texts[0]!;
    expect(reminder).toMatchObject({ patientFirstName: 'Maria', toLast4: maria.phone.replace(/\D/g, '').slice(-4) });
  });

  it('counts today and the last 7 days, sent and not sent', async () => {
    const s = (await api.request('GET', `${C}/texts/summary`, { cookie: staff })).json() as { week: { sent: number; notSent: number }; needsHandling: number };
    expect(s.week).toEqual({ sent: 14, notSent: 25 });
    expect(s.needsHandling).toBe(25);
  });

  it('says since when words are kept (TX5), and a viewer reads none of it', async () => {
    expect((await search({})).wordsKeptSince).toEqual(expect.any(String));
    expect((await api.request('POST', `${C}/texts/search`, { cookie: viewer, body: {} })).statusCode).toBe(403);
  });
});
