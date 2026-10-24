// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Spend alerts: Twilio usage triggers that call the voice service when a day's spend
 * passes a line, so the people who run Attendra hear of a runaway (texting fraud, a
 * bot calling all day) the same day, in Slack. Twilio counts the spend, so this works
 * even when our own counts are wrong. Kept in place by the worker at each start.
 */
export interface SpendTrigger {
  /** Twilio's friendly name: how the worker finds its own triggers again. */
  name: string;
  /** Twilio's usage category: `sms` (texts), `totalprice` (the whole bill). */
  category: string;
  /** Dollars in a day. */
  usd: number;
  /** What it is about, for the alert. */
  what: string;
}

/** The alerts a deployment gets: texts at $10 a day, the whole Twilio bill at $25 a day. */
export const spendTriggers = (smsUsd = 10, totalUsd = 25): SpendTrigger[] => [
  { name: 'attendra-sms-daily', category: 'sms', usd: smsUsd, what: 'texts' },
  { name: 'attendra-total-daily', category: 'totalprice', usd: totalUsd, what: 'the whole Twilio bill' },
];

/** The voice service's path Twilio calls when a trigger fires. */
export const SPEND_ALERT_PATH = '/webhooks/twilio/spend-alert';

type Fetch = typeof fetch;
interface UsageTrigger { sid: string; friendly_name: string; callback_url: string; trigger_value: string; usage_category: string; recurring: string; trigger_by: string }

export class TwilioSpendAlerts {
  private readonly auth: string;
  private readonly base: string;
  constructor(accountSid: string, authToken: string, private readonly http: Fetch = fetch) {
    this.auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Usage/Triggers`;
  }

  private async call<T>(method: string, url: string, form?: Record<string, string>): Promise<T> {
    const res = await this.http(url, {
      method, headers: { authorization: this.auth, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`twilio ${method} usage triggers answered ${res.status}`);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /**
   * Each trigger in place, daily, by price, calling `callbackUrl`. A trigger whose line or
   * category changed is made again (Twilio cannot change them); one whose address changed
   * is updated. Returns what it did, for the log.
   */
  async ensure(callbackUrl: string, triggers: SpendTrigger[]): Promise<{ created: number; updated: number }> {
    const list = await this.call<{ usage_triggers: UsageTrigger[] }>('GET', `${this.base}.json?PageSize=100`);
    let created = 0;
    let updated = 0;
    for (const t of triggers) {
      const have = list.usage_triggers.filter((u) => u.friendly_name === t.name);
      const same = (u: UsageTrigger) => u.usage_category === t.category && Number(u.trigger_value) === t.usd && u.recurring === 'daily' && u.trigger_by === 'price';
      const keep = have.find(same);
      for (const u of have) if (u !== keep) await this.call('DELETE', `${this.base}/${u.sid}.json`);
      if (!keep) {
        await this.call('POST', `${this.base}.json`, {
          FriendlyName: t.name, UsageCategory: t.category, TriggerValue: String(t.usd), TriggerBy: 'price',
          Recurring: 'daily', CallbackUrl: callbackUrl, CallbackMethod: 'POST',
        });
        created++;
      } else if (keep.callback_url !== callbackUrl) {
        await this.call('POST', `${this.base}/${keep.sid}.json`, { CallbackUrl: callbackUrl, CallbackMethod: 'POST' });
        updated++;
      }
    }
    return { created, updated };
  }
}

/** The Slack line for a trigger that fired. Twilio's own fields only; nothing about callers. */
export function spendAlertText(f: Record<string, string | undefined>, triggers: SpendTrigger[] = spendTriggers()): string {
  const what = triggers.find((t) => t.category === f.UsageCategory)?.what ?? f.UsageCategory ?? 'Twilio';
  const money = (v?: string) => (v && Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : 'unknown');
  return `Twilio spend today on ${what} is ${money(f.CurrentValue)}, past the ${money(f.TriggerValue)} alert. Check #sys-attendra for text limits and blocked numbers, and the Twilio console's usage page.`;
}
