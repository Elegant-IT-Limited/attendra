// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What a path A call costs, worked out offline (batch 1d): no API call, no audio. Every scripted scenario is run as
 * usual (scripted planner, in-process Postgres); its turns and tool results are then laid out the way gpt-realtime
 * would see them on a phone call, request by request, and counted with the o200k tokenizer. Two layouts are compared:
 *
 * - before: the batch 1c layout (the caller ID in the instructions, a dated turn note removed and added again every
 *   turn, word-for-word lines as the reply's own instructions, full tool schemas, no truncation);
 * - after: the batch 1d layout (the same instructions and tools on every call, the call's facts once at the start, the
 *   same short turn note kept, word-for-word lines as a note, compact schemas, call-state notes, truncation).
 *
 * The prompt cache is modelled as OpenAI documents it: a request reuses the longest prefix it shares with an earlier
 * request of the call, from 1,024 tokens up, in steps of 128. Audio is counted from the words: speech at 150 words a
 * minute, 10 audio tokens a second for the caller and 20 for the voice (OpenAI's rates for its realtime audio). These
 * are estimates for comparing the two layouts, not a bill; the real figure comes from call_costs on real calls.
 *
 *   pnpm --filter @attendra/evals exec tsx scripts/path-a-cost.ts [--only=id,id] [--tag=tag] [--json=out.json]
 */
import { shapeForVoice, voiceToolDefinitions } from '@attendra/agent';
import { CALL_RATES, type ClinicConfig, localDateOf, PACKS } from '@attendra/core';
import { callFacts, REALTIME_TOOLS_LINES, realtimeTools, sayToolQuestion, toolQuestion, toolRefusalLine, toolsVoicePrompt, toolsVoiceStaticPrompt, TOOLS_TRUNCATION, TURN_NOTE } from '@attendra/voice-engine';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { writeFileSync } from 'node:fs';
import { loadScenarios } from '../src/scenario';
import { clinicOf, runScenario } from '../src/simulator';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('only');
const tag = arg('tag');

// ---- the model of speech and audio tokens ----------------------------------------------------------------------
const WORDS_PER_SECOND = 150 / 60;
const CALLER_AUDIO_PER_S = 10;
const VOICE_AUDIO_PER_S = 20;
/**
 * Around each caller turn: the end-of-turn pause the VAD keeps, and the time from the caller's last word to the next
 * caller turn that is no one's speech (the reply heard at 3.0 s median in the batch 1b voiced runs, then half a second
 * before the caller answers). It sets the minutes, so the $/min; the $ per call does not depend on it.
 */
const CALLER_PAD_S = 0.5;
const TURN_GAP_S = 3.5;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const speechSeconds = (t: string) => words(t) / WORDS_PER_SECOND;
const tok = (t: string) => encode(t).length;

// ---- the two layouts -----------------------------------------------------------------------------------------------
/** Batch 1c's per-turn note (dated) and word-for-word wording, as they were. */
const OLD_TURN_NOTE = 'Reply to the caller now. If you need a tool, call it as the very first thing in your reply, with no words before it: never "let me...", "let\'s...", "okay, let me get that set up", "one moment", or anything about what you are about to do, in any language. When its result comes, say what it gives you, in the caller\'s language. Ask the caller only what a tool\'s result tells you to ask, or a detail a tool needs that they have not given; never a question of your own.';
const oldTurnNote = (clinic: ClinicConfig, now: Date) => { const today = localDateOf(now, clinic.timezone); return `${OLD_TURN_NOTE} Today at the clinic is ${PACKS.en.fullDay(today)} (${today}): a day the caller names ("Thursday", "tomorrow") is counted from it, and its date comes from clinic_now's days list.`; };
const oldTools = (clinic: ClinicConfig) => voiceToolDefinitions(clinic).map(({ type, name, description, parameters }) => ({ type, name, description, parameters }));
/** The tools the voice needs before anyone is found (an option measured, not used: see the report). */
const AFTER_FOUND = new Set(['propose_booking', 'commit_pending', 'propose_cancellation', 'list_appointments', 'visit_summary']);

interface Layout {
  name: string;
  /** The same instructions and tools on every call (the caller ID moved out of them). */
  staticPrefix: boolean;
  /** The turn note: removed and added again each turn (old), or the same short one kept. */
  keepNote: boolean;
  /** Word-for-word lines as a note in the conversation, not the reply's own instructions. */
  wordsAsNote: boolean;
  compactTools: boolean;
  stateNotes: boolean;
  truncation: boolean;
  /** Only the tools before a pet is found, then all of them (one session.update). */
  stageTools?: boolean;
  /** The clinic's last call was within the cache's life: its instructions and tools are still cached. */
  crossCall?: boolean;
}
const BEFORE: Layout = { name: 'before (batch 1c)', staticPrefix: false, keepNote: false, wordsAsNote: false, compactTools: false, stateNotes: false, truncation: false };
const AFTER: Layout = { name: 'after (batch 1d)', staticPrefix: true, keepNote: true, wordsAsNote: true, compactTools: true, stateNotes: true, truncation: true };
const LAYOUTS: Layout[] = [
  BEFORE,
  { ...BEFORE, name: '+ static prefix, facts once', staticPrefix: true },
  { ...BEFORE, name: '+ turn note kept', keepNote: true },
  { ...BEFORE, name: '+ word-for-word as a note', wordsAsNote: true },
  { ...BEFORE, name: '+ compact tool schemas', compactTools: true },
  AFTER,
  { ...AFTER, name: 'after, tools by stage', stageTools: true },
  { ...BEFORE, name: 'before, calls back to back', crossCall: true },
  { ...AFTER, name: 'after, calls back to back', crossCall: true },
];
/** Each clinic's last call's instructions and tools, for calls that come within the cache's life. */
const lastPrefix = new Map<string, Seg[]>();

// ---- one request's prompt as segments, and the cache --------------------------------------------------------------
type Kind = 'text' | 'audio';
interface Seg { key: string; tokens: number; kind: Kind }
interface Usage { textIn: number; textCached: number; audioIn: number; audioCached: number; textOut: number; audioOut: number }
const zero = (): Usage => ({ textIn: 0, textCached: 0, audioIn: 0, audioCached: 0, textOut: 0, audioOut: 0 });
const add = (a: Usage, b: Usage) => { for (const k of Object.keys(a) as (keyof Usage)[]) a[k] += b[k]; return a; };

/** How much of a prompt the cache holds: the longest prefix it shares with an earlier prompt, from 1,024 tokens in 128s. */
function cachedPrefix(prompt: Seg[], earlier: Seg[][]): number {
  let best = 0;
  for (const e of earlier) {
    let n = 0;
    for (let i = 0; i < Math.min(e.length, prompt.length) && e[i]!.key === prompt[i]!.key; i++) n += prompt[i]!.tokens;
    best = Math.max(best, n);
  }
  return best < 1024 ? 0 : 1024 + Math.floor((best - 1024) / 128) * 128;
}

function bill(prompt: Seg[], earlier: Seg[][]): Usage {
  const u = zero();
  let cached = cachedPrefix(prompt, earlier);
  for (const s of prompt) {
    const c = Math.min(cached, s.tokens);
    cached -= c;
    if (s.kind === 'text') { u.textIn += s.tokens; u.textCached += c; } else { u.audioIn += s.tokens; u.audioCached += c; }
  }
  return u;
}

interface Turn { caller: string; calls: { tool: string; args: unknown; data: Record<string, unknown> }[]; reply: string }

/** One call laid out as gpt-realtime sees it, request by request. */
function simulate(layout: Layout, clinic: ClinicConfig, now: Date, callerNumber: string | null, greeting: string, turns: Turn[]) {
  // callers differ from call to call: the old instructions carried each one's number
  const instructions = layout.staticPrefix ? [toolsVoiceStaticPrompt(clinic), ...REALTIME_TOOLS_LINES].join('\n') : [toolsVoicePrompt(clinic, { callerNumber }), ...REALTIME_TOOLS_LINES].join('\n');
  const toolsAll = layout.compactTools ? realtimeTools(clinic) : oldTools(clinic);
  const toolsEarly = toolsAll.filter((t) => !AFTER_FOUND.has(t.name));
  // the prefix is keyed by content: the same text on two calls is the same key (the cache across calls)
  const instr: Seg = { key: `instr:${instructions}`, tokens: tok(instructions), kind: 'text' };
  const toolSeg = (list: typeof toolsAll): Seg => { const j = JSON.stringify(list); return { key: `tools:${j}`, tokens: tok(j), kind: 'text' }; };
  let tools = toolSeg(layout.stageTools ? toolsEarly : toolsAll);
  const conv: Seg[] = [];
  let n = 0;
  const item = (tokens: number, kind: Kind, label = 'item'): Seg => ({ key: `${label}:${n++}`, tokens, kind });
  const usage = zero();
  const prompts: Seg[][] = [];
  const prior = layout.crossCall ? lastPrefix.get(`${layout.name}:${clinic.id}`) : undefined;
  if (prior) prompts.push(prior);
  if (layout.crossCall) lastPrefix.set(`${layout.name}:${clinic.id}`, [instr, tools]);
  let requests = 0;
  const request = (override?: string) => {
    const prompt = override ? [{ key: `override:${override}`, tokens: tok(override), kind: 'text' as const }, tools, ...conv] : [instr, tools, ...conv];
    add(usage, bill(prompt, prompts));
    prompts.push(prompt);
    requests++;
  };
  const truncate = () => {
    if (!layout.truncation) return;
    const total = conv.reduce((a, s) => a + s.tokens, 0);
    if (total <= TOOLS_TRUNCATION.token_limits.post_instructions) return;
    const keep = TOOLS_TRUNCATION.token_limits.post_instructions * TOOLS_TRUNCATION.retention_ratio;
    let sum = total;
    while (conv.length > 1 && sum > keep) sum -= conv.shift()!.tokens;
  };

  // the greeting: its own short instructions (the opening), no tools; then it is in the conversation as audio
  if (layout.staticPrefix) conv.push(item(tok(callFacts(clinic, now, callerNumber)), 'text', 'facts'));
  const greetSeconds = speechSeconds(greeting);
  usage.audioOut += Math.round(greetSeconds * VOICE_AUDIO_PER_S); usage.textOut += tok(greeting);
  requests++; // the greeting's prompt is short and the same each call: counted as output only
  conv.push(item(Math.round(greetSeconds * VOICE_AUDIO_PER_S), 'audio'));
  let seconds = greetSeconds;
  let noteAt = -1;
  let found = false;
  let lastState = '';
  for (const t of turns) {
    const callerSeconds = speechSeconds(t.caller) + CALLER_PAD_S;
    seconds += callerSeconds + TURN_GAP_S;
    conv.push(item(Math.round(callerSeconds * CALLER_AUDIO_PER_S), 'audio'));
    if (layout.keepNote) conv.push(item(tok(TURN_NOTE), 'text', 'note'));
    else {
      if (noteAt >= 0) conv.splice(noteAt, 1);
      noteAt = conv.length;
      conv.push(item(tok(oldTurnNote(clinic, now)), 'text', 'note'));
    }
    truncate();
    // each tool call is one model round: the call is its output, the result goes in, the model goes on
    let words: string | null = null;
    for (const c of t.calls) {
      request();
      const argsText = JSON.stringify(c.args ?? {});
      usage.textOut += tok(argsText) + 8;
      conv.push(item(tok(argsText) + 8, 'text'));
      const ok = !c.data.error;
      const out = JSON.stringify(shapeForVoice(c.tool, { ok, data: c.data }, 'idle', null));
      conv.push(item(tok(out), 'text'));
      words = toolQuestion(out) ?? toolRefusalLine(out) ?? words;
      if (layout.stageTools && !found && c.tool === 'verify_caller' && ok && c.data.verified) { found = true; tools = toolSeg(toolsAll); }
      if (layout.stateNotes) {
        const state = `${found || (c.tool === 'verify_caller' && ok) ? 'found' : ''}|${c.tool === 'propose_booking' && ok ? 'pending' : ''}|${c.tool === 'commit_pending' && ok ? 'done' : ''}`;
        if (state !== '||' && state !== lastState) { lastState = state; conv.push(item(30, 'text', 'state')); }
      }
    }
    // the reply the caller hears: a tool's words said as written (override or note), or the model's own
    if (words && layout.wordsAsNote) { conv.push(item(tok(sayToolQuestion(words)), 'text', 'note')); request(); }
    else if (words) request(sayToolQuestion(words));
    else request();
    const replySeconds = speechSeconds(t.reply);
    seconds += replySeconds;
    usage.audioOut += Math.round(replySeconds * VOICE_AUDIO_PER_S); usage.textOut += tok(t.reply);
    conv.push(item(Math.round(replySeconds * VOICE_AUDIO_PER_S), 'audio'));
  }
  return { usage, seconds, requests, staticTokens: instr.tokens + toolSeg(toolsAll).tokens };
}

const RATES = { full: ['gpt-realtime-2.1:text', 'gpt-realtime-2.1:audio'], mini: ['gpt-realtime-2.1-mini:text', 'gpt-realtime-2.1-mini:audio'] } as const;
function dollars(u: Usage, model: keyof typeof RATES): number {
  const [t, a] = RATES[model].map((m) => CALL_RATES.modelsPerMTok[m]!);
  return ((u.textIn - u.textCached) * t!.input + u.textCached * t!.cached + u.textOut * t!.output
    + (u.audioIn - u.audioCached) * a!.input + u.audioCached * a!.cached + u.audioOut * a!.output) / 1e6;
}
/** The caller's words transcribed (gpt-4o-transcribe), about $0.006 a minute of their speech. */
const TRANSCRIBE_PER_MIN = 0.006;

// ---- run --------------------------------------------------------------------------------------------------------
const scenarios = loadScenarios().filter((s) => (!only || only.split(',').some((o) => o && s.id.includes(o))) && (!tag || s.tags.includes(tag)));
const perLayout = LAYOUTS.map(() => ({ usage: zero(), seconds: 0, requests: 0, calls: 0, callerSeconds: 0 }));
let staticBefore = 0;
let calls = 0;
let staticAfter = 0;
for (const s of scenarios) {
  const r = await runScenario(s);
  const clinic = clinicOf(s);
  const now = new Date('2026-09-28T16:00:00Z');
  const caller = s.caller_number === undefined ? null : s.caller_number;
  // the call as turns: each caller line, the tools its turn ran, and what the voice said after it
  const turns: Turn[] = [];
  let callerTurn = 0;
  for (const line of r.transcript.slice(1)) {
    if (line.speaker === 'caller') { callerTurn++; turns.push({ caller: line.text, calls: r.calls.filter((c) => c.turn === callerTurn), reply: '' }); }
    else if (line.speaker === 'assistant' && turns.length) turns.at(-1)!.reply = `${turns.at(-1)!.reply} ${line.text}`.trim();
  }
  if (!turns.length) continue;
  const number = caller === null ? null : `+1303555${String(1000 + (calls++ % 9000)).padStart(4, '0')}`;
  LAYOUTS.forEach((layout, i) => {
    const out = simulate(layout, clinic, now, number, r.transcript[0]?.text ?? clinic.greeting, turns);
    const p = perLayout[i]!;
    add(p.usage, out.usage); p.seconds += out.seconds; p.requests += out.requests; p.calls++;
    p.callerSeconds += turns.reduce((a, t) => a + speechSeconds(t.caller) + CALLER_PAD_S, 0);
    if (layout === BEFORE) staticBefore = Math.max(staticBefore, out.staticTokens);
    if (layout === AFTER) staticAfter = Math.max(staticAfter, out.staticTokens);
  });
}

const rows = LAYOUTS.map((layout, i) => {
  const p = perLayout[i]!;
  const minutes = p.seconds / 60;
  const transcribe = (p.callerSeconds / 60) * TRANSCRIBE_PER_MIN;
  const full = dollars(p.usage, 'full') + transcribe;
  const mini = dollars(p.usage, 'mini') + transcribe;
  const perCall = (x: number) => Math.round(x / p.calls);
  return {
    layout: layout.name, calls: p.calls, minutesPerCall: +(minutes / p.calls).toFixed(2), requestsPerCall: +(p.requests / p.calls).toFixed(1),
    inputPerCall: perCall(p.usage.textIn + p.usage.audioIn), cachedShare: +((p.usage.textCached + p.usage.audioCached) / (p.usage.textIn + p.usage.audioIn)).toFixed(3),
    textInPerCall: perCall(p.usage.textIn), audioInPerCall: perCall(p.usage.audioIn), outPerCall: perCall(p.usage.textOut + p.usage.audioOut),
    perCallUsd: +(full / p.calls).toFixed(4), perMinUsd: +(full / minutes).toFixed(4), miniPerMinUsd: +(mini / minutes).toFixed(4),
  };
});
console.log(`path A cost, offline: ${scenarios.length} scripted scenarios; instructions + tools ${staticBefore} tokens before, ${staticAfter} after`);
console.table(rows);
// where the money goes, per call, before and after (gpt-realtime-2.1)
const [t, a] = RATES.full.map((m) => CALL_RATES.modelsPerMTok[m]!);
const buckets = (u: Usage, calls: number) => Object.fromEntries(Object.entries({
  'text in, new': (u.textIn - u.textCached) * t!.input, 'text in, cached': u.textCached * t!.cached, 'text out': u.textOut * t!.output,
  'audio in, new': (u.audioIn - u.audioCached) * a!.input, 'audio in, cached': u.audioCached * a!.cached, 'audio out': u.audioOut * a!.output,
}).map(([k, v]) => [k, +(v / 1e6 / calls).toFixed(4)]));
const breakdown = { before: buckets(perLayout[0]!.usage, perLayout[0]!.calls), after: buckets(perLayout[LAYOUTS.indexOf(AFTER)]!.usage, perLayout[0]!.calls) };
console.table(breakdown);
const json = arg('json');
if (json) writeFileSync(json, JSON.stringify({ scenarios: scenarios.length, staticBefore, staticAfter, rows, breakdown, assumptions: { WORDS_PER_SECOND, CALLER_AUDIO_PER_S, VOICE_AUDIO_PER_S, CALLER_PAD_S, TURN_GAP_S, TRANSCRIBE_PER_MIN, truncation: TOOLS_TRUNCATION, rates: CALL_RATES.version } }, null, 1));
process.exit(0);
