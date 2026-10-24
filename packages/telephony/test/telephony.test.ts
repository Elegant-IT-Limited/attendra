import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, schema, seedDemo, withClinic } from '@attendra/db';
import { eq, sql } from 'drizzle-orm';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerNumber, confirmByReply, dialledCandidates, dialledNumber, maskedHeaders, MAX_TEXTS_PER_NUMBER_PER_DAY, trimEnd, recordSmsStanding, smsKeyword, smsStatusUrl, TEMPLATES, twilioSignatureValid, twiml, TwilioMessenger } from '../src';
import twilio from 'twilio';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
const cipher = createPhiCipher(TEST_DATA_KEY);
let ids: Record<string, string>;
beforeAll(async () => { t = await openTestDatabase(); ({ patientIds: ids } = await seedDemo(t.db, cipher)); });
afterAll(() => t.close());

describe('SIP headers from a Twilio Elastic SIP Trunk', () => {
  const headers = [
    { name: 'From', value: '"MARIA D" <sip:+13035550147@example.pstn.twilio.com>;tag=abc' },
    { name: 'To', value: '<sip:+13035550100@sip.api.openai.com>' },
  ];

  it('reads the dialled clinic number and the caller number', () => {
    expect(dialledNumber(headers)).toBe('+13035550100');
    expect(callerNumber(headers)).toBe('+13035550147');
  });

  it('returns null instead of guessing when the header is missing or odd', () => {
    expect(dialledNumber([{ name: 'To', value: '<sip:frontdesk@example.com>' }])).toBeNull();
  });
});

describe('dialled number candidates', () => {
  it('reads To first, then other headers, never the caller headers, and masks numbers for logs', () => {
    const headers = [
      { name: 'From', value: '<sip:+8801700000000@x>' },
      { name: 'To', value: '"Clinic" <sip:proj_abc@sip.api.openai.com;transport=tls>' },
      { name: 'Diversion', value: '<sip:5163630790@pstn.twilio.com>;reason=unconditional' },
      { name: 'X-Called', value: '+15163630790' },
      { name: 'Call-ID', value: '03782086-4ce9-44bf-8b0d-4e303d2cc590' },
    ];
    expect(dialledCandidates(headers)).toEqual(['+15163630790']);
    expect(dialledCandidates([{ name: 'To', value: '<sip:+13035550100@x>' }, { name: 'X-Other', value: '+19995550000' }])).toEqual(['+13035550100', '+19995550000']);
    expect(maskedHeaders(headers).join('|')).not.toContain('5163630790');
    expect(maskedHeaders(headers).join('|')).toContain('5163***0790');
  });
});

