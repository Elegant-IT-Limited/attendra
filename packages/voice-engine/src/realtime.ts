// SPDX-License-Identifier: AGPL-3.0-only
import { voiceToolDefinitions } from '@attendra/agent';
import { type ClinicConfig, DEFAULT_VOICE, industryPack, REALTIME_VOICES, type VoiceFlow } from '@attendra/core';
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type { CallOptions, Sideband, SidebandCommand, SidebandEvent, VoiceEngine } from './engine';
import { conversationPrompt, openingInstruction } from './prompt';
import { callFacts, toolsVoiceStaticPrompt } from './tools-prompt';

/**
 * The one tool the Realtime model has: ask our backend. It is the same hand-off GPT-Live
 * makes with client delegation, so the backend (identity checks, booking rules,
 * confirmations, texts, transfers) is exactly the same whichever engine answers.
 */
export const ASK_BACKEND = {
  type: 'function' as const,
  name: 'ask_backend',
  description: 'Hand the caller\'s request to the clinic\'s backend, which checks records, finds times, books, texts, transfers and ends calls. Use it for anything about appointments, the caller\'s identity, refills, callbacks, transfers, the clinic\'s staff or facts, texts, or ending the call. Then say what it returns, in your own words, and nothing it did not return.',
  parameters: { type: 'object', properties: { request: { type: 'string', description: 'What the caller wants, in a few words.' } }, required: ['request'], additionalProperties: false },
};

/** What the Realtime model is told on top of the conversation prompt both engines share. */
const REALTIME_LINES = [
  'Whenever the instructions say to delegate to the backend or to wait for the backend, call ask_backend and wait for its result.',
  'You know nothing about this clinic, its staff, its times or its callers except what these instructions say and what ask_backend returns. Never invent a time, a name, a price or a fact.',
  'ask_backend is part of you, not someone else: never mention a backend or a system, never say you are asking or checking with anyone, and never say someone could not hear the caller. Say "let me check", then give what it returns as your own words. A callback from the clinic\'s team is fine to offer.',
];

/** On the tools path the model calls our tools itself: what it is told on top of the tools prompt. */
export const REALTIME_TOOLS_LINES = [
  'Your tools are part of you, not someone else: never mention a tool, a backend or a system, and never say you are asking or checking with anyone.',
];

/**
 * The tools that only read (times, the clinic's facts and documents, a pet's visits, the clock): on the tools path they
 * run the moment the model calls them, without waiting for the caller's words to be transcribed (up to 3 s), since
 * nothing in them depends on those words. Everything else waits, so a yes or an emergency is heard before any write.
 */
const READS = new Set(['find_slots', 'get_clinic_info', 'search_knowledge', 'list_appointments', 'visit_summary', 'clinic_now']);

/**
 * The longest tool descriptions, said shorter for the voice of a vet clinic on path A (batch 1d, cost per call): every
 * rule is kept, only the wording is tighter. The planner path, which every clinic runs on, keeps the full wording.
 */
