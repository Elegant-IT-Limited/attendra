// SPDX-License-Identifier: AGPL-3.0-only
import { voiceToolDefinitions } from '@attendra/agent';
import type { ClinicConfig, VapiVoiceChoice } from '@attendra/core';
import { createHash } from 'node:crypto';
import { toolsVoicePrompt } from './tools-prompt';

/**
 * A location's Vapi assistant, built from its settings (batch 6), and the small client that creates it at Vapi. The
 * assistant holds no rule: its prompt is the tools voice prompt (the same lines as our own engines' tools path), and its
 * function tools are our tools API, each pointing at the voice service's Vapi route with the location's own secret.
 * Request shapes from Vapi's API reference (docs.vapi.ai/api-reference/assistants/create, /phone-numbers/create,
 * /advanced/sip/twilio). Nothing here runs in a test against Vapi: the client takes an injected fetch.
 */

/** Where Vapi posts: under /webhooks, which the proxy in front of the voice service already routes to it. */
export const VAPI_EVENTS_PATH = '/webhooks/vapi/v1/events';
/** The header the assistant sends its secret in, on every server message and tool call. */
export const VAPI_SECRET_HEADER = 'x-vapi-secret';

/**
 * Vapi's quality settings for every location, prepared offline (batch 6, item 5); no call measured them yet. The bake-off
 * (2026-11-07, web calls, everything at Vapi's defaults) heard lookups answered in 1.85 s median and 2.58 s per reply,
 * with a 7.3 s greeting: the greeting and the end-of-turn wait are what these change. docs/provisioning.md, "Vapi quality
 * settings", has the trade-offs and what the first phone test must check.
 */
export const VAPI_DEFAULTS = {
  /** The model that runs the conversation and calls our tools: the bake-off's (gpt-4.1 answered every lookup in under 2 s median). */
  model: { provider: 'openai', model: 'gpt-4.1', temperature: 0.3, maxTokens: 250 },
  /** Deepgram nova-3: 'multi' when the location speaks more than one language (a caller may switch), else its one language. */
  transcriber: { provider: 'deepgram', model: 'nova-3' },
  /** Each provider's voice when the location has not chosen one; all billed through Vapi. */
  voice: {
    vapi: { provider: 'vapi', voiceId: 'Elliot' },
    '11labs': { provider: '11labs', voiceId: 'sarah', model: 'eleven_flash_v2_5' },
    // Cartesia has no preset names: a location on Cartesia names its voice id (VapiVoiceChoice)
    cartesia: { provider: 'cartesia', model: 'sonic-3.5' },
  },
  /**
   * The greeting is spoken as written, from the voice alone, the moment the call connects: no model round before the first
   * word (first audio target under 3 s on a phone call), and Vapi caches the audio of a fixed first message. It cannot be
   * talked over: it is the line that says the caller is speaking with an AI assistant.
   */
  firstMessageMode: 'assistant-speaks-first',
  firstMessageInterruptionsEnabled: false,
  /**
   * When to answer: smart endpointing (LiveKit's model for an English-only location, Vapi's own for one that also speaks
   * Spanish: LiveKit's is English only), a short floor before speaking, and more time after a number question, so a caller
   * reading a phone number or a date in pieces is not cut off (path A's lesson: shorter waits cut callers reading numbers).
   */
  startSpeaking: {
    waitSeconds: 0.3,
    numberQuestion: '(number|phone|date of birth|birthday|digits|n[uú]mero|tel[eé]fono|fecha de nacimiento)[^.?!]*\\?\\s*$',
    numberQuestionSeconds: 1.5,
    /** The caller's words end in digits: they may be reading more. */
    trailingDigits: '\\d[\\d\\s-]*$',
    trailingDigitsSeconds: 1.0,
  },
  /**
   * When to stop: a caller who talks for 0.3 s stops the assistant (0.2 s is Vapi's default: a bark or a door would), and
   * a few words never do ("okay", "sí"), in both languages; "no", "wait", "espera" always do.
   */
  stopSpeaking: {
    numWords: 0,
    voiceSeconds: 0.3,
    backoffSeconds: 1,
    acknowledgementPhrases: ['i understand', 'i see', 'i got it', 'i hear you', 'im listening', 'right', 'okay', 'ok', 'sure', 'alright', 'got it', 'understood', 'yeah', 'yes', 'uh-huh', 'mm-hmm', 'gotcha', 'mhmm',
      'sí', 'si', 'ajá', 'claro', 'vale', 'bueno', 'entiendo', 'de acuerdo', 'ya', 'okey'],
    interruptionPhrases: ['stop', 'wait', 'hold on', 'no', 'nope', 'actually', 'but', 'sorry', 'excuse me',
      'espera', 'espere', 'para', 'pare', 'un momento', 'perdón', 'disculpe', 'pero', 'no no'],
  },
  /** Our engines play nothing under the voice; Vapi's phone default is an office murmur. */
  backgroundSound: 'off',
  /** A call ends after 20 minutes (Vapi's default, 10, can cut a long call mid-booking). */
  maxDurationSeconds: 1200,
  /** What Vapi posts besides tool calls: the conversation, the call's status (live calls, for concurrency) and its end. */
  serverMessages: ['conversation-update', 'end-of-call-report', 'status-update'],
} as const;

