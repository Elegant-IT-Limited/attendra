// SPDX-License-Identifier: AGPL-3.0-only

type Fetch = typeof fetch;

/** The Twilio account's balance, as its Balance API says it: free to read, changes nothing. */
export interface TwilioBalanceReading {
  balance: number;
  currency: string;
}

/**
 * Reads the Twilio account's balance (GET /2010-04-01/Accounts/{sid}/Balance.json). At $0 calls and texts stop, so the
 * worker reads it every hour and pages under a line (twilio_balance_low). A subaccount answers with its parent's balance.
 */
export class TwilioBalance {
  private readonly auth: string;
  private readonly url: string;
  constructor(accountSid: string, authToken: string, private readonly http: Fetch = fetch) {
    this.auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    this.url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`;
  }

  async read(): Promise<TwilioBalanceReading> {
    const res = await this.http(this.url, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`twilio balance answered ${res.status}`);
    const body = (await res.json()) as { balance?: unknown; currency?: unknown };
    const balance = Number(body.balance);
    if (!Number.isFinite(balance)) throw new Error('twilio balance: no number in the answer');
    return { balance, currency: typeof body.currency === 'string' ? body.currency : 'USD' };
  }
}

/** "$8.20", or "8.20 EUR" for another currency. */
export const formatBalance = (r: TwilioBalanceReading) => (r.currency === 'USD' ? `$${r.balance.toFixed(2)}` : `${r.balance.toFixed(2)} ${r.currency}`);