export const VET_VOICE_DESCRIPTIONS: Record<string, string> = {
  verify_caller: 'Find the pet before booking, changing or reading anything of theirs: the owner\'s first name (full if given), the pet\'s name, the phone number on file (null: the number they are calling from), and species if they said it ("my cat Mango"), else null. Call it again to switch pets. Owner known but not the pet: pet_name null (with caller ID it may return pets_on_number, the names to ask about). phone_last4: null, unless a tool asked for the last four digits on file; then those digits as said, with pet_name, and phone null.',
  register_patient: 'Add a new pet, when the caller says it is new (no lookup first: this checks it is not on file) or verify_caller found nothing and they say it is new. pet_name; owner_name only as they said it, else null (a tool asks for a name only when the number has none); species (dog, cat, rabbit...); sex (female, male or unknown); birthday_or_age as the owner said it, never with a year they did not say (a day and month alone is not a birthday: ask the age); phone (null: the number they are calling from). The pet is then found and can book.',
  get_clinic_info: 'Hours today and for 7 days, the vets (animals and services they see, weekly hours, time off, new patients, details such as qualifications), visit types, emergency hospitals, the clinic FAQ, and document passages when the FAQ has no answer. No identity needed.',
  find_slots: 'Up to 3 open slots, optionally with one vet (provider_id) or the vets for a kind of animal or service from get_clinic_info (specialty). No identity needed ("who is free Monday" before asking who they are). from_date: the first day asked for ("next week" is the coming Monday); null is today. from_time: the time named ("after 3" is 15:00, "at 10:30" is 10:30), else null; time_mode as said: at ("is 4 free?"), around ("around 5"), before ("earlier than 6"), after ("after 3") or earliest; the answer leads with that exact time, then the nearest on that side. propose_if_exact: true only for one exact day and time ("Thursday at 2:30") for a new booking by a caller already found: if free it is staged and its read-back spoken, so no propose_booking; if not, the nearest times come back. Never for a move; null before the pet is found.',
  send_text: 'Text the caller something they just heard: directions, hours, emergency_hospital, provider (ref: provider id), answer (ref: its source id) or link (ref: link id from get_clinic_info). Only when they asked for it or said yes to your offer: the first call gives the exact question; after a clear yes, call it again the same way. to: null for the number they are calling from.',
  clinic_now: 'The clinic\'s time, date and zone, whether it is open, when it closes or next opens, and whether a visit is booked now or taken as a request. Call it before saying anything about the time, the day, today\'s hours, or good morning/afternoon/evening after the greeting. Never say the clinic is open or closed without it.',
};

/** Our tools as the Realtime API takes them: function tools without `strict`, which it does not use, and compact schemas. */
export const realtimeTools = (clinic: ClinicConfig) => {
  const short = industryPack(clinic.industry).identity === 'pet' ? VET_VOICE_DESCRIPTIONS : {};
  return voiceToolDefinitions(clinic).map(({ type, name, description, parameters }) => ({ type, name, description: short[name] ?? description, parameters: compactSchema(parameters) as Record<string, unknown> }));
};

/**
 * A tool's JSON schema as the voice model reads it, without what only a validator needs: `$schema`, defaults and
 * length limits go, and a nullable string is one `type` list instead of an `anyOf`. Enums, patterns and descriptions
 * stay. The backend checks every call's arguments against the full schema anyway (runTool). About a third of the tool
 * definitions' tokens, on every reply of a call (batch 1d, cost per call).
 */
export function compactSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactSchema);
  if (!node || typeof node !== 'object') return node;
  const o = node as Record<string, unknown>;
  // { anyOf: [{ type: 'string', ... }, { type: 'null' }] } -> { type: ['string', 'null'], ... }
  if (Array.isArray(o.anyOf) && o.anyOf.length === 2 && o.anyOf.some((x) => (x as { type?: unknown }).type === 'null')) {
    const other = o.anyOf.find((x) => (x as { type?: unknown }).type !== 'null') as Record<string, unknown>;
    if (other && typeof other.type === 'string' && !other.anyOf) {
      const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'anyOf'));
      return compactSchema({ ...rest, ...other, type: [other.type, 'null'] });
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === '$schema' || k === 'default' || k === 'minLength' || k === 'maxLength' || k === 'minItems' || k === 'maxItems') continue;
    out[k] = compactSchema(v);
  }
  return out;
}

/**
 * How long the tools path's conversation may grow before its oldest turns go (after the instructions and tools): a
 * phone call of a few minutes stays under it; a long one drops back to 70%, so it is cut now and then, not on every
 * turn, and the prompt cache holds in between. What the call has done lives in the backend and in the call-state notes,
 * which are recent, so nothing the call needs is lost (batch 1d, cost per call).
 */
export const TOOLS_TRUNCATION = { type: 'retention_ratio' as const, retention_ratio: 0.7, token_limits: { post_instructions: 12_000 } };

/**
 * Manual replies (the tools path, once a pet is found): after a caller's turn the model waits for our go, so a lookup
 * their words ask for is run first and handed to it. If no go comes this long after the turn ended (the transcript
 * failed, say), it replies by itself: a caller is never left waiting on us.
 */
/** The model that writes down the caller's words on these calls. */
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