/** Vapi's form of a tool's JSON schema (its validator answers 400 otherwise): no "$schema", and every property with a "type". */
type Schema = { [k: string]: unknown };
export const forVapi = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(forVapi);
  if (!v || typeof v !== 'object') return v;
  const o: Schema = Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$schema').map(([k, x]) => [k, forVapi(x)]));
  const branches = o.anyOf as Schema[] | undefined;
  if (!('type' in o) && Array.isArray(branches) && branches.every((b) => typeof b.type === 'string')) {
    const real = branches.filter((b) => b.type !== 'null');
    const nullable = real.length < branches.length;
    if (real.length === 1) { const rest = { ...o }; delete rest.anyOf; return { ...rest, ...real[0], type: nullable ? [real[0]!.type, 'null'] : real[0]!.type }; }
    o.type = [...new Set(branches.map((b) => b.type))];
  }
  return o;
};

/** The voice a location speaks with on Vapi: its own choice, else Vapi's default voice. */
export function vapiVoice(choice: VapiVoiceChoice | undefined): Record<string, unknown> {
  if (!choice) return { ...VAPI_DEFAULTS.voice.vapi };
  return { ...VAPI_DEFAULTS.voice[choice.provider], ...choice };
}

export interface VapiAssistantInput {
  /** The public address of the voice service's Vapi route, with this location in it (vapiServerUrl). */
  serverUrl: string;
  /** The location's own secret, sent in a header on every request Vapi makes to us. */
  secret: string;
  /** The assistant's name at Vapi, for the people who look at its dashboard: the location's id, never a caller's detail. */
  name?: string;
}

/** The route Vapi posts to for one location. */
export const vapiServerUrl = (base: string, clinicId: string) => `${withoutTrailingSlashes(base)}${VAPI_EVENTS_PATH}?clinic=${encodeURIComponent(clinicId)}`;

/** The address without its trailing slashes, in one pass (a /\/+$/ regex runs slowly on a long run of slashes). */
function withoutTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** Ends of turn: LiveKit's model for English only, Vapi's for a location that also speaks another language. */
const endpointingFor = (clinic: ClinicConfig) => (clinic.languages.every((l) => l === 'en') ? { provider: 'livekit' } : { provider: 'vapi' });

/**
 * The assistant for a location, from its settings: create and update send the same body, so an update replaces what Vapi
 * had. The prompt and the tools are the tools path's, word for word; the greeting is the location's own (it discloses the
 * AI). Recording at Vapi follows the location's own recording setting (off unless it plays a notice).
 */
