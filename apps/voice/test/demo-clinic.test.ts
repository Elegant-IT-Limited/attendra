import { ScriptedPlanner } from '@attendra/agent';
import { type ClinicConfig, DEMO_BUSY_LINE, DEMO_CLINIC, DEMO_LIMITS, DEMO_TIME_UP, DEMO_WRAP_UP, RIVERBEND_CLINIC } from '@attendra/core';
import { createLogger } from '@attendra/observability';
import type { Sideband, SidebandEvent } from '@attendra/voice-engine';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer, DEMO_LIMIT_MAX_MS, type IncomingCall, type VoiceDeps } from '../src/server';

// A demo clinic's limits on our own phone path (2026-11-16, core demo-clinic.ts): checked when the call arrives, before
// any model runs; over one, the one fixed line and the end within 10 s; under them, the end at 15 minutes. A clinic that
// is not a demo clinic is never asked about any of it. Made-up details only.
const log = createLogger({ name: 'test', destination: new Writable({ write: (_c, _e, done) => done() }) });
const DEMO: ClinicConfig = { ...RIVERBEND_CLINIC, demoClinic: { enabled: true, baselineAt: null } };
const CALLER = '+13035550147';
type Usage = { callerCalls: number; clinicSeconds: number; refusedToday: { demo_caller_calls: number; demo_clinic_minutes: number } };
const usage = (u: Partial<Usage> = {}): Usage => ({ callerCalls: 0, clinicSeconds: 0, refusedToday: { demo_caller_calls: 0, demo_clinic_minutes: 0 }, ...u });

function openSideband() {
  let close: (code: number) => void = () => {};
  const sideband: Sideband = { send: vi.fn(), onEvent: vi.fn((_h: (e: SidebandEvent) => void) => {}), onError: vi.fn(), onClose: vi.fn((h: (c: number) => void) => { close = h; }), close: vi.fn() };
  return { sideband, drop: (code = 1000) => close(code) };
}

function setup(clinic: ClinicConfig, over: Partial<VoiceDeps> = {}) {
  const seen = new Set<string>();
  const call = openSideband();
  const engine = {
    name: 'fake', accept: vi.fn(async () => {}), startBrowserCall: vi.fn(async () => ({ sessionId: 'live_web', sdpAnswer: 'v=0' })), reject: vi.fn(async () => {}), transfer: vi.fn(async () => {}),
    hangup: vi.fn(async () => { call.drop(); }), release: vi.fn(), attach: vi.fn(() => call.sideband),
  } satisfies VoiceDeps['engine'];
  const actions: { tool: string; result: unknown }[] = [];
  const notes: string[] = [];
  const demoUsage = vi.fn(async () => usage());
  const d: VoiceDeps = {
    verifyWebhook: async (raw) => JSON.parse(raw) as IncomingCall,
    claimDelivery: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    clinicForNumber: async () => clinic,
    clinicById: async () => clinic,
    openCall: vi.fn(async () => 'call_1'),
    recorderFor: () => ({ appendSegment: async () => {}, close: async () => {} }),
    actionsFor: () => ({ record: async (a) => { actions.push({ tool: a.tool, result: a.result }); } }),
    alerts: { alert: vi.fn(), resolved: vi.fn(), note: (t: string) => { notes.push(t); }, flush: async () => {} },
    engine, backend: {} as never, planner: new ScriptedPlanner([]), log, demoUsage,
    ...over,
  };
  return { d, engine, call, actions, notes, demoUsage: (d.demoUsage ?? demoUsage) as typeof demoUsage };
}

const incoming = (id: string) => JSON.stringify({
  id, type: 'live.transport.incoming',
  data: { type: 'sip', session_id: `live_${id}`, sip_headers: [{ name: 'To', value: `<sip:${DEMO.phoneNumbers[0]}@sip.api.openai.com>` }, { name: 'From', value: `<sip:${CALLER}@x>` }] },
});
const post = (app: ReturnType<typeof buildServer>, id: string) => app.inject({ method: 'POST', url: '/webhooks/openai', headers: { 'content-type': 'application/json' }, payload: incoming(id) });
const openingOf = (engine: ReturnType<typeof setup>['engine']) => (engine.accept.mock.calls[0] as unknown[] | undefined)?.[3] as string | undefined;
const sent = (call: ReturnType<typeof setup>['call']) => JSON.stringify((call.sideband.send as ReturnType<typeof vi.fn>).mock.calls);

afterEach(() => { vi.useRealTimers(); });

