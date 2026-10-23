import { DEMO_CLINIC, RIVERBEND_CLINIC, zonedInstant } from '@attendra/core';
import twilio from 'twilio';
import { describe, expect, it } from 'vitest';
import { FALLBACK_FUNCTION, fallbackEntry, fallbackVersion, TwilioFallback } from '../src';

const at = (time: string) => zonedInstant('2026-09-29', time, DEMO_CLINIC.timezone); // a Tuesday

describe('what the backup route does for a clinic', () => {
  it('rings the front desk while it is open and the on-call phone after, never a number forwarded to the assistant', () => {
    expect(fallbackEntry(DEMO_CLINIC, at('10:00')).forwardTo).toBe('+13035550101');
    expect(fallbackEntry(DEMO_CLINIC, at('22:00')).forwardTo).toBe('+13035550199');
    const loop = { ...DEMO_CLINIC, routing: [{ target: 'front_desk' as const, uri: 'tel:+13035550100', when: 'always' as const, priority: 0 }] };
    expect(fallbackEntry(loop, at('10:00')).forwardTo).toBeNull();
    expect(fallbackEntry(RIVERBEND_CLINIC, at('22:00'))).toMatchObject({ clinic: RIVERBEND_CLINIC.name, language: 'en', hospitalName: 'Front Range Pet Emergency', hospitalPhone: '+17205550188' });
  });
});

/** Runs the Twilio Function the way Twilio does: a handler with a context, an event and a callback. */
async function run(event: Record<string, string>, entry: unknown, slack = 'https://hooks.slack.com/services/T/B/x') {
  const posted: string[] = [];
  const exports: { handler?: (c: unknown, e: unknown, cb: (err: unknown, r: unknown) => void) => Promise<void> } = {};
  const fakeFetch = async (_u: string, init: { body: string }) => { posted.push(JSON.parse(init.body).text); return new Response('ok'); };
  new Function('exports', 'Twilio', 'fetch', FALLBACK_FUNCTION)(exports, { twiml: twilio.twiml }, fakeFetch);
  const context = {
    SYNC_SERVICE_SID: 'IS1', SLACK_WEBHOOK_URL: slack, PATH: '/fallback',
    getTwilioClient: () => ({ sync: { v1: { services: () => ({ syncMaps: () => ({ syncMapItems: () => ({ fetch: async () => { if (!entry) throw new Error('404'); return { data: entry }; } }) }) }) } } }),
  };
  const xml = await new Promise<string>((resolve) => { void exports.handler!(context, event, (_err, r) => resolve(String(r))); });
  return { xml, posted };
}