/** A Realtime reply's usage, as response.done reports it. */
interface RealtimeUsage {
  input_token_details?: { audio_tokens?: number; text_tokens?: number; cached_tokens_details?: { audio_tokens?: number; text_tokens?: number } };
  output_token_details?: { audio_tokens?: number; text_tokens?: number };
}

/** One reply's tokens, per modality (`<model>:audio`, `<model>:text`), for the call's cost. None when nothing was reported. */
export function replyUsage(model: string, u: RealtimeUsage | undefined): { model: string; input: number; cached: number; output: number }[] {
  if (!u) return [];
  const i = u.input_token_details ?? {};
  const c = i.cached_tokens_details ?? {};
  const o = u.output_token_details ?? {};
  return ([['audio', i.audio_tokens, c.audio_tokens, o.audio_tokens], ['text', i.text_tokens, c.text_tokens, o.text_tokens]] as const)
    .filter(([, input, , output]) => (input ?? 0) + (output ?? 0) > 0)
    .map(([kind, input, cached, output]) => ({ model: `${model}:${kind}`, input: input ?? 0, cached: cached ?? 0, output: output ?? 0 }));
}

/**
 * After each caller turn on the tools path: what to do with it. The voice says only what a tool gives it (batch 1b):
 * no words before a tool call ("let me check...", "one moment"), and no question of its own ("Is Clover new to us?").
 * The same short note every turn, added after the caller's words and never removed: removing the last one moved every
 * item after it, so the prompt cache missed the rest of the call on each turn (batch 1d). The date is in the call
 * facts, once.
 */
export const TURN_NOTE = 'Reply now. A tool you need is called first, with no words before it (never "let me...", "one moment"). Then say what it gives you, in the caller\'s language. Ask only what a tool result asks for, or a detail a tool needs.';
/**
 * A tool's own words that end in a question ("Dr. Rahman and Dr. Khan do dental care. Shall I look with them?", a
 * read-back's "Shall I book it?"): the next reply says them as written, and nothing else, then waits for the caller.
 * Left to the model, a live run paraphrased the offer and dropped the question (batch 1c).
 */
export function toolQuestion(output: string): string | null {
  try {
    const o = JSON.parse(output) as { spoken?: unknown };
    return typeof o.spoken === 'string' && /\?\s*$/.test(o.spoken) ? o.spoken.trim() : null;
  } catch { return null; }
}
export const sayToolQuestion = (line: string) => `Say exactly this to the caller next, word for word, in the language it is written in, with nothing before or after it: "${line}" Then stop and wait for their answer.`;

/** The slot search's reasons whose line is the answer: why the day or the vet asked for has nothing, in the backend's words. */
const REFUSAL_REASONS = new Set(['not_working_that_day', 'fully_booked', 'clinic_closed', 'notice', 'too_far_ahead']);
/**
 * A tool's refusal line, the answer in the backend's own words ("Dra. Mara Vance no trabaja los martes. Atiende los
 * viernes y los domingos."), from the result as the voice gets it (shapeForVoice: say_as is `spoken`, the reason is in
 * `data`): the slot search's words when they carry one of those reasons, or a refusal whose instruction is "Say, in
 * these words: ...". Left to the model, a live run paraphrased it (batch 1d).
 */
export function toolRefusalLine(output: string): string | null {
  try {
    const o = JSON.parse(output) as { ok?: unknown; spoken?: unknown; say?: unknown; data?: { reason?: unknown } };
    if (typeof o.spoken === 'string' && typeof o.data?.reason === 'string' && REFUSAL_REASONS.has(o.data.reason)) return o.spoken.trim();
    const quoted = o.ok === false && typeof o.say === 'string' ? /^Say, in these words: "([^"]+)"/.exec(o.say) : null;
    return quoted ? quoted[1]!.trim() : null;
  } catch { return null; }
}
export const sayToolLine = (line: string) => `In your next reply, say this line to the caller word for word, in the language it is written in: "${line}" Anything another tool result asked you to say first (the pet found, for one) comes before it; after it you may ask one short question for the next step (which time suits them, or another day or vet). Do not change its words, and call no tools in this reply.`;