export function vapiAssistant(clinic: ClinicConfig, input: VapiAssistantInput) {
  const server = { url: input.serverUrl, headers: { [VAPI_SECRET_HEADER]: input.secret }, timeoutSeconds: 20 };
  const s = VAPI_DEFAULTS.startSpeaking;
  const st = VAPI_DEFAULTS.stopSpeaking;
  return {
    name: input.name ?? `Attendra ${clinic.id}`.slice(0, 40),
    firstMessage: clinic.greeting,
    firstMessageMode: VAPI_DEFAULTS.firstMessageMode,
    firstMessageInterruptionsEnabled: VAPI_DEFAULTS.firstMessageInterruptionsEnabled,
    model: {
      ...VAPI_DEFAULTS.model,
      messages: [{ role: 'system', content: toolsVoicePrompt(clinic, { callerNumber: null }) }],
      tools: voiceToolDefinitions(clinic).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: forVapi(t.parameters) }, server })),
    },
    voice: vapiVoice(clinic.vapi?.voice),
    transcriber: { ...VAPI_DEFAULTS.transcriber, language: clinic.languages.length > 1 ? 'multi' : clinic.languages[0] },
    startSpeakingPlan: {
      waitSeconds: s.waitSeconds,
      smartEndpointingPlan: endpointingFor(clinic),
      customEndpointingRules: [
        { type: 'assistant', regex: s.numberQuestion, regexOptions: [{ type: 'ignore-case', enabled: true }], timeoutSeconds: s.numberQuestionSeconds },
        { type: 'customer', regex: s.trailingDigits, timeoutSeconds: s.trailingDigitsSeconds },
      ],
    },
    stopSpeakingPlan: { numWords: st.numWords, voiceSeconds: st.voiceSeconds, backoffSeconds: st.backoffSeconds, acknowledgementPhrases: [...st.acknowledgementPhrases], interruptionPhrases: [...st.interruptionPhrases] },
    backgroundSound: VAPI_DEFAULTS.backgroundSound,
    maxDurationSeconds: VAPI_DEFAULTS.maxDurationSeconds,
    // our transfers and hang-ups go through the call's control URL; nobody listens in
    monitorPlan: { controlEnabled: true, listenEnabled: false },
    artifactPlan: { recordingEnabled: clinic.recording.enabled, pcapEnabled: false },
    server,
    serverMessages: [...VAPI_DEFAULTS.serverMessages],
    metadata: { attendra: 'location', clinic: clinic.id },
  };
}
export type VapiAssistant = ReturnType<typeof vapiAssistant>;

/**
 * What the assistant would be, as a hash, without its secret: equal to the one stored after the last update when no
 * setting it is built from has changed since (the voice, the greeting, the prompt, the tools, the address).
 */
export function vapiAssistantHash(assistant: VapiAssistant): string {
  const strip = (server: { url: string }) => ({ url: server.url });
  const bare = { ...assistant, server: strip(assistant.server), model: { ...assistant.model, tools: assistant.model.tools.map((t) => ({ ...t, server: strip(t.server) })) } };
  return createHash('sha256').update(JSON.stringify(bare)).digest('hex');
}

/**
 * The location's number as a BYO SIP number at Vapi, on our Twilio Vapi trunk's credential, answered by its assistant.
 * The number is E.164: what Twilio puts in the request line it sends to the trunk's origination address.
 */
export function vapiPhoneNumber(clinic: ClinicConfig, number: string, assistantId: string, credentialId: string) {
  return { provider: 'byo-phone-number', credentialId, number, numberE164CheckEnabled: true, assistantId, name: `Attendra ${clinic.id}`.slice(0, 40) };
}

/**
 * The BYO SIP trunk credential at Vapi for our Twilio Vapi trunk: made once per deployment (its id is VAPI_SIP_CREDENTIAL_ID),
 * shared by every location. Vapi takes an inbound call only from a source it lists as an inbound gateway, matched by
 * numeric IPv4 network, so every Twilio Elastic SIP Trunking signalling range (Twilio's current list, primary and failover
 * edges) is one inbound gateway; Twilio's termination host may be added as the outbound one (Vapi never dials out for us).
 * docs.vapi.ai/advanced/sip/twilio, "Inbound calls".
 */
