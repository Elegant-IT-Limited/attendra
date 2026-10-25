import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_DATA_CHANNEL, callerContext, GptLiveEngine, type SidebandSocket, vipOpening } from '../src';

const NOW = zonedInstant('2026-09-28', '20:00', DEMO_CLINIC.timezone);

function fakeClient() {
  const create = vi.fn(async () => ({ session: { id: 'live_web' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }));
  const sessions = { accept: vi.fn(async () => {}), refer: vi.fn(async () => {}), hangup: vi.fn(async () => {}), reject: vi.fn(async () => {}) };
  return { client: { live: { create, sessions } } as unknown as OpenAI, create, sessions };
}

describe('GptLiveEngine browser calls', () => {
  it('creates a WebRTC session with the same clinic settings as a phone call, and a locked-down data channel', async () => {
    const { client, create, sessions } = fakeClient();
    const engine = new GptLiveEngine(client);
    expect(await engine.startBrowserCall(DEMO_CLINIC, 'v=0 offer', NOW)).toEqual({ sessionId: 'live_web', sdpAnswer: 'v=0 answer' });
    await engine.accept('live_sip', DEMO_CLINIC, NOW);

    const web = (create.mock.calls[0] as unknown as [{ session: Record<string, unknown>; transport: unknown }])[0];
    const sip = (sessions.accept.mock.calls[0] as unknown as [string, { session: Record<string, unknown> }])[1].session;
    expect(web.transport).toEqual({ type: 'webrtc', sdp: 'v=0 offer' });
    const { client: channel, ...shared } = web.session;
    const { type, ...sipShared } = sip;
    expect(type).toBe('live');
    expect(shared).toEqual(sipShared);
    expect(channel).toEqual({ data_channel: BROWSER_DATA_CHANNEL });
    expect(BROWSER_DATA_CHANNEL.allowed_client_events).toEqual(['session.close']);
  });

  it('tells GPT-Live to greet first on a phone call: a developer message at the start, and the same once the sideband attaches', async () => {
    const { client, sessions } = fakeClient();
    const sockets = fakeSockets();
    const engine = new GptLiveEngine(client, 'gpt-live-1', sockets.open);
    await engine.accept('live_sip', DEMO_CLINIC, NOW);
    const session = (sessions.accept.mock.calls[0] as unknown as [string, { session: { input: { role: string; content: { text: string }[] }[] } }])[1].session;
    expect(session.input).toHaveLength(1);
    expect(session.input[0]!.role).toBe('developer');
    expect(session.input[0]!.content[0]!.text).toContain(`Say exactly: "${DEMO_CLINIC.greeting}"`);
    expect(session.input[0]!.content[0]!.text).toContain('before they say anything');
    engine.attach('live_sip');
    engine.attach('live_sip'); // a second sideband never greets again
    const appends = sockets.all.flatMap((s) => s.sent).filter((e) => (e as { type: string }).type === 'session.instructions.append');
    expect(appends).toHaveLength(1);
    expect((appends[0] as { content: string; delegation_id: null }).delegation_id).toBeNull();
  });

  it('greets a VIP by name and says they are being put through, with no question first', async () => {
    const { client, sessions } = fakeClient();
    const engine = new GptLiveEngine(client, 'gpt-live-1', fakeSockets().open);
    await engine.accept('live_vip', DEMO_CLINIC, NOW, vipOpening(DEMO_CLINIC, 'Tamal Sidique'));
    const text = (sessions.accept.mock.calls[0] as unknown as [string, { session: { input: { content: { text: string }[] }[] } }])[1].session.input[0]!.content[0]!.text;
    expect(text).toContain(`Hi Tamal, thanks for calling ${DEMO_CLINIC.name}.`);
    expect(text).toContain("AI assistant. I'm connecting you with our team now.");
    expect(text).not.toContain(DEMO_CLINIC.greeting);
    expect(text).toContain('do not ask how you can help');
  });

  it('tells the voice what caller ID would show: the call count and the one name on file, never the calls\' content', () => {
    expect(callerContext(null)).toBeNull();
    const known = callerContext('Name on file for this number: Abdul.\nCalls from this number in the last 30 days: 5.\n2026-10-24T13:20:00.000Z: Booked a check-up for Flippy.')!;
    expect(known).toContain('it called 5 times in the last 30 days');
    expect(known).toContain('"Am I speaking with Abdul?"');
    expect(known).toContain('Never say you have no history');
    expect(known).not.toContain('Flippy');
    const unnamed = callerContext('Calls from this number in the last 30 days: 2.\n2026-10-24T13:20:00.000Z: A question.')!;
    expect(unnamed).not.toContain('Am I speaking with');
    expect(unnamed).toContain("ask for their first name and their pet's name");
  });

  it('never sends a browser session to the SIP endpoints', async () => {
    const { client, sessions } = fakeClient();
    const engine = new GptLiveEngine(client, 'gpt-live-1', fakeSockets().open);
    await engine.startBrowserCall(DEMO_CLINIC, 'v=0 offer', NOW);
    await expect(engine.transfer('live_web', 'tel:+13035550199')).rejects.toThrow('cannot be transferred');
    await engine.hangup('live_web');
    expect(sessions.refer).not.toHaveBeenCalled();
    expect(sessions.hangup).not.toHaveBeenCalled();
  });

  it('ends a browser session over its sideband, and over a fresh one once that has dropped', async () => {
    const { client, sessions } = fakeClient();
    const sockets = fakeSockets();
    const engine = new GptLiveEngine(client, 'gpt-live-1', sockets.open);
    await engine.startBrowserCall(DEMO_CLINIC, 'v=0 offer', NOW);
    engine.attach('live_web');
    await engine.hangup('live_web');
    expect(sockets.all[0]!.sent).toEqual([expect.objectContaining({ type: 'session.instructions.append' }), { type: 'session.close' }]);

    sockets.all[0]!.drop();
    await engine.hangup('live_web');
    expect(sockets.all).toHaveLength(2);
    expect(sockets.all[1]!.sent).toEqual([{ type: 'session.close' }]);
    expect(sockets.all[1]!.closed).toBe(true);
    expect(sessions.hangup).not.toHaveBeenCalled();

    engine.release('live_web');
    await engine.hangup('live_web'); // forgotten: an unknown id is a phone call again
    expect(sessions.hangup).toHaveBeenCalledWith('live_web');
  });
});

/** Sideband sockets that record what was sent; each answers session.close with session.closed. */
function fakeSockets() {
  const all: { sent: unknown[]; closed: boolean; drop: () => void }[] = [];
  const open = (): SidebandSocket => {
    const events: ((e: unknown) => void)[] = [];
    const closes: ((c: number) => void)[] = [];
    const rec = { sent: [] as unknown[], closed: false, drop: () => { socket.readyState = 3; closes.forEach((h) => h(1006)); } };
    const socket = { readyState: 1, on: (_e: 'close', h: (c: number) => void) => closes.push(h) };
    all.push(rec);
    return {
      socket,
      send: (e: unknown) => { rec.sent.push(e); setTimeout(() => events.forEach((h) => h({ type: 'session.closed' })), 0); },
      on: ((name: string, h: (e: unknown) => void) => { if (name === 'event') events.push(h); }) as never,
      close: () => { rec.closed = true; },
    } as unknown as SidebandSocket;
  };
  return { all, open };
}