/** What the next reply must say from the tools' results, if anything: a tool's own question wins over a refusal line. */
export function toolReplyInstructions(question: string | null, line: string | null): string | null {
  return question ? sayToolQuestion(question) : line ? sayToolLine(line) : null;
}

/** How the greeting is said, with the short instructions of the first reply (the session's tone lines are not in them). */
const GREETING_VOICE = 'Speak warmly and naturally, at an easy pace, like a friendly receptionist answering the phone.';
export const GO_WAIT_MS = 1200;
/**
 * Turn detection on the tools path: the turn ends once the caller has clearly finished, and the engine starts each reply
 * itself (at once, or after our go once replies are manual), so nothing about the session changes mid-call. The caller
 * talking over a reply still stops it.
 */
const TOOLS_TURNS = { type: 'semantic_vad' as const, eagerness: 'high' as const, create_response: false, interrupt_response: true };

/** The longest a reply waits for the caller's words before it, when transcription is slow. */
export const TRANSCRIPT_WAIT_MS = 3000;

/** The part of the SDK's call socket the engine uses; tests pass a fake. */
export interface RealtimeSocket {
  send(event: Record<string, unknown>): void;
  on(event: 'event', handler: (e: { type: string; event_id?: string } & Record<string, unknown>) => void): unknown;
  on(event: 'error', handler: (err: Error) => void): unknown;
  close(): void;
  /** The underlying WebSocket: 1 is open. Sends before it opens are queued here, not lost. */
  socket: { readyState?: number; on(event: 'close', handler: (code: number) => void): unknown; on(event: 'open', handler: () => void): unknown };
}

/** A voice GPT-Live has that the Realtime models may not: the clinic's own if it is one of both, else a warm default. */
const voiceFor = (voice: string) => ((REALTIME_VOICES as readonly string[]).includes(voice) ? voice : DEFAULT_VOICE);

/**
 * OpenAI's Realtime models (gpt-realtime-2.1 by default), for phone calls over SIP and
 * test calls from the dashboard over WebRTC. The call runner, the agent and the backend
 * are the same as for GPT-Live: this engine turns the Realtime API's events into the
 * events the runner reads (transcripts, hand-offs, the end of the call) and the
 * runner's commands into Realtime ones. Nothing is stored on OpenAI's side beyond the call.
 */
export class RealtimeEngine implements VoiceEngine {
  readonly name = 'gpt-realtime';
  private readonly browser = new Set<string>();
  /** The voice each call was created with: set once, never changed in the call. */
  private readonly voices = new Map<string, string>();
  /** What each call says first (the clinic's greeting, or a VIP's or a paused clinic's opening), for its first reply. */
  private readonly openings = new Map<string, string>();

  constructor(
    private readonly client: OpenAI,
    private readonly model = 'gpt-realtime-2.1',
    private readonly openSocket: (callId: string) => RealtimeSocket = (id) => new OpenAIRealtimeWS({ callID: id }, client) as unknown as RealtimeSocket,
  ) {}

  /** How each call's turns are answered: the planner behind ask_backend, or our tools called by the model itself. */
  private readonly flows = new Map<string, VoiceFlow>();
  /** Each call's own facts (the clinic's date by the call's clock, the caller ID), said once at the start on the tools path. */
  private readonly facts = new Map<string, string>();

