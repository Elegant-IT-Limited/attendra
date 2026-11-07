// SPDX-License-Identifier: AGPL-3.0-only
import { afterTool, type CallState, type FlowMemory, flowStage, nextStep, type Planner, type PlannerInput, type PlannerOutput, type PlannerTiming, shapeForVoice, speculativeLookup, type ToolResult, visitTypeChoices, voiceToolDefinitions } from '@attendra/agent';
import { addDays, clinicNow, clinicNowLine, type ClinicConfig, localDateOf, type ToolName, weekdayOf } from '@attendra/core';
import { realtimeTools, sayToolQuestion, toolQuestion, toolsBackendInstructions, toolsVoicePrompt, turnNoteFor } from '@attendra/voice-engine';
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

interface Session { flow: FlowMemory; sent: number; lastSaid: string | null; notes?: number; ws?: OpenAIRealtimeWS; ready?: Promise<void> }

export class ToolsPathPlanner implements Planner {
  private readonly sessions = new WeakMap<CallState, Session>();
  /** The call's open socket: scenarios run one after another, so a new call closes the last one's (a socket left open hits OpenAI's 60-minute limit and its error ends the run). */
  private open: OpenAIRealtimeWS | null = null;
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
      this.close();
      const ws = await OpenAIRealtimeWS.create(this.openai as never, { model: this.model });
      // errors after a call ended (session_expired) are not a failed eval; a call's own errors reach it through its events
      ws.on('error', () => {});
      s.ws = ws;
      this.open = ws;
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
    // the per-turn note a call gets after each caller turn on path A, dated by the scenario's clock (the last one removed)
    if (s.notes) ws.send({ type: 'conversation.item.delete', item_id: `turn_note_${s.notes}` } as never);
    s.notes = (s.notes ?? 0) + 1;
    ws.send({ type: 'conversation.item.create', item: { id: `turn_note_${s.notes}`, type: 'message', role: 'system', content: [{ type: 'input_text', text: turnNoteFor(input.clinic, input.now ?? new Date()) }] } } as never);
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
    // a tool's own question is the next reply, as written, as on a call
    let question: string | null = null;
    for (let round = 0, retried = false; round < 8; round++) {
      const t0 = performance.now();
      const answer = () => new Promise<{ text: string; calls: { name: string; call_id: string; arguments: string }[]; usage: { input_tokens?: number; output_tokens?: number; input_token_details?: { cached_tokens?: number } } | undefined }>((resolve, reject) => {
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
            const response = e.response as { usage?: never; status?: string; status_details?: unknown } | undefined;
            // a response the service failed (rate limits, a server error) is said so, never taken for silence
            if (response?.status === 'failed') { reject(new Error(`realtime response failed: ${JSON.stringify(response.status_details).slice(0, 200)}`)); return; }
            resolve({ text, calls, usage: response?.usage });
          }
        };
        ws.on('event', on as never);
        ws.send((question ? { type: 'response.create', response: { instructions: sayToolQuestion(question), tool_choice: 'none' } } : { type: 'response.create' }) as never);
      });
      let reply: Awaited<ReturnType<typeof answer>>;
      try { reply = await answer(); }
      catch (err) {
        // once, after a pause: one failed response is the service, not the planner
        if (retried) throw err;
        retried = true;
        console.error(`  path A: ${(err as Error).message}; trying once more`);
        await new Promise((r) => setTimeout(r, 2_000));
        reply = await answer();
      }
      const { text, calls, usage } = reply;
      requests.push({ ms: Math.round(performance.now() - t0), firstTokenMs: null, served: null, inputTokens: usage?.input_tokens ?? null, cachedTokens: usage?.input_token_details?.cached_tokens ?? null, outputTokens: usage?.output_tokens ?? null, reasoningTokens: null, calls: calls.map((c) => c.name) });
      if (!calls.length) {
        // what it said is now in its own conversation; the simulator adds it to the call as the assistant's turn
        s.lastSaid = text.trim() || null;
        return s.lastSaid;
      }
      question = null;
      for (const c of calls) {
        const output = await run(c.name, c.arguments);
        question = toolQuestion(output) ?? question;
        ws.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output } } as never);
      }
    }
    return null;
  }

  /** Closes every realtime session left open. */
  close() { try { this.open?.close(); } catch { /* already closed */ } this.open = null; }
}
