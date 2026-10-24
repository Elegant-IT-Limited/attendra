import { describe, expect, it } from 'vitest';
import { spendAlertText, spendTriggers, TwilioSpendAlerts } from '../src';

const URL = 'https://voice.example.com/webhooks/twilio/spend-alert';

/** Twilio's usage triggers API, in memory: lists, creates, updates and deletes, and records each call. */
function fakeTwilio(existing: Record<string, string>[]) {
  const triggers = [...existing];
  const calls: string[] = [];
  const http = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const form = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    calls.push(`${method} ${new globalThis.URL(url).pathname.split('/').pop()}`);
    if (method === 'GET') return new Response(JSON.stringify({ usage_triggers: triggers }), { status: 200 });
    if (method === 'DELETE') { triggers.splice(triggers.findIndex((t) => url.includes(t.sid!)), 1); return new Response(null, { status: 204 }); }
    const sid = /Triggers\/(UT\w+)\.json/.exec(url)?.[1];
    if (sid) Object.assign(triggers.find((t) => t.sid === sid)!, { callback_url: form.CallbackUrl });
    else triggers.push({ sid: `UT${triggers.length}`, friendly_name: form.FriendlyName!, usage_category: form.UsageCategory!, trigger_value: form.TriggerValue!, recurring: form.Recurring!, trigger_by: form.TriggerBy!, callback_url: form.CallbackUrl! });
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  return { triggers, calls, client: new TwilioSpendAlerts('AC123', 'token', http) };
}

describe('spend alerts', () => {
  it('creates the two daily triggers once, and changes nothing on the next start', async () => {
    const t = fakeTwilio([]);
    expect(await t.client.ensure(URL, spendTriggers())).toEqual({ created: 2, updated: 0 });
    expect(t.triggers.map((x) => [x.friendly_name, x.usage_category, x.trigger_value, x.recurring, x.trigger_by])).toEqual([
      ['attendra-sms-daily', 'sms', '10', 'daily', 'price'], ['attendra-total-daily', 'totalprice', '25', 'daily', 'price'],
    ]);
    expect(await t.client.ensure(URL, spendTriggers())).toEqual({ created: 0, updated: 0 });
  });

  it('remakes a trigger whose line changed, and updates one whose address changed', async () => {
    const t = fakeTwilio([]);
    await t.client.ensure(URL, spendTriggers());
    expect(await t.client.ensure('https://voice2.example.com/webhooks/twilio/spend-alert', spendTriggers(20))).toEqual({ created: 1, updated: 1 });
    expect(t.triggers.find((x) => x.usage_category === 'sms')).toMatchObject({ trigger_value: '20', callback_url: 'https://voice2.example.com/webhooks/twilio/spend-alert' });
    expect(t.triggers).toHaveLength(2);
    expect(t.calls).toContain('DELETE UT0.json');
  });

  it('says what passed which line, in dollars', () => {
    expect(spendAlertText({ UsageCategory: 'totalprice', CurrentValue: '31.5', TriggerValue: '25' })).toMatch(/^Twilio spend today on the whole Twilio bill is \$31\.50, past the \$25\.00 alert\./);
  });
});