export function vapiSipCredential(opts: { inboundCidrs: string[]; terminationHost?: string; port?: number; name?: string }) {
  const gateways = opts.inboundCidrs.map((cidr) => {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
    if (!m || Number(m[2]) > 32 || m[1]!.split('.').some((o) => Number(o) > 255)) throw new Error(`not an IPv4 network: ${cidr}`);
    return { ip: m[1]!, netmask: Number(m[2]), port: opts.port ?? 5060, inboundEnabled: true, outboundEnabled: false };
  });
  if (!gateways.length) throw new Error('at least one Twilio signalling network');
  if (opts.terminationHost) gateways.push({ ip: opts.terminationHost, port: opts.port ?? 5060, inboundEnabled: false, outboundEnabled: true } as (typeof gateways)[number]);
  return { provider: 'byo-sip-trunk', name: opts.name ?? 'Attendra Twilio Vapi trunk', gateways, outboundLeadingPlusEnabled: true };
}

/** Where Twilio's Vapi trunk sends a number's calls (Vapi's BYO SIP address for the credential; the EU region is sip.eu.vapi.ai). */
export const vapiSipUri = (number: string, credentialId: string, host = 'sip.vapi.ai') => `sip:${number}@${credentialId}.${host}`;

/** Vapi refused a request: its status and the start of its message (never the key). */
export class VapiError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly path: string) {
    super(`vapi ${path}: ${status} ${detail}`);
    this.name = 'VapiError';
  }
}

/** The calls the engine makes to Vapi: assistants and BYO phone numbers, nothing else. */
export interface VapiClient {
  createAssistant(body: VapiAssistant): Promise<{ id: string }>;
  updateAssistant(id: string, body: VapiAssistant): Promise<{ id: string }>;
  createPhoneNumber(body: ReturnType<typeof vapiPhoneNumber>): Promise<{ id: string }>;
  updatePhoneNumber(id: string, body: Partial<ReturnType<typeof vapiPhoneNumber>>): Promise<{ id: string }>;
  /** Already gone (404) counts as removed. */
  deletePhoneNumber(id: string): Promise<void>;
  /** The deployment's SIP trunk credential (once, by the operator's script; never from a provisioning route). */
  createCredential(body: ReturnType<typeof vapiSipCredential>): Promise<{ id: string }>;
  updateCredential(id: string, body: Partial<ReturnType<typeof vapiSipCredential>>): Promise<{ id: string }>;
}

/** Vapi's REST API with a private key (Bearer). `fetchImpl` is injected in tests: they never reach Vapi. */
export function vapiClient(apiKey: string, fetchImpl: typeof fetch = fetch, base = 'https://api.vapi.ai'): VapiClient {
  const call = async (method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ id: string } | null> => {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (okStatuses.includes(res.status)) return null;
    if (!res.ok) throw new VapiError(res.status, (await res.text().catch(() => '')).slice(0, 300), `${method} ${path}`);
    const json = await res.json().catch(() => null) as { id?: unknown } | null;
    if (method !== 'DELETE' && (typeof json?.id !== 'string' || !json.id)) throw new VapiError(res.status, 'no id in the answer', `${method} ${path}`);
    return json && typeof json.id === 'string' ? { id: json.id } : null;
  };
  const id = (v: string) => encodeURIComponent(v);
  return {
    createAssistant: async (body) => (await call('POST', '/assistant', body))!,
    updateAssistant: async (assistantId, body) => (await call('PATCH', `/assistant/${id(assistantId)}`, body))!,
    createPhoneNumber: async (body) => (await call('POST', '/phone-number', body))!,
    updatePhoneNumber: async (numberId, body) => (await call('PATCH', `/phone-number/${id(numberId)}`, body))!,
    deletePhoneNumber: async (numberId) => { await call('DELETE', `/phone-number/${id(numberId)}`, undefined, [404]); },
    createCredential: async (body) => (await call('POST', '/credential', body))!,
    updateCredential: async (credentialId, body) => (await call('PATCH', `/credential/${id(credentialId)}`, body))!,
  };
}
