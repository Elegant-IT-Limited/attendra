// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, hospitalFor, resolveTransfer } from '@attendra/core';
import { createHash } from 'node:crypto';

/**
 * The backup route: what a caller hears when Attendra cannot take the call (our server,
 * OpenAI or the voice service down). Twilio tries the trunk's origination address; when
 * that fails, it asks the trunk's disaster recovery URL for TwiML. That URL is a Twilio
 * Function, hosted by Twilio, so it works while our server does not. It reads what to do
 * for the number that was dialled from a Twilio Sync map, which the worker keeps current:
 * ring the clinic's front desk or on-call phone if it has one, and otherwise say the
 * clinic cannot take the call and where to go in an emergency. It also tells Slack.
 */

/** What the backup route needs for one of our numbers. No caller data: clinic facts only. */
export interface FallbackEntry {
  clinic: string;
  language: 'en' | 'es';
  /** A person's phone (the front desk now, or the on-call phone), E.164; never a number forwarded to the assistant. */
  forwardTo: string | null;
  hospitalName: string | null;
  hospitalPhone: string | null;
}

const digits = (n: string) => n.replace(/\D/g, '').slice(-10);

/** The backup route's instructions for one clinic, as of now. */
export function fallbackEntry(clinic: ClinicConfig, now: Date): FallbackEntry {
  const own = new Set(clinic.phoneNumbers.map(digits));
  const pick = (target: 'front_desk' | 'on_call') => {
    const r = resolveTransfer(clinic, target, now);
    if (!r.ok || !r.uri.startsWith('tel:')) return null;
    const n = r.uri.slice(4);
    // a line forwarded to the assistant would ring straight back into the outage
    return own.has(digits(n)) ? null : n;
  };
  const hospital = hospitalFor(clinic, now);
  return {
    clinic: clinic.name,
    language: clinic.primaryLanguage === 'es' ? 'es' : 'en',
    forwardTo: pick('front_desk') ?? pick('on_call'),
    hospitalName: hospital?.name ?? null,
    hospitalPhone: hospital?.phone ?? null,
  };
}

/** The Twilio Function that answers the trunk's disaster recovery URL. Runs on Twilio, not on our server. */
export const FALLBACK_FUNCTION = String.raw`// Attendra's backup route: Twilio calls this when Attendra cannot take a call.
const spaced = (n) => String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').split('').join(' ');
exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const to = String(event.To || event.Called || '');
  if (event.DialCallStatus === 'completed' || event.DialCallStatus === 'answered') { twiml.hangup(); return callback(null, twiml); }
  let e = null;
  try { e = (await context.getTwilioClient().sync.v1.services(context.SYNC_SERVICE_SID).syncMaps('numbers').syncMapItems(to).fetch()).data; } catch (err) { e = null; }
  const es = !!e && e.language === 'es';
  const say = { language: es ? 'es-US' : 'en-US' };
  const clinic = (e && e.clinic) || (es ? 'la clínica' : 'the clinic');
  if (!event.DialCallStatus && context.SLACK_WEBHOOK_URL) {
    try {
      await fetch(context.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '[backup] :rotating_light: backup_route: the backup route answered a call to …' + to.slice(-4) + (e ? ' (' + e.clinic + ')' : '') + '. Attendra did not take it: check the voice service and OpenAI.' }) });
    } catch (err) { /* the caller comes first */ }
  }
  if (e && e.forwardTo && !event.DialCallStatus) {
    twiml.say(say, es ? 'Gracias por llamar a ' + clinic + '. Un momento, por favor, le comunico.' : 'Thank you for calling ' + clinic + '. Please hold while I connect you.');
    const dial = twiml.dial({ timeout: 25, callerId: event.From || to, action: context.PATH });
    dial.number(e.forwardTo);
    return callback(null, twiml);
  }
  const hospital = e && e.hospitalName && e.hospitalPhone
    ? (es ? ' Si su mascota necesita atención urgente, llame a ' + e.hospitalName + ' al ' + spaced(e.hospitalPhone) + '.' : ' If your pet needs urgent care, call ' + e.hospitalName + ' on ' + spaced(e.hospitalPhone) + '.')
    : (es ? ' Si su mascota necesita atención urgente, llame a la clínica de emergencias veterinarias más cercana.' : ' If your pet needs urgent care, please call your nearest emergency vet.');
  twiml.say(say, (es ? 'Gracias por llamar a ' + clinic + '. En este momento no podemos atender su llamada. Por favor, vuelva a llamar en unos minutos.' : 'Thank you for calling ' + clinic + '. We cannot take your call right now. Please call back in a few minutes.') + hospital + (es ? ' Adiós.' : ' Goodbye.'));
  twiml.hangup();
  return callback(null, twiml);
};
`;

