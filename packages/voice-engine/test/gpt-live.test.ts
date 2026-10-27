import { DEMO_CLINIC, zonedInstant } from '@attendra/core';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_DATA_CHANNEL, callerContext, GptLiveEngine, noCallerIdLine, pausedOpening, type SidebandSocket, vipOpening } from '../src';

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
    const { client: channel, instructions, ...shared } = web.session;
    const { type, instructions: sipInstructions, ...sipShared } = sip;
    expect(type).toBe('live');
    expect(shared).toEqual(sipShared);
    // the same prompt, and one line more: a browser call has no caller ID, so the best number is asked once
    expect(instructions).toBe(`${String(sipInstructions)}\n${noCallerIdLine(DEMO_CLINIC)}`);
    expect(instructions).toContain('"What\'s the best number to reach you?" or "¿Cuál es el mejor número para comunicarnos con usted?"');
    expect(sipInstructions).not.toContain('there is no caller ID');
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
    // by the time the sideband attaches the greeting may be under way, or the caller may have spoken over it: never again from the top
    const again = (appends[0] as { content: string }).content;
    expect(again).toMatch(/^Only if you have not started speaking yet and the caller has not said anything: /);
    expect(again).toContain(`Say exactly: "${DEMO_CLINIC.greeting}"`);
    expect(again).toContain('do not greet again and do not start over: answer what the caller said');
  });

  it('greets a VIP by name and says they are being put through, with no question first', async () => {
    const { client, sessions } = fakeClient();
    const engine = new GptLiveEngine(client, 'gpt-live-1', fakeSockets().open);
    await engine.accept('live_vip', DEMO_CLINIC, NOW, vipOpening(DEMO_CLINIC, 'Jamie Cole'));
    const text = (sessions.accept.mock.calls[0] as unknown as [string, { session: { input: { content: { text: string }[] }[] } }])[1].session.input[0]!.content[0]!.text;
    expect(text).toContain(`Hi Jamie, thanks for calling ${DEMO_CLINIC.name}.`);
    expect(text).toContain("AI assistant. I'm connecting you with our team now.");
    expect(text).not.toContain(DEMO_CLINIC.greeting);
    expect(text).toContain('do not ask how you can help');
  });

  it('greets a VIP in Spanish at a Spanish clinic, with the AI disclosure and no question', () => {
    const es = vipOpening({ ...DEMO_CLINIC, primaryLanguage: 'es' }, 'Carmen Ruiz');
    expect(es).toContain(`Hola Carmen, gracias por llamar a ${DEMO_CLINIC.name}.`);
    expect(es).toContain('asistente de IA de la clínica. Le comunico con nuestro equipo ahora mismo.');
    expect(es).not.toContain('Hi Carmen');
  });

  it('while the assistant is paused: says it is an AI assistant, then puts the caller through or says when to call back and where to go in an emergency', () => {
    const through = pausedOpening(DEMO_CLINIC, true);
    expect(through).toContain("the clinic's AI assistant");
    expect(through).toContain("I'm connecting you with our team now.");
    const back = pausedOpening({ ...DEMO_CLINIC, industry: 'vet', emergencyHospital: { name: 'Front Range Animal ER', phone: '+13035550199', address: '1 Main St, Denver CO' } }, false);
    expect(back).toContain('Please call back during our opening hours.');
    expect(back).toContain('Front Range Animal ER');
    expect(back).not.toContain('connecting you');
    expect(pausedOpening({ ...DEMO_CLINIC, industry: 'vet', emergencyHospital: undefined }, false)).toContain('nearest 24-hour emergency vet');
    expect(pausedOpening({ ...DEMO_CLINIC, primaryLanguage: 'es' }, true)).toContain('Le comunico con nuestro equipo');
    const esBack = pausedOpening({ ...DEMO_CLINIC, primaryLanguage: 'es', industry: 'vet', emergencyHospital: { name: 'Front Range Animal ER', phone: '+13035550199', address: '1 Main St, Denver CO' } }, false);
    expect(esBack).toContain('Por favor, vuelva a llamar en nuestro horario de atención.');
    expect(esBack).toContain('llame a Front Range Animal ER');
    expect(esBack).not.toContain('Please call back');
  });

  it('tells the voice what caller ID would show: the call count and the one name on file, never the calls\' content', () => {
    expect(callerContext(null)).toBeNull();
    const known = callerContext('Name on file for this number: Sam.\nCalls from this number in the last 30 days: 5.\n2026-10-24T13:20:00.000Z: Booked a check-up for Scout.')!;
    expect(known).toContain('it called 5 times in the last 30 days');
    expect(known).toContain('"Am I speaking with Sam?"');
    expect(known).toContain('"¿Hablo con Sam?"');
    expect(known).toContain('Never say you have no history');
    expect(known).not.toContain('Scout');
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
    // a browser session has its opening in its input from creation: nothing is appended when the sideband attaches
    expect(sockets.all[0]!.sent).toEqual([{ type: 'session.close' }]);

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
  type Rec = { sent: unknown[]; closed: boolean; drop: () => void; emit: (name: string, arg?: unknown) => void; opened: () => void };
  const all: Rec[] = [];
  const open = (): SidebandSocket => {
    const handlers = new Map<string, ((e: unknown) => void)[]>();
    const opens: (() => void)[] = [];
    const emit = (name: string, arg?: unknown) => (handlers.get(name) ?? []).forEach((h) => h(arg));
    // the SDK's close: for good, once any reconnecting is over
    const rec: Rec = { sent: [], closed: false, drop: () => { socket.readyState = 3; emit('close', 1006); }, emit, opened: () => opens.forEach((h) => h()) };
    const socket = { readyState: 1, on: (_e: 'open', h: () => void) => opens.push(h) };
    all.push(rec);
    return {
      socket,
      send: (e: unknown) => { rec.sent.push(e); setTimeout(() => emit('event', { type: 'session.closed' }), 0); },
      on: ((name: string, h: (e: unknown) => void) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); }) as never,
      close: () => { rec.closed = true; },
    } as unknown as SidebandSocket;
  };
  return { all, open };
}