  /**
   * The planner path: the conversation prompt and one tool, ask_backend. The tools path (batch 1a): the tools prompt
   * (tone and how to work, no clinic policy) and our tools as the model's own function tools, answered by the tools API.
   */
  private session(clinic: ClinicConfig, now: Date, opts: CallOptions = {}) {
    const tools = opts.flow === 'tools';
    return {
      type: 'realtime' as const,
      // a clinic on a trial of another model has it here (batch 1d); everyone else, the deployment's
      model: this.modelFor(clinic),
      // the tools path: the same instructions and tools on every call of the clinic (the call's own facts go in the
      // conversation), so they stay in the prompt cache
      instructions: tools ? [toolsVoiceStaticPrompt(clinic), ...REALTIME_TOOLS_LINES].join('\n') : [conversationPrompt(clinic, now), ...REALTIME_LINES].join('\n'),
      audio: {
        // on the tools path the reply is a tool call away, so the turn ends sooner: semantic_vad at high eagerness answers
        // once the caller has clearly finished, instead of waiting out a longer pause (real-audio runs, batch 1a)
        input: { transcription: { model: TRANSCRIBE_MODEL }, turn_detection: tools ? TOOLS_TURNS : { type: 'semantic_vad' as const } },
        output: { voice: voiceFor(clinic.voice) },
      },
      tools: tools ? realtimeTools(clinic) : [ASK_BACKEND],
      tool_choice: 'auto' as const,
      ...(tools ? { truncation: TOOLS_TRUNCATION } : {}),
    };
  }

  /** The model a clinic's calls run on: its own trial choice, or the deployment's. */
  private modelFor(clinic: ClinicConfig): string { return clinic.realtimeModel ?? this.model; }
  /** Each call's model, so its tokens are priced as that model's. */
  private readonly models = new Map<string, string>();

  async accept(callId: string, clinic: ClinicConfig, now: Date, opening?: string, opts: CallOptions = {}) {
    this.models.set(callId, this.modelFor(clinic));
    await this.client.realtime.calls.accept(callId, this.session(clinic, now, opts));
    this.openings.set(callId, opening ?? openingInstruction(clinic));
    this.voices.set(callId, voiceFor(clinic.voice));
    this.flows.set(callId, opts.flow ?? 'planner');
    if (opts.flow === 'tools') this.facts.set(callId, callFacts(clinic, now, opts.callerNumber));
  }

  sessionInfo(callId: string) {
    const voice = this.voices.get(callId);
    return voice ? { engine: this.name, voice } : null;
  }

  async startBrowserCall(clinic: ClinicConfig, sdpOffer: string, now: Date, opts: CallOptions = {}) {
    const session = this.session(clinic, now, opts);
    // no retries: a retried create would be a second, billed call
    const res = await this.client.realtime.calls.create({ sdp: sdpOffer, session }, { timeout: 10_000, maxRetries: 0 });
    // the call's id is the last part of the Location header: /v1/realtime/calls/{call_id}
    const callId = res.headers.get('location')?.split('/').filter(Boolean).at(-1);
    if (!callId) throw new Error('realtime call created without a call id');
    this.browser.add(callId);
    this.models.set(callId, this.modelFor(clinic));
    this.openings.set(callId, openingInstruction(clinic));
    this.voices.set(callId, voiceFor(clinic.voice));
    this.flows.set(callId, opts.flow ?? 'planner');
    if (opts.flow === 'tools') this.facts.set(callId, callFacts(clinic, now, opts.callerNumber));
    return { sessionId: callId, sdpAnswer: await res.text() };
  }

  async reject(callId: string, sipStatus: number) {
    await this.client.realtime.calls.reject(callId, { status_code: sipStatus });
  }

  async transfer(callId: string, targetUri: string) {
    if (this.browser.has(callId)) throw new Error('a browser test call cannot be transferred');
    await this.client.realtime.calls.refer(callId, { target_uri: targetUri });
  }

  async hangup(callId: string) {
    await this.client.realtime.calls.hangup(callId);
  }

  release(callId: string) {
    this.browser.delete(callId);
    this.voices.delete(callId);
    this.flows.delete(callId);
    this.facts.delete(callId);
    this.models.delete(callId);
    this.openings.delete(callId);
  }