describe('the backup route on Twilio', () => {
  const entry = { clinic: 'Riverbend Animal Hospital', language: 'en', forwardTo: '+17205550151', hospitalName: 'Front Range Pet Emergency', hospitalPhone: '+17205550188' };

  it('rings the clinic\'s person, with the caller\'s number, and tells Slack once', async () => {
    const r = await run({ To: '+17205550160', From: '+17205550172' }, entry);
    expect(r.xml).toContain('Thank you for calling Riverbend Animal Hospital. Please hold while I connect you.');
    expect(r.xml).toContain('<Dial timeout="25" callerId="+17205550172" action="/fallback"><Number>+17205550151</Number></Dial>');
    expect(r.posted).toEqual(['[backup] :rotating_light: backup_route: the backup route answered a call to …0160 (Riverbend Animal Hospital). Attendra did not take it: check the voice service and OpenAI.']);
    // nobody answered: where to go in an emergency, and goodbye; no second alert
    const missed = await run({ To: '+17205550160', From: '+17205550172', DialCallStatus: 'no-answer' }, entry);
    expect(missed.xml).toContain('If your pet needs urgent care, call Front Range Pet Emergency on 7 2 0 5 5 5 0 1 8 8.');
    expect(missed.posted).toEqual([]);
    expect((await run({ To: '+17205550160', DialCallStatus: 'completed' }, entry)).xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it('says the clinic cannot take the call when there is nobody to ring, in Spanish for a Spanish clinic, and still answers with no entry at all', async () => {
    const es = await run({ To: '+17205550160' }, { ...entry, language: 'es', forwardTo: null });
    expect(es.xml).toContain('language="es-US"');
    expect(es.xml).toContain('En este momento no podemos atender su llamada');
    const none = await run({ To: '+15160000000' }, null);
    expect(none.xml).toContain('Thank you for calling the clinic. We cannot take your call right now.');
    expect(none.xml).toContain('please call your nearest emergency vet');
  });
});

describe('keeping the backup route in place', () => {
  function fakeTwilio(state: { built: number; version?: string; dr?: string | null; items: Map<string, string> }) {
    const calls: string[] = [];
    const http = (async (url: string, init: { method: string; body?: unknown }) => {
      const u = new URL(url);
      const key = `${init.method} ${u.host.split('.')[0]}${u.pathname}`;
      calls.push(key);
      const form = typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (key === 'GET sync/v1/Services') return json({ services: [{ sid: 'IS1', friendly_name: 'attendra-fallback' }] });
      if (key === 'GET sync/v1/Services/IS1/Maps/numbers') return json({ sid: 'MP1' });
      if (key === 'GET sync/v1/Services/IS1/Maps/numbers/Items') return json({ items: [...state.items].map(([k, d]) => ({ key: k, data: JSON.parse(d) })), meta: { next_page_url: null } });
      if (key === 'POST sync/v1/Services/IS1/Maps/numbers/Items') { state.items.set(form.Key!, form.Data!); return json({}); }
      if (key.startsWith('POST sync/v1/Services/IS1/Maps/numbers/Items/')) { state.items.set(decodeURIComponent(u.pathname.split('/').pop()!), form.Data!); return json({}); }
      if (key.startsWith('DELETE sync/')) { state.items.delete(decodeURIComponent(u.pathname.split('/').pop()!)); return new Response(null, { status: 204 }); }
      if (key === 'GET serverless/v1/Services') return json({ services: [{ sid: 'ZS1', unique_name: 'attendra-fallback' }] });
      if (key === 'GET serverless/v1/Services/ZS1/Environments') return json({ environments: [{ sid: 'ZE1', unique_name: 'production', domain_name: 'attendra-fallback-1234-prod.twil.io', build_sid: state.built ? 'ZB1' : null }] });
      if (key === 'GET serverless/v1/Services/ZS1/Environments/ZE1/Variables') return json({ variables: [{ sid: 'ZV1', key: 'SYNC_SERVICE_SID', value: 'IS1' }, ...(state.version ? [{ sid: 'ZV2', key: 'FALLBACK_VERSION', value: state.version }] : [])] });
      if (key.startsWith('POST serverless/v1/Services/ZS1/Environments/ZE1/Variables')) { if (form.Key === 'FALLBACK_VERSION') state.version = form.Value; return json({}); }
      if (key === 'GET serverless/v1/Services/ZS1/Functions') return json({ functions: [{ sid: 'ZH1', friendly_name: 'fallback' }] });
      if (key === 'POST serverless-upload/v1/Services/ZS1/Functions/ZH1/Versions') return json({ sid: 'ZN1' });
      if (key === 'POST serverless/v1/Services/ZS1/Builds') { state.built++; return json({ sid: 'ZB1' }); }
      if (key === 'GET serverless/v1/Services/ZS1/Builds/ZB1/Status') return json({ status: 'completed' });
      if (key === 'POST serverless/v1/Services/ZS1/Environments/ZE1/Deployments') return json({ sid: 'ZD1' });
      if (key === 'GET trunking/v1/Trunks/TK1') return json({ disaster_recovery_url: state.dr ?? null });
      if (key === 'POST trunking/v1/Trunks/TK1') { state.dr = form.DisasterRecoveryUrl; return json({}); }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
    return { http, calls };
  }

  it('builds and deploys the function once, points the trunk at it, and does nothing the second time', async () => {
    const state = { built: 0, items: new Map<string, string>() } as { built: number; version?: string; dr?: string | null; items: Map<string, string> };
    const t = fakeTwilio(state);
    const f = new TwilioFallback('AC1', 'token', t.http);
    expect(await f.ensure({ trunkSid: 'TK1', slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x' })).toBe('https://attendra-fallback-1234-prod.twil.io/fallback');
    expect(state).toMatchObject({ built: 1, version: fallbackVersion(), dr: 'https://attendra-fallback-1234-prod.twil.io/fallback' });
    const before = t.calls.length;
    await f.ensure({ trunkSid: 'TK1' });
    expect(state.built).toBe(1);
    expect(t.calls.slice(before).filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('writes only what changed in the numbers map, and removes numbers that are no longer ours', async () => {
    const state = { built: 0, items: new Map([['+15160000000', '{"clinic":"Gone"}']]) };
    const f = new TwilioFallback('AC1', 'token', fakeTwilio(state).http);
    const entry = fallbackEntry(RIVERBEND_CLINIC, at('10:00'));
    expect(await f.sync(new Map([['+17205550160', entry]]))).toEqual({ written: 1, removed: 1 });
    expect(await f.sync(new Map([['+17205550160', entry]]))).toEqual({ written: 0, removed: 0 });
    expect([...state.items.keys()]).toEqual(['+17205550160']);
  });
});
