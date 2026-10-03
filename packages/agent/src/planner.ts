// SPDX-License-Identifier: AGPL-3.0-only
import { agesLine, audienceLine, type ClinicConfig, NO_INFORMATION, ToolArgs, type ToolName, TOOL_NAMES } from '@attendra/core';
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

/** `callerNumber` is the number the call came from, when there is one. */
export interface PlannerInput { clinic: ClinicConfig; state: CallState; nowLine: string; callerNumber?: string | null }
export interface PlannerOutput { say: string | null; quiet?: string }

const DESCRIPTIONS: Record<ToolName, string> = {
  verify_caller: 'Verify the patient by full name, date of birth and the phone number on their file (null: the number they are calling from) before booking, changing or reading anything of theirs. For a child, use the child\'s name and date of birth and the family phone. Call it again to switch to another family member.',
  register_patient: 'Add a new patient. Only after verify_caller found no match and the caller says they are new to the clinic. Needs first and last name, date of birth, gender (female, male, other, or undisclosed when they prefer not to say; ask, never guess) and phone; for anyone under 18 also the parent or guardian\'s name. They are then verified and can book.',
  get_clinic_info: 'Hours for today and the next 7 days, the doctors (specialty, what they see people for, ages, visit types, weekly hours, time off, whether they take new patients), the visit types, and the clinic FAQ. Also returns passages from the clinic\'s documents when the FAQ has no answer. No identity needed.',
  search_knowledge: 'Search the clinic\'s own documents (parking, directions, insurance, visit preparation, policies, providers). Pass a short topic, never a name, date of birth or other personal detail. Answer only from what it returns.',
  find_slots: 'Find up to 3 open appointment slots, optionally with one doctor (provider_id), with doctors of one specialty or category from get_clinic_info (specialty), or with a female or male doctor when the caller asks (provider_gender). No identity needed: use it to answer "who is free Monday" or "when can I come in" before asking who they are. Once a patient is verified it only offers doctors who see their age. Returns slot ids to offer. Set from_date to the first day the caller asked for ("next week" is the coming Monday); null means today.',
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
    'Rules: verify the patient (name, date of birth and phone) before booking, changing or reading anything of theirs. Anyone may hear the doctors, their specialties, hours and open times without being verified: answer those from get_clinic_info and find_slots. Before booking, ask whether the visit is for the caller or someone else, such as their child. If verification finds nobody and they say they are new, add them with register_patient. Offer only slots returned by find_slots.',
    'Choosing the doctor: when the caller wants a visit and has not named a doctor, ask once whether they would like a particular doctor or a particular kind of doctor. Match what they ask for (a name, a specialty or department such as pediatrics, or a category such as women\'s health) to the doctors from get_clinic_info, suggest the matching doctors by name and specialty, and pass find_slots their provider_id or the specialty. Match only against the clinic\'s own list. If the caller only describes symptoms, do not decide what kind of doctor they need: ask which doctor or kind of doctor they would like, or offer the clinic\'s family doctors. If they have no preference, search all doctors.',
    'Every change is two steps: propose it, let the assistant read it back, and commit only after the caller says yes.',
    'Never give medical advice, never interpret symptoms, never promise a refill. Offer a callback or a transfer instead.',
    `For questions about the clinic, answer only from get_clinic_info or search_knowledge. When they return nothing that answers it, say: "${NO_INFORMATION}"`,
    'Finish with one or two short sentences for the assistant to say. Plain words, no lists, no markdown.',
    `Visit types: ${clinic.visitTypes.map((v) => `${v.id} = ${v.name} (${audienceLine(v)})`).join('; ')}. Providers: ${clinic.providers.map((p) => `${p.id} = ${p.name}${p.specialty ? `, ${p.specialty}` : ''}${p.categories.length ? ` (${p.categories.join(', ')})` : ''}, ${agesLine(p)}`).join('; ')}.`,
  ].join('\n');
}

function transcriptFor(state: CallState): string {
  return state.turns.slice(-24).map((t) => `${t.speaker === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`).join('\n');
}

/**
 * The production planner: the Responses API with our tools as strict function
 * tools. store: false keeps the request inside Zero Data Retention, which also means
 * we resend the running input (with the model's encrypted reasoning) each round
 * instead of chaining response ids. A caller is waiting, so each round has a short
 * timeout, and the rounds and each round's output are capped: that is the ceiling
 * on what one delegation can cost.
 */
export class ResponsesPlanner implements Planner {
  constructor(
    private readonly openai: Pick<OpenAI, 'responses'>, private readonly model: string, private readonly maxRounds = 5,
    private readonly limits = { timeoutMs: 15_000, maxOutputTokens: 1_000 },
  ) {}

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
        max_output_tokens: this.limits.maxOutputTokens,
        // with store: false the model's reasoning must travel with the request, encrypted
        include: ['reasoning.encrypted_content'],
      }, { timeout: this.limits.timeoutMs, maxRetries: 1 });
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
    // out of rounds: a callback that is promised is one that exists, taken through the same
    // tool the model would use, so its rules and the request for staff apply
    if (input.callerNumber) {
      const taken = await execute('create_callback', { reason: 'The assistant could not finish the caller\'s request', callback_number: input.callerNumber });
      if (taken.ok) return { say: 'I wasn\'t able to finish that, so I\'ve asked someone from the clinic to call you back at the number you\'re calling from.' };
    }
    return { say: 'I wasn\'t able to finish that. Would you like someone from the clinic to call you back? If so, tell me the best number to reach you.' };
  }
}

export function stateLine(state: CallState): string {
  return [
    state.verifiedPatient ? `patient verified as ${state.verifiedPatient.firstName}${state.verifiedPatient.isNew ? ' (new patient)' : ''}` : 'patient not verified',
    state.pending ? `waiting for a yes to: ${state.pending.readback}` : 'nothing pending',
    state.offered.size ? `${state.offered.size} slots offered` : 'no slots offered yet',
  ].join('; ');
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
