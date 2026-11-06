// SPDX-License-Identifier: AGPL-3.0-only
import { afterTool, type CallState, type FlowMemory, flowStage, nextStep, type Planner, type PlannerInput, type PlannerOutput, type PlannerTiming, shapeForVoice, speculativeLookup, type ToolResult, visitTypeChoices, voiceToolDefinitions } from '@attendra/agent';
import { addDays, clinicNow, clinicNowLine, type ClinicConfig, localDateOf, type ToolName, weekdayOf } from '@attendra/core';
import { realtimeTools, toolsBackendInstructions, toolsVoicePrompt } from '@attendra/voice-engine';
import type OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';

/**
 * Live evals on the tools path (batch 1a): the same scenarios and checks, with the voice's own model deciding which tools
 * to call instead of the planner. Each caller turn the simulator hands over is answered by:
 * - path A, gpt-realtime in text mode, with our tools as its function tools and the tools-path voice prompt (the same
 *   session config a phone call gets, without the audio);
 * - path B, the Responses model GPT-Live delegates to on the tools path, with its instructions and the same tools.
 * Tools run through the call's own runTool (so every refusal and check is the planner path's), shaped and stepped by the
 * booking flow as on a real call. The words the model writes are what the voice would say.
 */
export type ToolsPath = 'a' | 'b';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The clinic's clock as the voice sees it, with the next 14 days for "Friday" and "next week". */
function clockFor(clinic: ClinicConfig, now: Date, state: CallState) {
  const c = clinicNow(clinic, now);
  const today = localDateOf(now, clinic.timezone);
  const days = Array.from({ length: 14 }, (_, i) => { const date = addDays(today, i); return { date, day: DAY[weekdayOf(date)] }; });
  return { ok: true, outcome: 'ok', spoken: clinicNowLine(clinic, c, state.language), data: { ...c, days }, stage: 'idle' };
}

interface Session { flow: FlowMemory; sent: number; lastSaid: string | null; ws?: OpenAIRealtimeWS; ready?: Promise<void> }

export class ToolsPathPlanner implements Planner {
  private readonly sessions = new WeakMap<CallState, Session>();
  constructor(private readonly openai: OpenAI, readonly path: ToolsPath, private readonly model: string) {}

  private session(state: CallState): Session {
    let s = this.sessions.get(state);
    if (!s) { s = { flow: { committedAt: null }, sent: 0, lastSaid: null }; this.sessions.set(state, s); }
    return s;
  }

  async plan(input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>): Promise<PlannerOutput> {
    const { state, clinic } = input;
    state.answersAcrossPieces = true;
    const s = this.session(state);
    const now = input.now ?? new Date();
    const requests: PlannerTiming['requests'] = [];
    let toolMs = 0;
    const started = performance.now();
    // one tool, as the voice service runs it: clinic_now from the clock, the rest through runTool, shaped by the flow
    const run = async (name: string, argsText: string): Promise<string> => {
      const t0 = performance.now();
      let args: unknown;
      try { args = JSON.parse(argsText || '{}'); } catch { return JSON.stringify({ ok: false, outcome: 'invalid_arguments', say: 'Those arguments were not valid JSON.' }); }
      try {
        if (name === 'clinic_now') return JSON.stringify(clockFor(clinic, now, state));
        const r = await execute(name as ToolName, args);
        afterTool(s.flow, name, r.ok && !r.data.error, state.turns.length);
        const stage = flowStage(state, s.flow);
        return JSON.stringify(shapeForVoice(name, r, stage, nextStep(stage, state, clinic, input.callerNumber ?? null), { visitTypes: visitTypeChoices(clinic) }));
      } finally {
        toolMs += performance.now() - t0;
      }
    };
    const say = this.path === 'a' ? await this.realtime(input, s, run, requests) : await this.responses(input, run, requests);
    const modelMs = Math.round(performance.now() - started - toolMs);
    return {
      say,
      timing: {
        model: this.model, effort: this.path === 'b' ? 'low' : null, tier: null, simple: false, rounds: requests.length, modelMs, firstWordsMs: modelMs + Math.round(toolMs),
        announced: false, fallback: false, requests, toolMs: Math.round(toolMs), prompt: { instructions: 0, tools: 0, transcript: 0, state: 0, history: 0, notes: 0 },
      },
    };
  }