describe('SMS confirmations', () => {
  it('sends a template once per key, and the text carries no clinical detail', async () => {
    const sent: { to: string; body: string }[] = [];
    const messenger = new TwilioMessenger(t.db, cipher, { send: async (m) => { sent.push(m); return { sid: 'SM1' }; } }, () => '+13035550100');
    const input = { to: '+13035550147', template: 'booking_confirmed' as const, idempotencyKey: 'sms:1',
      vars: { clinic: DEMO_CLINIC.name, when: 'Tue Sep 29, 9:00 AM', clinicPhone: '(303) 555-0100' } };
    await messenger.sendTemplate(DEMO_CLINIC.id, input);
    await messenger.sendTemplate(DEMO_CLINIC.id, input);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Maple Street Family Medicine: Your visit is booked for Tue Sep 29, 9:00 AM. To change or cancel, call (303) 555-0100. Reply STOP to opt out.");
  });

  it('retries a send that failed, with the same key', async () => {
    let attempts = 0;
    const flaky = { send: async () => { if (++attempts === 1) throw new Error('twilio 503'); return { sid: 'SM2' }; } };
    const messenger = new TwilioMessenger(t.db, cipher, flaky, () => '+13035550100');
    const input = { to: '+13035550163', template: 'booking_confirmed' as const, idempotencyKey: 'sms:2', vars: { clinic: 'C', when: 'W', clinicPhone: 'P' } };
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, input)).toMatchObject({ status: 'not_sent', reason: 'carrier' });
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, input)).toMatchObject({ status: 'sent' });
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, input)).toMatchObject({ status: 'already' });
    expect(attempts).toBe(2);
  });

  const row = (key: string) => withClinic(t.db, DEMO_CLINIC.id, async (tx) => (await tx.select().from(schema.smsMessages).where(eq(schema.smsMessages.idempotencyKey, key)))[0]!);
  const vars = { clinic: 'C', when: 'W', clinicPhone: 'P' };

  it('sends to the number in E.164, asks Twilio to report delivery, and records what the text was about', async () => {
    const sent: { to: string; statusCallback?: string }[] = [];
    const messenger = new TwilioMessenger(t.db, cipher, { send: async (m) => { sent.push(m); return { sid: `SM${'1'.repeat(32)}` }; } }, () => '+13035550100',
      { statusCallback: (id) => smsStatusUrl('https://voice.example.com/', id) });
    const callId = '00000000-0000-4000-8000-0000000000c1';
    const result = await messenger.sendTemplate(DEMO_CLINIC.id, { to: '(303) 555-0171', template: 'booking_confirmed', idempotencyKey: 'sms:e164', vars, language: 'es', kind: 'auto', about: { callId } });
    expect(result.status).toBe('sent');
    expect(sent).toEqual([expect.objectContaining({ to: '+13035550171', statusCallback: `https://voice.example.com/webhooks/twilio/sms-status?clinic=${DEMO_CLINIC.id}` })]);
    expect(await row('sms:e164')).toMatchObject({ status: 'sent', callId, language: 'es', kind: 'auto', failureReason: null, sentAt: expect.any(Date) });
  });

  it('keeps a refusal with its reason, and never reaches Twilio for it', async () => {
    let calls = 0;
    const sender = { send: async () => { calls++; return { sid: `SM${'2'.repeat(32)}` }; } };
    const messenger = new TwilioMessenger(t.db, cipher, sender, () => '+13035550100');
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '12', template: 'request_ready', idempotencyKey: 'sms:short', vars })).toMatchObject({ status: 'not_sent', reason: 'no_number' });
    await recordSmsStanding(t.db, cipher, DEMO_CLINIC.id, '+13035550172', 'opted_out', 'keyword');
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+13035550172', template: 'request_ready', idempotencyKey: 'sms:stop', vars })).toMatchObject({ status: 'not_sent', reason: 'opted_out' });
    expect(await row('sms:stop')).toMatchObject({ status: 'not_sent', failureReason: 'opted_out' });
    const off = new TwilioMessenger(t.db, cipher, null, () => '+13035550100');
    expect(await off.sendTemplate(DEMO_CLINIC.id, { to: '+13035550173', template: 'request_ready', idempotencyKey: 'sms:off', vars })).toMatchObject({ status: 'not_sent', reason: 'texting_off' });
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+13035550173', template: 'request_ready', idempotencyKey: 'sms:test-call', vars, testCall: true })).toMatchObject({ status: 'not_sent', reason: 'test_call' });
    expect(await row('sms:test-call')).toMatchObject({ status: 'not_sent', failureReason: 'test_call' });
    expect(calls).toBe(0);
    // START again: texts go
    await recordSmsStanding(t.db, cipher, DEMO_CLINIC.id, '+13035550172', 'opted_in', 'keyword');
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+13035550172', template: 'request_ready', idempotencyKey: 'sms:stop', vars })).toMatchObject({ status: 'sent' });
  });

  it('sends one number at most 8 texts a day, and stops at the clinic\'s daily limit', async () => {
    const messenger = new TwilioMessenger(t.db, cipher, { send: async () => ({ sid: `SM${'3'.repeat(32)}` }) }, () => '+13035550100');
    const results = [];
    for (let i = 0; i < 9; i++) results.push((await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+13035550174', template: 'request_ready', idempotencyKey: `sms:many:${i}`, vars })).status);
    expect(results.filter((r) => r === 'sent')).toHaveLength(MAX_TEXTS_PER_NUMBER_PER_DAY);
    expect(await row('sms:many:8')).toMatchObject({ status: 'not_sent', failureReason: 'rate_limited' });
    const capped = new TwilioMessenger(t.db, cipher, { send: async () => ({ sid: `SM${'4'.repeat(32)}` }) }, () => '+13035550100', { dailyCap: 1 });
    expect(await capped.sendTemplate(DEMO_CLINIC.id, { to: '+13035550175', template: 'request_ready', idempotencyKey: 'sms:cap', vars })).toMatchObject({ status: 'not_sent', reason: 'rate_limited' });
  });

  it('never texts a number abroad, premium, toll-free or in the Caribbean, stops at the monthly limit, and says so in Slack', async () => {
    let calls = 0;
    const alerts: string[] = [];
    const sender = { send: async () => { calls++; return { sid: `SM${'5'.repeat(32)}` }; } };
    const messenger = new TwilioMessenger(t.db, cipher, sender, () => '+13035550100', { alerts: { alert: (kind) => alerts.push(kind) } });
    for (const [i, to] of ['+447700900123', '+18765550100', '+19005550100', '+18885550100'].entries()) {
      expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to, template: 'request_ready', idempotencyKey: `sms:abroad:${i}`, vars })).toMatchObject({ status: 'not_sent', reason: 'not_textable' });
    }
    expect(calls).toBe(0);
    expect(alerts).toEqual(['text_blocked', 'text_blocked', 'text_blocked', 'text_blocked']);
    // Canada is fine
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+14165550100', template: 'request_ready', idempotencyKey: 'sms:canada', vars })).toMatchObject({ status: 'sent' });
    // this month's texts so far reach a limit set at them: the next one waits for the 1st
    const [{ n }] = (await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.execute(sql`select count(*)::int as n from sms_messages where clinic_id = ${DEMO_CLINIC.id} and status <> 'not_sent'`))).rows as [{ n: number }];
    const full = new TwilioMessenger(t.db, cipher, sender, () => '+13035550100', { monthlyCap: n, alerts: { alert: (kind) => alerts.push(kind) } });
    expect(await full.sendTemplate(DEMO_CLINIC.id, { to: '+13035550177', template: 'request_ready', idempotencyKey: 'sms:month', vars })).toMatchObject({ status: 'not_sent', reason: 'monthly_limit' });
    expect(alerts.at(-1)).toBe('text_limit');
    expect(calls).toBe(1);
  });

  it('marks a number the carrier says opted out (21610), and does not try it again', async () => {
    let calls = 0;
    const refusing = { send: async () => { calls++; throw Object.assign(new Error('opted out'), { code: 21610 }); } };
    const messenger = new TwilioMessenger(t.db, cipher, refusing, () => '+13035550100');
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+13035550176', template: 'request_ready', idempotencyKey: 'sms:21610', vars })).toMatchObject({ status: 'not_sent', reason: 'opted_out' });
    expect(await row('sms:21610')).toMatchObject({ errorCode: '21610', failureReason: 'opted_out' });
    expect(await messenger.sendTemplate(DEMO_CLINIC.id, { to: '+13035550176', template: 'request_ready', idempotencyKey: 'sms:21610:b', vars })).toMatchObject({ reason: 'opted_out' });
    expect(calls).toBe(1);
  });

  it('the confirmations render from the same three variables, nothing clinical', () => {
    for (const name of ['booking_confirmed', 'request_ready', 'change_confirmed', 'cancel_confirmed'] as const) {
      expect(TEMPLATES[name]({ clinic: 'C', when: 'W', clinicPhone: 'P' })).not.toMatch(/undefined/);
    }
  });
});

