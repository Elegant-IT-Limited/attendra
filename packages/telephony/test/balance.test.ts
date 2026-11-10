import { describe, expect, it } from 'vitest';
import { formatBalance, TwilioBalance } from '../src';

describe('the Twilio balance', () => {
  it('reads the account\'s balance with its own credentials, and only reads', async () => {
    const seen: { url: string; method: string; auth: string | null }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ currency: 'USD', balance: '8.2050', account_sid: 'AC123' }), { status: 200 });
    }) as typeof fetch;
    const reading = await new TwilioBalance('AC123', 'token', http).read();
    expect(reading).toEqual({ balance: 8.205, currency: 'USD' });
    expect(formatBalance(reading)).toBe('$8.21');
    expect(formatBalance({ balance: 3, currency: 'EUR' })).toBe('3.00 EUR');
    expect(seen).toEqual([{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Balance.json', method: 'GET', auth: `Basic ${Buffer.from('AC123:token').toString('base64')}` }]);
  });

  it('fails on an error answer or an answer with no number, so the worker says it could not read it', async () => {
    const answer = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    await expect(new TwilioBalance('AC1', 't', answer(401, '{}')).read()).rejects.toThrow('twilio balance answered 401');
    await expect(new TwilioBalance('AC1', 't', answer(200, '{"balance":"n/a"}')).read()).rejects.toThrow('no number');
  });
});
