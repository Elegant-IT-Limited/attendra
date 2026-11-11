// SPDX-License-Identifier: AGPL-3.0-only

type Fetch = typeof fetch;
type Header = { name: string; value: string };

/**
 * The phone side of a call, for how it ended (note 48). OpenAI closes every gpt-realtime call's socket with 1006,
 * however it ends, so on its own a caller who simply hangs up the phone looks like a dropped line (and three drops in 15
 * minutes page the team). The phone call itself says it: when our socket closes and Twilio's call is over, the line was
 * hung up; when Twilio's call is still up, our side lost it, and that is a drop.
 */
export interface PhoneCallRef {
  /** Twilio's call SID from the call's SIP headers, when the trunk sent it. */
  callSid: string | null;
  /** The number dialled and the caller's, as the call came in: for finding the call without its SID. */
  to: string | null;
  from: string | null;
  /** When the call came in. */
  startedAt: Date;
}

export interface PhoneLine {
  /** Whether the phone call is over: true (hung up), false (still up), or null when the phone side cannot say. */
  ended(call: PhoneCallRef): Promise<boolean | null>;
}

/** Twilio's statuses for a call that is over, whoever ended it. */
const OVER = new Set(['completed', 'canceled', 'busy', 'failed', 'no-answer']);
const SID = /^CA[0-9a-f]{32}$/i;

/** Twilio's call SID among the SIP headers of an inbound trunk call (X-Twilio-CallSid), or null. */
export function twilioCallSid(headers: readonly Header[]): string | null {
  const v = headers.find((h) => h.name.toLowerCase() === 'x-twilio-callsid')?.value.trim() ?? '';
  return SID.test(v) ? v : null;
}

/**
 * Reads a call's status from Twilio's Calls API (GET /2010-04-01/Accounts/{sid}/Calls/{CallSid}.json, or the Calls list
 * by number when the trunk sent no SID): read-only, free. Elastic SIP Trunking calls are in it like any other call.
 */
export class TwilioPhoneLine implements PhoneLine {
  private readonly auth: string;
  private readonly base: string;
  constructor(accountSid: string, authToken: string, private readonly http: Fetch = fetch) {
    this.auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  }

  async ended(call: PhoneCallRef): Promise<boolean | null> {
    try {
      const status = call.callSid ? await this.statusOf(call.callSid) : await this.statusByNumber(call);
      return status === null ? null : OVER.has(status);
    } catch {
      // the phone side cannot say: the close is treated as before (a drop), never guessed a hang-up
      return null;
    }
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.http(`${this.base}${path}`, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`twilio calls answered ${res.status}`);
    return res.json();
  }

  private async statusOf(sid: string): Promise<string | null> {
    const body = (await this.get(`/Calls/${encodeURIComponent(sid)}.json`)) as { status?: unknown };
    return typeof body.status === 'string' ? body.status : null;
  }

  /** The latest call between these two numbers since a minute before this one came in. */
  private async statusByNumber(call: PhoneCallRef): Promise<string | null> {
    if (!call.to || !call.from) return null;
    const since = new Date(call.startedAt.getTime() - 60_000).toISOString().slice(0, 10);
    const q = new URLSearchParams({ To: call.to, From: call.from, 'StartTime>': since, PageSize: '5' });
    const body = (await this.get(`/Calls.json?${q}`)) as { calls?: { status?: unknown; start_time?: unknown; date_created?: unknown }[] };
    const at = (c: { start_time?: unknown; date_created?: unknown }) => Date.parse(String(c.start_time ?? c.date_created ?? '')) || 0;
    const recent = (body.calls ?? []).filter((c) => at(c) >= call.startedAt.getTime() - 60_000).sort((a, b) => at(b) - at(a))[0];
    return typeof recent?.status === 'string' ? recent.status : null;
  }
}