  attach(callId: string): Sideband {
    const ws = this.openSocket(callId);
    const toolsPath = this.flows.get(callId) === 'tools';
    // the tool calls of a response still waiting for their results: the model goes on once all of them are back
    const outstanding = new Set<string>();
    // the last tool question among the results of one response, said once all of them are back
    let question: string | null = null;
    // and the last refusal line among them (a question wins over it)
    let refusal: string | null = null;
    // the call's state, changed by those calls: added after their results
    let stateNote: string | null = null;
    // manual replies: whether the model waits for our go, and whether a turn that ended is waiting for it now
    let manual = false;
    let goDue = false;
    let goTimer: NodeJS.Timeout | null = null;
    const go = () => { if (goTimer) clearTimeout(goTimer); goTimer = null; if (!goDue) return; goDue = false; respond(); };
    const started = Date.now();
    const ms = () => Date.now() - started;
    let n = 0;
    const id = (e: { event_id?: string }) => e.event_id ?? `rt_${callId}_${++n}`;
    const handlers: ((e: SidebandEvent) => void)[] = [];
    const emit = (e: SidebandEvent) => { for (const h of handlers) h(e); };

    // The socket is still connecting when the runner first speaks (a VIP's line, say): what is
    // sent before it opens waits, and on open the assistant greets the caller, with anything
    // queued as context for that first answer. Realtime models wait for the caller otherwise.
    let open = ws.socket.readyState === 1;
    let queue: Record<string, unknown>[] = [];
    // one response at a time: a new one waits for the one in progress to finish (or be cancelled)
    let active = false;
    let wanted: Record<string, unknown> | null = null;
    const raw = (e: Record<string, unknown>) => (open ? ws.send(e) : queue.push(e));
    const respond = (e: Record<string, unknown> = { type: 'response.create' }) => {
      if (!open) return; // the greeting on open answers for it
      if (active) wanted = e; else { active = true; ws.send(e); }
    };
    const interrupt = () => { if (open && active) ws.send({ type: 'response.cancel' }); };
    // a note for the model at the end of the conversation (never removed: removing one moves everything after it, and
    // the prompt cache misses from there)
    const note = (text: string) => ws.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    const turnNote = () => { if (open) note(TURN_NOTE); };
    // the tools path: the call's own facts, once, before anything else in the conversation
    const facts = this.facts.get(callId);
    // words a tool gave that the next reply says as written: a note, then a reply with no tools. Not the reply's own
    // instructions, which replace the session's for that reply, so the prompt cache missed the whole call each time
    const sayNext = (instructions: string) => { note(instructions); respond({ type: 'response.create', response: { tool_choice: 'none' } }); };
    // The greeting is the first reply, with its own short instructions: only what to say, and no tools. With the whole
    // session prompt (the clinic, the tools and their rules) the model first read all of it, and the caller waited
    // (path A, 2026-11-07: first audio 5.3 s on a browser call). Anything queued before the socket opened (a note for the
    // first answer) is context the greeting must see: then the reply is the usual one.
    const opening = this.openings.get(callId);
    const greet = (queued: boolean) => respond(opening && !queued ? { type: 'response.create', response: { instructions: `${opening} ${GREETING_VOICE}`, tool_choice: 'none' } } : { type: 'response.create' });
    ws.socket.on('open', () => {
      open = true;
      if (facts) note(facts);
      const items = queue.filter((e) => e.type === 'conversation.item.create');
      queue = [];
      for (const e of items) ws.send(e);
      greet(items.length > 0);
    });
    if (open) { if (facts) note(facts); greet(false); }

    // the model's words come in pieces smaller than a word ("Bisc", "uit"): they are passed on
    // a word at a time, so the record and the live captions read as said
    let words = '';
    const spoken = (e: { event_id?: string }, final = false) => {
      const cut = final ? words.length : Math.max(words.lastIndexOf(' '), words.lastIndexOf('\n')) + 1;
      if (cut <= 0) return;
      const delta = words.slice(0, cut);
      words = words.slice(cut);
      reply({ type: 'session.output_transcript.delta', event_id: id(e), delta, start_ms: ms(), end_ms: ms() });
    };

    // The model answers as soon as the caller stops; their words are transcribed after, and
    // can arrive seconds later. Until they do, the reply's words and its hand-off wait, so
    // the record reads in order and the backend plans with what the caller just said.
    const awaiting = new Set<string>();
    let held: SidebandEvent[] = [];
    let timer: NodeJS.Timeout | null = null;
    const release = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      awaiting.clear();
      const out = held;
      held = [];
      for (const e of out) emit(e);
    };
    const reply = (e: SidebandEvent) => {
      if (!awaiting.size) return emit(e);
      held.push(e);
      timer ??= setTimeout(release, TRANSCRIPT_WAIT_MS);
    };
    const heard = (itemId: unknown) => {
      if (typeof itemId === 'string') awaiting.delete(itemId);
      if (!awaiting.size) release();
    };

