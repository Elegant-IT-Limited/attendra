import { DEMO_CLINIC } from '@attendra/core';
import { createPhiCipher, seedDemo } from '@attendra/db';
import { openTestDatabase, TEST_DATA_KEY } from '@attendra/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callerNumber, dialledNumber, TEMPLATES, TwilioMessenger } from '../src';

let t: Awaited<ReturnType<typeof openTestDatabase>>;
const cipher = createPhiCipher(TEST_DATA_KEY);
beforeAll(async () => { t = await openTestDatabase(); await seedDemo(t.db, cipher); });
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

describe('SMS confirmations', () => {
  it('sends a template once per key, and the text carries no clinical detail', async () => {
    const sent: { to: string; body: string }[] = [];
    const messenger = new TwilioMessenger(t.db, cipher, { send: async (m) => { sent.push(m); return { sid: 'SM1' }; } }, () => '+13035550100');
    const input = { to: '+13035550147', template: 'booking_confirmed' as const, idempotencyKey: 'sms:1',
      vars: { clinic: DEMO_CLINIC.name, when: 'Tue Sep 29, 9:00 AM', clinicPhone: '(303) 555-0100' } };
    await messenger.sendTemplate(DEMO_CLINIC.id, input);
    await messenger.sendTemplate(DEMO_CLINIC.id, input);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Maple Street Family Medicine: you're booked for Tue Sep 29, 9:00 AM. To change or cancel, call (303) 555-0100.");
  });

  it('retries a send that failed, with the same key', async () => {
    let attempts = 0;
    const flaky = { send: async () => { if (++attempts === 1) throw new Error('twilio 503'); return { sid: 'SM2' }; } };
    const messenger = new TwilioMessenger(t.db, cipher, flaky, () => '+13035550100');
    const input = { to: '+13035550163', template: 'booking_confirmed' as const, idempotencyKey: 'sms:2', vars: { clinic: 'C', when: 'W', clinicPhone: 'P' } };
    await expect(messenger.sendTemplate(DEMO_CLINIC.id, input)).rejects.toThrow('twilio 503');
    await messenger.sendTemplate(DEMO_CLINIC.id, input);
    await messenger.sendTemplate(DEMO_CLINIC.id, input);
    expect(attempts).toBe(2);
  });

  it('every template renders from the same three variables, nothing clinical', () => {
    for (const render of Object.values(TEMPLATES)) {
      expect(render({ clinic: 'C', when: 'W', clinicPhone: 'P' })).not.toMatch(/undefined/);
    }
  });
});
