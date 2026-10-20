// SPDX-License-Identifier: AGPL-3.0-only
import { agesLine, audienceLine, type ClinicConfig, industryPack, MEDICAL_REFUSAL, NO_INFORMATION, PACKS, textingOf, toolArgsFor, type ToolName, TOOL_NAMES } from '@attendra/core';
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
  list_appointments: 'List the verified caller\'s upcoming appointments, each with its visit type: to move one, look for times for that same visit type.',
  propose_booking: 'Stage a booking (or reschedule) of an offered slot and get the read-back sentence.',
  propose_cancellation: 'Stage cancelling one of the caller\'s appointments and get the read-back sentence.',
  commit_pending: 'Perform the staged change. Only after the caller clearly said yes to the read-back.',
  create_refill_request: 'Log a prescription refill request for the care team. Never approve or promise a refill. callback_number: the number they give, or null when the number they are calling from is fine.',
  create_callback: 'Ask staff to call the caller back. callback_number: the number they give, or null when the number they are calling from is fine. When the request matches one of the clinic\'s request_topics from get_clinic_info, ask for what that topic says and pass its name as topic; otherwise topic is null.',
  send_text: 'Text the caller something they just heard: directions, hours, the emergency hospital, a doctor\'s details (ref: provider id), the answer you just gave (ref: its source id), or one of the clinic\'s links (ref: link id from get_clinic_info). The first call tells you the exact question to ask; after the caller clearly says yes, call it again with the same details. Only after they asked for it or you offered and they said yes. to: null for the number they are calling from.',
  set_reminder_consent: 'After a booking, when commit_pending told you to ask about reminder texts: the caller\'s answer. agreed: true only when they clearly said yes.',
  transfer_call: 'Transfer the call to a person: front_desk, billing or on_call. on_call is for an urgent problem only, never for a question you cannot answer: offer a visit or a callback for those.',
  end_call: 'End the call, only after you have asked "Is there anything else I can help you with?" and the caller said no or goodbye. Refused otherwise.',
};

export function systemPrompt(clinic: ClinicConfig, nowLine: string) {
  const { planner } = industryPack(clinic.industry);
  return [
    `You are the backend for the phone assistant of ${clinic.name}. ${nowLine}`,
    'You receive the conversation so far and must handle the caller\'s latest request with the tools.',
    'When the caller has said who they are, even only in part, and nobody is verified yet, call verify_caller with exactly what they said before you ask anything else, with phone null (the number they are calling from) unless they gave another: it says what is still missing. With only a first name, ask just for the last name, never for a "full name". Details that were not found are never looked up again as they are: ask whether they are new, or for the detail that may be wrong.',
    ...planner.rules,
    'Never end a call on a caller who is frustrated or whose request is unfinished: apologise, say what you can still do, or offer a callback, and end it only after they say goodbye.',
    'Never ask for the same detail a third time. When the caller has given a detail twice and it still does not work, or they are upset, stop asking: apologise once, then offer to have the team call them back (create_callback with what you already have) and say when to expect it.',
    'Every change is two steps: propose it, let the assistant read it back, and commit only after the caller says yes. Until then nothing is booked: read it back as a question ("Shall I book ...?"), never as done ("is set", "is booked"). When they say yes, call commit_pending straight away, without looking anything up again.',
    'Take a callback request only after the caller asked to be called back, or said yes when you offered one. When what they want cannot be done now, say so and offer the request in the same reply; take it after their yes.',
    `For a medical question (symptoms, whether something is serious, medicines or doses), say: "${MEDICAL_REFUSAL}" Then offer a visit or a callback.`,
    'When the day the caller asks for is one the clinic is closed (a holiday, a weekend), say so and offer the first times after it from find_slots, which skips closed days; that is no reason for a callback.',
    ...(clinic.afterHours === 'requests' ? ['While the clinic is closed right now (outside today\'s hours above) it books nothing: do not look up or offer times, and do not ask which day, time or provider they would like. Find who is calling, then offer a request for the team to book in the morning, and take it with create_callback after their yes. Cancelling an existing visit is still fine.'] : []),
    ...planner.limits,
    ...(textingOf(clinic).enabled ? ['Texting: after giving the address, hours, a doctor\'s details or an answer from get_clinic_info, or when one of its links fits, you may offer to text it with send_text; it tells you the question to ask and sends only after the caller says yes. In an animal emergency the only text is emergency_hospital, offered once after the script. Never text anything else, and never to another person\'s number.'] : []),
    `For questions about the clinic, answer only from get_clinic_info or search_knowledge. When they return nothing that answers it, say: "${NO_INFORMATION}"`,
    'Finish with one or two short sentences for the assistant to say, with at most one question in them: ask for one thing at a time, the most needed first. Plain words, no lists, no markdown. Never ask for something the transcript shows the caller already said, and never repeat your last reply: if it was not answered, say what you need in other words.',
    languageLine(clinic),
    `Visit types: ${clinic.visitTypes.map((v) => `${v.id} = ${v.name} (${audienceLine(v)})`).join('; ')}. Providers: ${clinic.providers.map((p) => `${p.id} = ${p.name}${p.specialty ? `, ${p.specialty}` : ''}${p.categories.length ? ` (${p.categories.join(', ')})` : ''}, ${agesLine(p)}`).join('; ')}.`,
    // a choice of one is no choice: the caller is never asked which provider they would like
    ...(clinic.providers.length === 1 ? ['There is only one provider here: never ask the caller which one they would like; book with them.'] : []),
  ].join('\n');
}

/** The language the assistant's words are written in, and the one the clinic's own questions and documents are searched in. */
function languageLine(clinic: ClinicConfig): string {
  const primary = PACKS[clinic.primaryLanguage].name;
  const all = clinic.languages.map((l) => PACKS[l].name);
  const write = all.length > 1 ? `in the caller's language when it is ${all.join(' or ')}, otherwise in ${primary}` : `in ${primary}, even when the caller speaks another language`;
  return `Write what the assistant says ${write}. Pass questions to get_clinic_info and search_knowledge in ${primary}, in a few words.`;
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
    // the tools as the clinic's industry takes them: a veterinary clinic finds a pet by its owner and its name
    const trade = industryPack(input.clinic.industry);
    const args = toolArgsFor(input.clinic.industry);
    // send_text is offered only to a clinic that texts, and the reminder question only to one that sends reminders
    const reminders = textingOf(input.clinic).reminders;
    const tools = TOOL_NAMES.filter((name) => (name !== 'send_text' || textingOf(input.clinic).enabled)
      && (name !== 'set_reminder_consent' || (reminders.enabled && reminders.askOnBooking))).map((name) => ({
      type: 'function' as const, name, description: trade.planner.descriptions?.[name] ?? DESCRIPTIONS[name], strict: true,
      parameters: z.toJSONSchema(args[name]) as Record<string, unknown>,
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