    // when each caller turn was spoken, by our clock: its line is placed and timed by that, not by when its transcript
    // arrived (often after the reply had started, which put the caller's words a turn late in the record and made the
    // wait for an answer look shorter than it was)
    const spokenAt = new Map<string, { start: number; end: number | null }>();
    ws.on('event', (e) => {
      switch (e.type) {
        case 'input_audio_buffer.speech_started':
          if (typeof e.item_id === 'string') spokenAt.set(e.item_id, { start: ms(), end: null });
          return;
        case 'input_audio_buffer.speech_stopped':
          if (typeof e.item_id === 'string') { const at = spokenAt.get(e.item_id); spokenAt.set(e.item_id, { start: at?.start ?? ms(), end: ms() }); }
          return;
        case 'input_audio_buffer.committed':
          if (typeof e.item_id === 'string') awaiting.add(e.item_id);
          // the tools path: the turn's note right after the caller's words, where the model weighs it most (batch 1b:
          // a rule in the session prompt alone still let it say "let me check..." before most tool calls)
          if (toolsPath) turnNote();
          // the tools path starts its own replies: at once, or (manual) after the go, or by itself in a moment without one
          if (toolsPath && !manual) respond();
          else if (manual) { goDue = true; if (goTimer) clearTimeout(goTimer); goTimer = setTimeout(go, GO_WAIT_MS); }
          return;
        // the caller's turn, whole, once it is transcribed
        case 'conversation.item.input_audio_transcription.completed':
          if ((e.usage as { type?: string } | undefined)?.type === 'tokens') {
            const u = e.usage as { input_tokens?: number; output_tokens?: number };
            emit({ type: 'session.model_usage', event_id: `${id(e)}_usage`, model: TRANSCRIBE_MODEL, input: u.input_tokens ?? 0, cached: 0, output: u.output_tokens ?? 0 });
          }
          if (typeof e.transcript === 'string' && e.transcript.trim()) {
            const at = typeof e.item_id === 'string' ? spokenAt.get(e.item_id) : undefined;
            if (typeof e.item_id === 'string') spokenAt.delete(e.item_id);
            emit({ type: 'session.input_transcript.delta', event_id: id(e), delta: e.transcript, start_ms: at?.start ?? ms(), end_ms: at?.end ?? ms() });
          }
          return heard(e.item_id);
        case 'conversation.item.input_audio_transcription.failed':
          return heard(e.item_id);
        case 'response.output_audio_transcript.delta':
          if (typeof e.delta === 'string' && e.delta) { words += e.delta; spoken(e); }
          return;
        case 'response.output_audio_transcript.done':
          return spoken(e, true);
        case 'response.created':
          active = true;
          return;
        // the caller's line starts playing the assistant's audio (WebRTC and phone calls): the runner's first audio
        case 'output_audio_buffer.started':
          emit({ type: 'session.output_audio.delta', event_id: id(e), delta: '' });
          return;
        case 'response.done': {
          spoken(e, true);
          // what the reply cost: audio and text tokens, each with its cached part, priced per modality (call_costs)
          // each with its own event id: the runner drops an event id it has seen (the reply's own words carry this one)
          for (const u of replyUsage(this.models.get(callId) ?? this.model, (e as { response?: { usage?: RealtimeUsage } }).response?.usage)) emit({ type: 'session.model_usage', event_id: `${id(e)}_usage_${u.model}`, ...u });
          active = false;
          const next = wanted;
          wanted = null;
          if (next) respond(next);
          return;
        }
        // the model hands the caller's request to the backend: the runner answers it like a GPT-Live delegation
        case 'response.function_call_arguments.done':
          if (typeof e.call_id !== 'string') return;
          if (e.name === ASK_BACKEND.name) reply({ type: 'session.delegation.created', event_id: id(e), delegation: { id: e.call_id, target: 'client' } });
          // the tools path: one of our tools, answered by the tools API; held like a hand-off until the caller's words are in
          else if (toolsPath && typeof e.name === 'string') {
            outstanding.add(e.call_id);
            const call: SidebandEvent = { type: 'session.tool_call', event_id: id(e), call_id: e.call_id, name: e.name, arguments: typeof e.arguments === 'string' ? e.arguments : '{}' };
            // a lookup reads nothing the caller just said, so it runs at once; anything that may act on their words (a
            // yes to a read-back, a booking, a text, a transfer) waits for their words to be transcribed, as before
            if (READS.has(e.name)) emit(call); else reply(call);
          }
          return;
        case 'error':
          emit({ type: 'error', event_id: id(e), error: (e.error ?? undefined) as { code?: string; message?: string } | undefined });
          return;
        default:
      }
    });