describe('Twilio requests and replies', () => {
  it('checks the signature over the full URL and the form fields', () => {
    const url = 'https://voice.example.com/webhooks/twilio/sms-inbound';
    const params = { From: '+13035550147', To: '+13035550100', Body: 'STOP' };
    const good = twilio.getExpectedTwilioSignature('token', url, params);
    expect(twilioSignatureValid(url, params, 'token', good)).toBe(true);
    expect(twilioSignatureValid(url, { ...params, Body: 'START' }, 'token', good)).toBe(false);
    expect(twilioSignatureValid(url, params, 'other', good)).toBe(false);
    expect(twilioSignatureValid(url, params, 'token', undefined)).toBe(false);
  });

  it('reads STOP, START and confirm keywords as the whole message, any case, English or Spanish', () => {
    for (const w of ['STOP', 'stop', ' Unsubscribe ', 'cancel', 'ALTO', 'parar.']) expect(smsKeyword(w)).toBe('stop');
    for (const w of ['START', 'unstop', 'Iniciar', 'yes']) expect(smsKeyword(w)).toBe('start');
    for (const w of ['C', 'confirm', 'Sí']) expect(smsKeyword(w)).toBe('confirm');
    for (const w of ['please stop calling me', 'stopped', 'hello']) expect(smsKeyword(w)).toBe('other');
  });

  it('reads a long run of punctuation from anyone in linear time', () => {
    const started = performance.now();
    expect(smsKeyword(`${'!'.repeat(100_000)}x`)).toBe('other');
    expect(smsKeyword(`STOP${'.'.repeat(100_000)}`)).toBe('stop');
    expect(performance.now() - started).toBeLessThan(500);
    expect(trimEnd('https://voice.example.com///', '/')).toBe('https://voice.example.com');
    expect(trimEnd('', '/')).toBe('');
  });

  it('escapes the reply it sends', () => {
    expect(twiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(twiml('a <b> & c')).toContain('<Message>a &lt;b&gt; &amp; c</Message>');
  });
});

describe('a reply of C to a reminder', () => {
  it('confirms the next visit that had a reminder, once, for whoever has the number on file', async () => {
    const now = new Date('2026-09-28T16:00:00Z');
    const visit = async (hours: number, reminded: boolean) => (await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.insert(schema.appointments).values({
      clinicId: DEMO_CLINIC.id, patientId: ids.maria!, providerId: 'prov_okafor', visitTypeId: 'vt_sick',
      startsAt: new Date(now.getTime() + hours * 3_600_000), endsAt: new Date(now.getTime() + hours * 3_600_000 + 1_200_000),
      idempotencyKey: `reply-c-${hours}`, createdByUserId: 'u_ana', reminderSentAt: reminded ? now : null,
    }).returning({ id: schema.appointments.id })))[0]!.id;
    await visit(20, false);
    const reminded = await visit(26, true);
    expect(await confirmByReply(t.db, cipher, DEMO_CLINIC.id, '+1 (303) 555-0147', now)).toMatchObject({ id: reminded, patientId: ids.maria });
    const [row] = await withClinic(t.db, DEMO_CLINIC.id, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.id, reminded)));
    expect(row).toMatchObject({ confirmedVia: 'text', confirmedAt: now });
    expect(await confirmByReply(t.db, cipher, DEMO_CLINIC.id, '+13035550147', now)).toBeNull(); // nothing left to confirm
    expect(await confirmByReply(t.db, cipher, DEMO_CLINIC.id, '+13035550999', now)).toBeNull(); // nobody with that number
  });
});