  /** Path B: the Responses model with the backend's instructions and our tools, round after round until it writes words. */
  private async responses(input: PlannerInput, run: (name: string, args: string) => Promise<string>, requests: PlannerTiming['requests']): Promise<string | null> {
    const transcript = input.state.turns.map((t) => ({ role: t.speaker === 'caller' ? 'user' as const : 'assistant' as const, content: t.text }));
    const items: OpenAI.Responses.ResponseInputItem[] = [...transcript];
    for (let round = 0; round < 8; round++) {
      const t0 = performance.now();
      const res = await this.openai.responses.create({
        model: this.model, store: false, instructions: toolsBackendInstructions(input.clinic), input: items,
        tools: voiceToolDefinitions(input.clinic) as OpenAI.Responses.FunctionTool[], parallel_tool_calls: false, reasoning: { effort: 'low' },
      }, { timeout: 30_000, maxRetries: 1 });
      const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call');
      requests.push({ ms: Math.round(performance.now() - t0), firstTokenMs: null, served: null, inputTokens: res.usage?.input_tokens ?? null, cachedTokens: res.usage?.input_tokens_details?.cached_tokens ?? null, outputTokens: res.usage?.output_tokens ?? null, reasoningTokens: res.usage?.output_tokens_details?.reasoning_tokens ?? null, calls: calls.map((c) => c.name) });
      if (!calls.length) return res.output_text?.trim() || null;
      items.push(...(res.output as OpenAI.Responses.ResponseInputItem[]));
      for (const c of calls) items.push({ type: 'function_call_output', call_id: c.call_id, output: await run(c.name, c.arguments) });
    }
    return null;
  }

  /** Path A: one gpt-realtime session per call, in text, fed the caller's new words each turn; tool calls answered until it writes words. */
  private async realtime(input: PlannerInput, s: Session, run: (name: string, args: string) => Promise<string>, requests: PlannerTiming['requests']): Promise<string | null> {
    if (!s.ws) {
      const ws = await OpenAIRealtimeWS.create(this.openai as never, { model: this.model });
      s.ws = ws;
      s.ready = new Promise((resolve, reject) => { ws.socket.once('open', () => resolve()); ws.socket.once('error', reject); if (ws.socket.readyState === 1) resolve(); });
      await s.ready;
      ws.send({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'], instructions: toolsVoicePrompt(input.clinic, { callerNumber: input.callerNumber ?? null }), tools: realtimeTools(input.clinic) as never, tool_choice: 'auto' } });
      // the greeting was said before the caller spoke
      ws.send({ type: 'conversation.item.create', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: input.clinic.greeting }] } } as never);
    }
    const ws = s.ws;
    // the conversation since the last turn: the assistant's words (the greeting, scripts) and the caller's
    for (const t of input.state.turns.slice(s.sent)) {
      // its own last words, now on the call: already in its conversation
      if (t.speaker === 'agent' && s.lastSaid && t.text.trim() === s.lastSaid) continue;
      ws.send({ type: 'conversation.item.create', item: t.speaker === 'caller'
        ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.text }] }
        : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.text }] } } as never);
    }
    s.sent = input.state.turns.length;
    // round 2: the lookup the caller's words ask for, run before the reply and handed to it, as the voice service does
    // off by default, as on calls; ATTENDRA_LOOKUP_AHEAD=on to compare
    const spec = process.env.ATTENDRA_LOOKUP_AHEAD === 'on' ? speculativeLookup(input.state, input.clinic) : null;
    if (spec) {
      const callId = `spec_${s.sent}`;
      const args = JSON.stringify(spec.args);
      const output = await run(spec.name, args);
      ws.send({ type: 'conversation.item.create', item: { type: 'function_call', call_id: callId, name: spec.name, arguments: args } } as never);
      ws.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } } as never);
    }
    for (let round = 0; round < 8; round++) {
      const t0 = performance.now();
      const { text, calls, usage } = await new Promise<{ text: string; calls: { name: string; call_id: string; arguments: string }[]; usage: { input_tokens?: number; output_tokens?: number; input_token_details?: { cached_tokens?: number } } | undefined }>((resolve, reject) => {
        let text = '';
        const calls: { name: string; call_id: string; arguments: string }[] = [];
        const timer = setTimeout(() => { ws.off('event', on as never); reject(new Error('realtime response timed out')); }, 30_000);
        const on = (raw: unknown) => {
          const e = raw as { type: string; [k: string]: unknown };
          if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') text += e.delta;
          if (e.type === 'response.function_call_arguments.done') calls.push({ name: String(e.name), call_id: String(e.call_id), arguments: String(e.arguments ?? '{}') });
          if (e.type === 'error') { clearTimeout(timer); ws.off('event', on as never); reject(new Error(`realtime error: ${JSON.stringify(e.error).slice(0, 200)}`)); }
          if (e.type === 'response.done') {
            clearTimeout(timer); ws.off('event', on as never);
            resolve({ text, calls, usage: (e.response as { usage?: never } | undefined)?.usage });
          }
        };
        ws.on('event', on as never);
        ws.send({ type: 'response.create' });
      });
      requests.push({ ms: Math.round(performance.now() - t0), firstTokenMs: null, served: null, inputTokens: usage?.input_tokens ?? null, cachedTokens: usage?.input_token_details?.cached_tokens ?? null, outputTokens: usage?.output_tokens ?? null, reasoningTokens: null, calls: calls.map((c) => c.name) });
      if (!calls.length) {
        // what it said is now in its own conversation; the simulator adds it to the call as the assistant's turn
        s.lastSaid = text.trim() || null;
        return s.lastSaid;
      }
      for (const c of calls) ws.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: await run(c.name, c.arguments) } } as never);
    }
    return null;
  }

  /** Closes every realtime session left open. */
  close() { /* sessions close with their sockets when the process ends */ }
}
