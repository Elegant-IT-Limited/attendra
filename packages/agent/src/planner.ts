// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, ToolArgs, type ToolName, TOOL_NAMES } from '@attendra/core';
import type OpenAI from 'openai';
import type { ResponseInput, ResponseInputItem } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { CallState } from './call-state';
import type { ToolResult } from './tools';

/**
 * The planner decides which tools to call for one delegated request and what the
 * result sentence should be. It never touches data itself: every call goes through
 * runTool, where the safety rules live. That split is what lets the evals swap in a
 * scripted planner and prove the rules hold whatever a model decides.
 */
export interface Planner {
  plan(input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>): Promise<PlannerOutput>;
}

export interface PlannerInput { clinic: ClinicConfig; state: CallState; nowLine: string }
export interface PlannerOutput { say: string | null; quiet?: string }

const DESCRIPTIONS: Record<ToolName, string> = {
  verify_caller: 'Verify the caller by full name and date of birth before anything about their own record.',
  get_clinic_info: 'Hours, address, parking, insurance and preparation questions, from the clinic FAQ.',
  find_slots: 'Find up to 3 open appointment slots. Returns slot ids to offer.',
  list_appointments: 'List the verified caller\'s upcoming appointments.',
  propose_booking: 'Stage a booking (or reschedule) of an offered slot and get the read-back sentence.',
  propose_cancellation: 'Stage cancelling one of the caller\'s appointments and get the read-back sentence.',
  commit_pending: 'Perform the staged change. Only after the caller clearly said yes to the read-back.',
  create_refill_request: 'Log a prescription refill request for the care team. Never approve or promise a refill.',
  create_callback: 'Ask staff to call the caller back.',
  transfer_call: 'Transfer the call to a person: front_desk, billing or on_call.',
  end_call: 'End the call after saying goodbye.',
};

export function systemPrompt(clinic: ClinicConfig, nowLine: string) {
  return [
    `You are the backend for the phone assistant of ${clinic.name}. ${nowLine}`,
    'You receive the conversation so far and must handle the caller\'s latest request with the tools.',
    'Rules: verify identity before anything about the caller\'s own records. Offer only slots returned by find_slots.',
    'Every change is two steps: propose it, let the assistant read it back, and commit only after the caller says yes.',
    'Never give medical advice, never interpret symptoms, never promise a refill. Offer a callback or a transfer instead.',
    'Finish with one or two short sentences for the assistant to say. Plain words, no lists, no markdown.',
    `Visit types: ${clinic.visitTypes.map((v) => `${v.id} = ${v.name}`).join('; ')}. Providers: ${clinic.providers.map((p) => `${p.id} = ${p.name}`).join('; ')}.`,
  ].join('\n');
}

function transcriptFor(state: CallState): string {
  return state.turns.slice(-24).map((t) => `${t.speaker === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`).join('\n');
}

/**
 * The production planner: the Responses API with our tools as strict function
 * tools. store: false keeps the request inside Zero Data Retention, which also means
 * we resend the running input (with the model's encrypted reasoning) each round
 * instead of chaining response ids.
 */
export class ResponsesPlanner implements Planner {
  constructor(private readonly openai: OpenAI, private readonly model: string, private readonly maxRounds = 5) {}

  async plan(input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>): Promise<PlannerOutput> {
    const tools = TOOL_NAMES.map((name) => ({
      type: 'function' as const, name, description: DESCRIPTIONS[name], strict: true,
      parameters: z.toJSONSchema(ToolArgs[name]) as Record<string, unknown>,
    }));
    const state = input.state;
    const conversation: ResponseInput = [{ role: 'user', content: `Conversation so far:\n${transcriptFor(state)}\n\nKnown state: ${stateLine(state)}` }];

    for (let round = 0; round < this.maxRounds; round++) {
      const res = await this.openai.responses.create({
        model: this.model, instructions: systemPrompt(input.clinic, input.nowLine), input: conversation, tools, store: false,
        // with store: false the model's reasoning must travel with the request, encrypted
        include: ['reasoning.encrypted_content'],
      });
      const calls = res.output.filter((o) => o.type === 'function_call');
      if (!calls.length) return { say: res.output_text?.trim() || null };
      for (const item of res.output) {
        if (item.type === 'function_call' || item.type === 'reasoning' || item.type === 'message') conversation.push(item as ResponseInputItem);
      }
      for (const call of calls) {
        const name = call.name as ToolName;
        const result = TOOL_NAMES.includes(name)
          ? await execute(name, safeJson(call.arguments))
          : { ok: false, data: { error: 'unknown_tool' } };
        conversation.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result.data) });
      }
    }
    return { say: 'Let me have someone from the clinic call you back about that.' };
  }
}

export function stateLine(state: CallState): string {
  return [
    state.verifiedPatient ? `caller verified as ${state.verifiedPatient.firstName}` : 'caller not verified',
    state.pending ? `waiting for a yes to: ${state.pending.readback}` : 'nothing pending',
    state.offered.size ? `${state.offered.size} slots offered` : 'no slots offered yet',
  ].join('; ');
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
