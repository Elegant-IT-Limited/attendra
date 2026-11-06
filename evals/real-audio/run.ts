// SPDX-License-Identifier: AGPL-3.0-only
// The real-audio harness (batch 1a): real browser test calls with a voiced caller, on a running Attendra dashboard.
//   pnpm --filter @attendra/evals real-audio -- [--base http://localhost:3000] [--login "Vet clinic manager"] [--only id,id]
//     [--engine gpt-realtime] [--scenarios real-audio/scenarios.yaml] [--headed]
// Needs OPENAI_API_KEY (the caller's voice and, without fixed lines, the model playing the caller) and a dashboard whose
// voice service has its own key. Places real, billed test calls: about a minute each. Writes
// evals/reports/real-audio-<UTC start>.md and .json. Made-up callers only; a browser test call never texts anyone.
import { chromium, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { parse } from 'yaml';
import { type CallResult, judgeWords, QUIET_MS, type RealAudioScenario, RealAudioFile, report, SILENCE_LEVEL, STALL_MS, type Turn } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const base = flag('--base', 'http://localhost:3000')!;
const login = flag('--login', 'Vet clinic manager')!;
const file = RealAudioFile.parse(parse(readFileSync(join(here, '..', flag('--scenarios', 'real-audio/scenarios.yaml')!), 'utf8')));
const only = flag('--only')?.split(',');
const scenarios = file.scenarios.filter((s) => !only || only.includes(s.id));
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required: the caller\'s voice is made with it');
const openai = new OpenAI();
const callerModel = process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna';
const cache = join(here, '.cache');
mkdirSync(cache, { recursive: true });

/** The caller's line as audio (WAV), made once per line and voice and kept in .cache. */
async function voice(text: string, lang: 'en' | 'es'): Promise<string> {
  const key = createHash('sha256').update(`${file.voice}|${lang}|${text}`).digest('hex').slice(0, 24);
  const path = join(cache, `${key}.wav`);
  if (!existsSync(path)) {
    const res = await openai.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: file.voice, input: text, response_format: 'wav', instructions: lang === 'es' ? 'Speak natural Latin American Spanish, like a pet owner on the phone.' : 'Speak naturally, like a pet owner on the phone.' });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(path).toString('base64');
}

/** The caller's next line from a model playing them, from what was said and what they know. Null: they are done. */
async function nextLine(s: RealAudioScenario, said: { who: 'caller' | 'assistant'; text: string }[]): Promise<string | null> {
  const res = await openai.responses.create({
    model: callerModel, store: false, max_output_tokens: 800,
    instructions: [
      `You are a caller testing a veterinary clinic's phone assistant, in ${s.language === 'es' ? 'Spanish' : 'English'}. Stay in character.`,
      `The situation: ${s.title}`, `What you know: ${s.facts || 'only what you already said'}`,
      'Answer the assistant\'s last words in one short line, as people talk on the phone, using only what you know. If it reads back what you asked for, say yes.',
      'When your request is done, or the assistant says someone will call you back, say thanks and goodbye and end the line with [HANGUP].',
    ].join('\n'),
    input: said.map((l) => `${l.who === 'caller' ? 'You' : 'Assistant'}: ${l.text}`).join('\n'),
  }, { timeout: 20_000, maxRetries: 1 });
  const text = (res.output_text ?? '').trim();
  if (!text) return null;
  return text.includes('[HANGUP]') ? `${text.replace('[HANGUP]', '').trim()}\u0000` : text;
}

/**
 * In the page, before it loads: the microphone is an audio graph the harness plays lines into, the assistant's audio is
 * measured (its level, 20 times a second), and the call's captions are kept, all where the harness can read them.
 */
const INIT = `(() => {
  const ctx = new AudioContext();
  const mic = ctx.createMediaStreamDestination();
  window.__levels = []; window.__captions = []; window.__playing = false;
  navigator.mediaDevices.getUserMedia = async () => mic.stream;
  window.__say = async (b64) => {
    await ctx.resume();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(mic);
    window.__playing = true;
    const started = Date.now();
    await new Promise((r) => { src.onended = r; src.start(); });
    window.__playing = false;
    return { started, ended: Date.now() };
  };
  const Peer = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new Peer(...a);
    pc.addEventListener('track', (e) => {
      const stream = e.streams[0]; if (!stream) return;
      const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
      const data = new Float32Array(an.fftSize);
      setInterval(() => { an.getFloatTimeDomainData(data); let s = 0; for (const v of data) s += v * v; window.__levels.push([Date.now(), Math.sqrt(s / data.length)]); if (window.__levels.length > 12000) window.__levels.splice(0, 2000); }, 50);
    });
    const make = pc.createDataChannel.bind(pc);
    pc.createDataChannel = (...c) => {
      const ch = make(...c);
      ch.addEventListener('message', (m) => { try { const e = JSON.parse(m.data); const t = e.type || '';
        if ((t === 'session.output_transcript.delta' || t === 'response.output_audio_transcript.delta') && e.delta) window.__captions.push(['agent', e.delta, Date.now()]);
        if ((t === 'session.input_transcript.delta' || t === 'conversation.item.input_audio_transcription.completed') && (e.delta || e.transcript)) window.__captions.push(['caller', e.delta || e.transcript, Date.now()]);
      } catch {} });
      return ch;
    };
    return pc;
  };
  window.RTCPeerConnection.prototype = Peer.prototype;
})();`;