describe('a demo clinic\'s limits, on our own phone path', () => {
  it('asks today\'s use in the clinic\'s day, and lets a call under the limits through as usual', async () => {
    const s = setup(DEMO);
    const app = buildServer(s.d);
    await post(app, 'wh_ok');
    await vi.waitFor(() => expect(s.engine.accept).toHaveBeenCalled());
    expect(s.demoUsage).toHaveBeenCalledWith(DEMO.id, CALLER, expect.objectContaining({ start: expect.any(Date), end: expect.any(Date) }), expect.any(Date));
    const [, , day] = s.demoUsage.mock.calls[0] as unknown as [string, string, { start: Date; end: Date }];
    expect(day.end.getTime() - day.start.getTime()).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(openingOf(s.engine)).toBeUndefined();
    expect(s.actions.map((a) => a.tool)).not.toContain('demo_limit');
    s.call.drop();
    await app.close();
  });

  it('turns away a caller with 5 calls today: the one fixed line, recorded with its code, said in Slack once a day, ended within 10 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = setup(DEMO);
    s.demoUsage.mockResolvedValue(usage({ callerCalls: DEMO_LIMITS.callsPerCallerPerDay }));
    const app = buildServer(s.d);
    await post(app, 'wh_caller');
    await vi.waitFor(() => expect(s.actions.map((a) => a.tool)).toContain('demo_limit'));
    expect(openingOf(s.engine)).toContain(DEMO_BUSY_LINE.en);
    expect(openingOf(s.engine)).not.toMatch(/How can I help|AI assistant/);
    expect(s.actions).toContainEqual({ tool: 'demo_limit', result: { code: 'demo_caller_calls' } });
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toContain('one caller number reached 5 calls today');
    expect(s.notes[0]).not.toContain('0147');
    await vi.advanceTimersByTimeAsync(DEMO_LIMIT_MAX_MS);
    expect(s.engine.hangup).toHaveBeenCalled();
    // never put through to anyone, even when the caller heard nothing (the silent-start fallback is off for it)
    expect(s.engine.transfer).not.toHaveBeenCalled();
    await app.close();
  });

  it('turns away every caller once the line had 60 minutes today; a second refusal of the day is not said in Slack again', async () => {
    const s = setup(DEMO);
    s.demoUsage.mockResolvedValue(usage({ clinicSeconds: DEMO_LIMITS.clinicSecondsPerDay, refusedToday: { demo_caller_calls: 0, demo_clinic_minutes: 1 } }));
    const app = buildServer(s.d);
    await post(app, 'wh_minutes');
    await vi.waitFor(() => expect(s.actions).toContainEqual({ tool: 'demo_limit', result: { code: 'demo_clinic_minutes' } }));
    expect(openingOf(s.engine)).toContain(DEMO_BUSY_LINE.en);
    expect(s.notes).toEqual([]);
    s.call.drop();
    await app.close();
  });

  it('a call under the limits hears one polite line at 14:00 and ends at 15:00', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = setup(DEMO);
    const app = buildServer(s.d);
    await post(app, 'wh_long');
    await vi.waitFor(() => expect(s.engine.attach).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(DEMO_LIMITS.wrapUpAtSeconds * 1000 - 1000);
    expect(sent(s.call)).not.toContain('about a minute left');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent(s.call)).toContain(JSON.stringify(DEMO_WRAP_UP).slice(1, 60));
    expect(s.engine.hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent(s.call)).toContain(JSON.stringify(DEMO_TIME_UP).slice(1, 60));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.engine.hangup).toHaveBeenCalled();
    await app.close();
  });

  it('a use that cannot be read lets the call through (the plan\'s monthly minutes still hold)', async () => {
    const s = setup(DEMO);
    s.demoUsage.mockRejectedValue(new Error('db down'));
    const app = buildServer(s.d);
    await post(app, 'wh_unread');
    await vi.waitFor(() => expect(s.engine.accept).toHaveBeenCalled());
    expect(openingOf(s.engine)).toBeUndefined();
    s.call.drop();
    await app.close();
  });

  it('a paused assistant (the plan) comes first: the paused line, never the demo line', async () => {
    const s = setup({ ...DEMO, answeringPaused: true });
    s.demoUsage.mockResolvedValue(usage({ callerCalls: 9 }));
    const app = buildServer(s.d);
    await post(app, 'wh_paused');
    await vi.waitFor(() => expect(s.engine.accept).toHaveBeenCalled());
    expect(openingOf(s.engine)).toContain('not answering calls right now');
    expect(s.demoUsage).not.toHaveBeenCalled();
    s.call.drop();
    await app.close();
  });
});

describe('a clinic that is not a demo clinic', () => {
  for (const clinic of [RIVERBEND_CLINIC, DEMO_CLINIC, { ...RIVERBEND_CLINIC, demoClinic: { enabled: false, baselineAt: '2026-11-16T10:00:00.000Z' } }]) {
    it(`${clinic.name}${clinic.demoClinic ? ' (switched off)' : ''}: no limit is asked or applied, and no 15-minute end`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const s = setup(clinic);
      s.demoUsage.mockResolvedValue(usage({ callerCalls: 99, clinicSeconds: 99_999 }));
      const app = buildServer(s.d);
      await post(app, `wh_normal_${clinic.id}_${String(!!clinic.demoClinic)}`);
      await vi.waitFor(() => expect(s.engine.attach).toHaveBeenCalled());
      expect(s.demoUsage).not.toHaveBeenCalled();
      expect(openingOf(s.engine)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(DEMO_LIMITS.callSeconds * 1000 + 60_000);
      expect(sent(s.call)).not.toContain('demo call');
      expect(s.engine.hangup).not.toHaveBeenCalled();
      expect(s.actions.map((a) => a.tool)).not.toContain('demo_limit');
      s.call.drop();
      await app.close();
    });
  }
});
