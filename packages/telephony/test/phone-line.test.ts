// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { TwilioPhoneLine, twilioCallSid } from '../src';

// Note 48: how a phone call ended, from Twilio's call status. Fakes only: no request leaves the test.
const SID = 'CA0123456789abcdef0123456789abcdef';
const START = new Date('2026-11-11T10:00:00Z');
function fake(answer: (url: string) => { status: number; body?: unknown }) {
  const urls: string[] = [];
  const http = (async (url: string) => { urls.push(String(url)); const a = answer(String(url)); return new Response(JSON.stringify(a.body ?? {}), { status: a.status }); }) as unknown as typeof fetch;
  return { line: new TwilioPhoneLine('AC_test', 'token', http), urls };
}

describe('the phone side of a call', () => {
  it('reads Twilio\'s call SID from the SIP headers, in any case, and nothing else', () => {
    expect(twilioCallSid([{ name: 'From', value: '<sip:+13035550147@x>' }, { name: 'X-Twilio-CallSid', value: SID }])).toBe(SID);
    expect(twilioCallSid([{ name: 'x-twilio-callsid', value: ` ${SID} ` }])).toBe(SID);
    expect(twilioCallSid([{ name: 'X-Twilio-CallSid', value: 'not-a-sid' }])).toBeNull();
    expect(twilioCallSid([])).toBeNull();
  });

  it.each([['completed', true], ['canceled', true], ['busy', true], ['no-answer', true], ['failed', true], ['in-progress', false], ['ringing', false]])('a call %s is over: %s', async (status, over) => {
    const { line, urls } = fake(() => ({ status: 200, body: { status } }));
    expect(await line.ended({ callSid: SID, to: null, from: null, startedAt: START })).toBe(over);
    expect(urls[0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls/${SID}.json`);
  });

  it('cannot say when Twilio fails or answers without a status: never a guessed hang-up', async () => {
    expect(await fake(() => ({ status: 404 })).line.ended({ callSid: SID, to: null, from: null, startedAt: START })).toBeNull();
    expect(await fake(() => ({ status: 200, body: {} })).line.ended({ callSid: SID, to: null, from: null, startedAt: START })).toBeNull();
    const broken = new TwilioPhoneLine('AC_test', 'token', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(await broken.ended({ callSid: SID, to: null, from: null, startedAt: START })).toBeNull();
  });

  it('without a SID, the latest call between the two numbers since it came in', async () => {
    const { line, urls } = fake(() => ({ status: 200, body: { calls: [
      { status: 'in-progress', start_time: 'Wed, 11 Nov 2026 09:00:00 +0000' }, // an hour before: another call
      { status: 'completed', start_time: 'Wed, 11 Nov 2026 10:00:01 +0000' },
    ] } }));
    expect(await line.ended({ callSid: null, to: '+13035550100', from: '+13035550147', startedAt: START })).toBe(true);
    expect(urls[0]).toContain('To=%2B13035550100');
    expect(urls[0]).toContain('From=%2B13035550147');
    expect(await fake(() => ({ status: 200, body: { calls: [] } })).line.ended({ callSid: null, to: '+13035550100', from: '+13035550147', startedAt: START })).toBeNull();
    expect(await fake(() => ({ status: 200 })).line.ended({ callSid: null, to: null, from: '+13035550147', startedAt: START })).toBeNull();
  });
});