/** The version of the function: a change to its code is a new build, the same code is not. */
export const fallbackVersion = (source = FALLBACK_FUNCTION) => createHash('sha256').update(source).digest('hex').slice(0, 16);

type Fetch = typeof fetch;
const NAME = 'attendra-fallback';

/**
 * Keeps the backup route in place over Twilio's REST API: the Sync map of numbers, the
 * Function (built and deployed only when its code changed), its settings, and the trunk's
 * disaster recovery URL. Every step is idempotent, so it runs at each worker start.
 */
export class TwilioFallback {
  private readonly auth: string;
  constructor(accountSid: string, authToken: string, private readonly http: Fetch = fetch) {
    this.auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
  }

  private async call<T>(method: string, url: string, form?: Record<string, string>): Promise<T> {
    const res = await this.http(url, {
      method, headers: { authorization: this.auth, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null as T;
    if (!res.ok) throw new Error(`twilio ${method} ${new URL(url).pathname} answered ${res.status}`);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /** The Sync service the function reads, created once. */
  async syncService(): Promise<string> {
    const list = await this.call<{ services: { sid: string; friendly_name: string }[] }>('GET', 'https://sync.twilio.com/v1/Services?PageSize=100');
    const found = list.services.find((s) => s.friendly_name === NAME);
    const sid = found?.sid ?? (await this.call<{ sid: string }>('POST', 'https://sync.twilio.com/v1/Services', { FriendlyName: NAME })).sid;
    const map = await this.call<{ sid: string } | null>('GET', `https://sync.twilio.com/v1/Services/${sid}/Maps/numbers`);
    if (!map) await this.call('POST', `https://sync.twilio.com/v1/Services/${sid}/Maps`, { UniqueName: 'numbers' });
    return sid;
  }

  /** Writes what changed in the map: new numbers, changed ones, and numbers that are no longer ours. */
  async sync(entries: Map<string, FallbackEntry>): Promise<{ written: number; removed: number }> {
    const sid = await this.syncService();
    const base = `https://sync.twilio.com/v1/Services/${sid}/Maps/numbers/Items`;
    const have = new Map<string, string>();
    let next: string | null = `${base}?PageSize=1000`;
    while (next) {
      const page: { items: { key: string; data: unknown }[]; meta: { next_page_url: string | null } } = await this.call('GET', next);
      for (const i of page.items) have.set(i.key, JSON.stringify(i.data));
      next = page.meta.next_page_url;
    }
    let written = 0;
    let removed = 0;
    for (const [number, entry] of entries) {
      const data = JSON.stringify(entry);
      if (have.get(number) === data) continue;
      if (have.has(number)) await this.call('POST', `${base}/${encodeURIComponent(number)}`, { Data: data });
      else await this.call('POST', base, { Key: number, Data: data });
      written++;
    }
    for (const number of have.keys()) {
      if (entries.has(number)) continue;
      await this.call('DELETE', `${base}/${encodeURIComponent(number)}`);
      removed++;
    }
    return { written, removed };
  }

  /**
   * The function deployed with this code, its settings, and the trunk pointing at it.
   * Returns the backup route's URL.
   */
  async ensure(o: { trunkSid: string; slackWebhookUrl?: string; source?: string }): Promise<string> {
    const source = o.source ?? FALLBACK_FUNCTION;
    const version = fallbackVersion(source);
    const syncSid = await this.syncService();
    const S = 'https://serverless.twilio.com/v1/Services';
    const services = await this.call<{ services: { sid: string; unique_name: string }[] }>('GET', `${S}?PageSize=100`);
    const service = services.services.find((s) => s.unique_name === NAME)?.sid
      ?? (await this.call<{ sid: string }>('POST', S, { UniqueName: NAME, FriendlyName: 'Attendra backup route', IncludeCredentials: 'true' })).sid;
    const envs = await this.call<{ environments: { sid: string; unique_name: string; domain_name: string; build_sid: string | null }[] }>('GET', `${S}/${service}/Environments`);
    const env = envs.environments.find((e) => e.unique_name === 'production')
      ?? (await this.call<{ sid: string; unique_name: string; domain_name: string; build_sid: string | null }>('POST', `${S}/${service}/Environments`, { UniqueName: 'production', DomainSuffix: 'prod' }));
    const vars = await this.call<{ variables: { sid: string; key: string; value: string }[] }>('GET', `${S}/${service}/Environments/${env.sid}/Variables`);
    const setVar = async (key: string, value: string) => {
      const v = vars.variables.find((x) => x.key === key);
      if (v?.value === value) return false;
      if (v) await this.call('POST', `${S}/${service}/Environments/${env.sid}/Variables/${v.sid}`, { Value: value });
      else await this.call('POST', `${S}/${service}/Environments/${env.sid}/Variables`, { Key: key, Value: value });
      return true;
    };
    const changed = [await setVar('SYNC_SERVICE_SID', syncSid), o.slackWebhookUrl ? await setVar('SLACK_WEBHOOK_URL', o.slackWebhookUrl) : false].some(Boolean);
    const deployed = vars.variables.find((x) => x.key === 'FALLBACK_VERSION')?.value;
    if (deployed !== version || !env.build_sid || changed) {
      const fns = await this.call<{ functions: { sid: string; friendly_name: string }[] }>('GET', `${S}/${service}/Functions`);
      const fn = fns.functions.find((f) => f.friendly_name === 'fallback')?.sid
        ?? (await this.call<{ sid: string }>('POST', `${S}/${service}/Functions`, { FriendlyName: 'fallback' })).sid;
      const form = new FormData();
      form.append('Path', '/fallback');
      form.append('Visibility', 'protected'); // Twilio checks the request's signature before running it
      form.append('Content', new Blob([source], { type: 'application/javascript' }), 'fallback.js');
      const up = await this.http(`https://serverless-upload.twilio.com/v1/Services/${service}/Functions/${fn}/Versions`, { method: 'POST', headers: { authorization: this.auth }, body: form, signal: AbortSignal.timeout(30_000) });
      if (!up.ok) throw new Error(`twilio function upload answered ${up.status}`);
      const fv = (await up.json() as { sid: string }).sid;
      const build = await this.call<{ sid: string }>('POST', `${S}/${service}/Builds`, { FunctionVersions: fv, Runtime: 'node22' });
      for (let i = 0; ; i++) {
        const st = await this.call<{ status: string }>('GET', `${S}/${service}/Builds/${build.sid}/Status`);
        if (st.status === 'completed') break;
        if (st.status === 'failed' || i >= 60) throw new Error(`the backup route's build ${st.status === 'failed' ? 'failed' : 'did not finish'}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      await this.call('POST', `${S}/${service}/Environments/${env.sid}/Deployments`, { BuildSid: build.sid });
      await setVar('FALLBACK_VERSION', version);
    }
    const url = `https://${env.domain_name}/fallback`;
    const trunk = await this.call<{ disaster_recovery_url: string | null } | null>('GET', `https://trunking.twilio.com/v1/Trunks/${o.trunkSid}`);
    if (!trunk) throw new Error('the trunk was not found');
    if (trunk.disaster_recovery_url !== url) await this.call('POST', `https://trunking.twilio.com/v1/Trunks/${o.trunkSid}`, { DisasterRecoveryUrl: url, DisasterRecoveryMethod: 'POST' });
    return url;
  }
}