type Level = [number, number];
/** The page's global object, as the init script fills it (this file runs in Node; the callbacks below run in the page). */
declare const window: { __levels: Level[]; __captions: [string, string, number][]; __say(b64: string): Promise<{ started: number; ended: number }> };
const levels = (page: Page, since: number) => page.evaluate((t) => window.__levels.filter((l) => l[0] >= t), since);
const agentSince = (page: Page, since: number, until = Number.POSITIVE_INFINITY) => page.evaluate(([a, b]) => window.__captions
  .filter((c) => c[0] === 'agent' && c[2] >= a && c[2] < b).map((c) => c[1]).join(''), [since, until] as const);

/** Waits for the assistant's next turn: the first sound after `from`, then QUIET_MS of quiet. */
async function awaitReply(page: Page, from: number, maxMs = 25_000): Promise<{ heardAt: number | null; stalled: boolean }> {
  const deadline = from + maxMs;
  let heardAt: number | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(150);
    const ls = await levels(page, from);
    if (heardAt === null) heardAt = ls.find((l) => l[1] > SILENCE_LEVEL)?.[0] ?? null;
    if (heardAt !== null) {
      const last = [...ls].reverse().find((l) => l[1] > SILENCE_LEVEL)?.[0] ?? heardAt;
      if (Date.now() - last >= QUIET_MS) return { heardAt, stalled: heardAt - from > STALL_MS };
    }
  }
  return { heardAt, stalled: true };
}

async function runOne(page: Page, s: RealAudioScenario, clinicPath: string): Promise<CallResult> {
  const result: CallResult = { scenario: s.id, engine: flag('--engine') ?? null, callId: null, firstAudioMs: null, turns: [], stalls: 0, fillerLines: 0, repeatedQuestions: 0, missing: [], forbidden: [], ended: 'harness' };
  page.on('response', async (r) => { if (r.url().endsWith('/test-calls') && r.request().method() === 'POST') result.callId = ((await r.json().catch(() => ({}))) as { callId?: string }).callId ?? null; });
  await page.goto(`${base}${clinicPath}/test-call`);
  const clicked = Date.now();
  await page.getByRole('button', { name: 'Start test call' }).click();
  const greeting = await awaitReply(page, clicked, 20_000);
  if (greeting.heardAt === null) return { ...result, ended: 'failed', error: 'the assistant never spoke' };
  result.firstAudioMs = greeting.heardAt - clicked;
  const said: { who: 'caller' | 'assistant'; text: string }[] = [{ who: 'assistant', text: await agentSince(page, clicked) }];
  let line: string | null = s.opening;
  for (let i = 0; line && i < s.maxTurns; i++) {
    const done = line.endsWith('\u0000');
    const text = line.replace('\u0000', '');
    const { started, ended } = await page.evaluate((b64) => window.__say(b64), await voice(text, s.language));
    // the assistant talking over the caller: its audio during their line, after the first half second
    const overlapped = (await levels(page, started + 500)).some((l) => l[0] < ended && l[1] > SILENCE_LEVEL);
    said.push({ who: 'caller', text });
    if (done) { result.ended = 'caller'; break; }
    const reply = await awaitReply(page, ended);
    if (reply.stalled) result.stalls++;
    const agent = await agentSince(page, ended);
    result.turns.push({ caller: text, callerEndAt: ended, heardAt: reply.heardAt, overlapped, agent } satisfies Turn);
    said.push({ who: 'assistant', text: agent });
    if (!(await page.getByRole('button', { name: 'End call' }).isVisible())) { result.ended = 'assistant'; break; }
    line = s.lines ? (s.lines[i] ?? null) : await nextLine(s, said);
  }
  if (await page.getByRole('button', { name: 'End call' }).isVisible()) await page.getByRole('button', { name: 'End call' }).click();
  await page.waitForTimeout(2000);
  Object.assign(result, judgeWords(s, said.filter((l) => l.who === 'assistant').map((l) => l.text)));
  return result;
}

const startedAt = new Date();
const browser = await chromium.launch({ headless: !args.includes('--headed'), args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
const context = await browser.newContext({ permissions: ['microphone'] });
await context.addInitScript(INIT);
const page = await context.newPage();
await page.goto(`${base}/sign-in`);
await page.getByRole('button', { name: login, exact: true }).click();
await page.waitForURL(/\/c\/[^/]+$/);
const clinicPath = new URL(page.url()).pathname;
const results: CallResult[] = [];
for (const s of scenarios) {
  const p = await context.newPage();
  try { results.push(await runOne(p, s, clinicPath)); } catch (err) { results.push({ scenario: s.id, engine: null, callId: null, firstAudioMs: null, turns: [], stalls: 0, fillerLines: 0, repeatedQuestions: 0, missing: [], forbidden: [], ended: 'failed', error: (err as Error).message.slice(0, 120) }); }
  await p.close();
  console.log(`${s.id}: ${results.at(-1)!.ended}`);
}
await browser.close();
const out = join(here, '..', 'reports');
mkdirSync(out, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
writeFileSync(join(out, `real-audio-${stamp}.md`), `${report(results, { startedAt, base, clinic: clinicPath, engine: flag('--engine') ?? null })}\n`);
writeFileSync(join(out, `real-audio-${stamp}.json`), `${JSON.stringify({ startedAt, base, results: results.map((r) => ({ ...r, turns: r.turns.map((t) => ({ ...t, caller: undefined, agent: undefined })) })) }, null, 2)}\n`);
console.log(`report: evals/reports/real-audio-${stamp}.md`);