    const send = (event: SidebandCommand) => {
      if (event.type === 'turns.manual') {
        if (!toolsPath || event.on === manual) return;
        manual = event.on;
        if (!manual) go();
        return;
      }
      if (event.type === 'tool.inject') {
        // the lookup the caller's words asked for, as if the model had called it: it answers from it in one reply.
        // Only while the turn waits for the go; once it has replied by itself, the model asks for what it needs
        if (!goDue) return;
        raw({ type: 'conversation.item.create', item: { type: 'function_call', call_id: event.call_id, name: event.name, arguments: event.arguments } });
        raw({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: event.output } });
        return;
      }
      if (event.type === 'reply.go') return go();
      if (event.type === 'context.note') {
        if (!toolsPath) return;
        // while the model waits on its tool calls, the note goes after their results (a call and its output stay together)
        if (outstanding.size) stateNote = event.content;
        else raw({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: event.content }] } });
        return;
      }
      if (event.type === 'tool.result') {
        // a tool's result: the function call's output, and once every call of the response has its result, the model goes on
        raw({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: event.output } });
        outstanding.delete(event.call_id);
        question = toolQuestion(event.output) ?? question;
        refusal = toolRefusalLine(event.output) ?? refusal;
        if (!outstanding.size) {
          if (stateNote) { note(stateNote); stateNote = null; }
          // the tool's own question, or its refusal line, said as written (no tools in that reply: it waits for the caller)
          const instructions = toolReplyInstructions(question, refusal);
          question = null;
          refusal = null;
          if (instructions) sayNext(instructions);
          else respond();
        }
        return;
      }
      const c = event as { type: string; delegation_id: string | null; content: string };
      if (c.type === 'session.commentary.append' && c.delegation_id) {
        // the backend's answer to the hand-off: the tool's result, then the model says it
        raw({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.delegation_id, output: c.content } });
        respond();
      } else if (c.type === 'session.thinking.append') {
        // GPT-Live hears progress notes as context; here only "still working" is said, the rest is silent
        if (/^Still working/.test(c.content)) respond({ type: 'response.create', response: { instructions: 'Tell the caller in a few words that you are still checking. Do not answer the question yet.', tool_choice: 'none' } });
      } else {
        // new instructions (an emergency script, a staff note, a nudge): a system message in
        // the conversation, so it stays in context without becoming a standing rule, acted on
        // now, cutting off whatever the assistant was saying
        raw({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: c.content }] } });
        interrupt();
        respond();
      }
    };

    return {
      send,
      onEvent: (handler) => { handlers.push(handler); },
      onError: (handler) => { ws.on('error', handler); },
      onConnection: (handler) => { if (open) handler({ state: 'open' }); else ws.socket.on('open', () => handler({ state: 'open' })); },
      // a Realtime call has no closing event: a clean close of the call's socket is the end
      // of the call; any other close is a dropped connection, and the runner records it so
      onClose: (handler) => {
        ws.socket.on('close', (code: number) => {
          if (goTimer) clearTimeout(goTimer);
          release();
          if (code === 1000) emit({ type: 'session.closed', event_id: `rt_${callId}_closed`, reason: 'call_ended', usage: { seconds: Math.round(ms() / 1000) } });
          handler(code);
        });
      },
      close: () => ws.close(),
    };
  }
}
