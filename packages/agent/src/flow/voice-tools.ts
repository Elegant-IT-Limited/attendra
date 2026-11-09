// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, localName, TOOL_NAMES, type ToolName } from '@attendra/core';
import { toolDefinitions } from '../planner';
import type { ToolResult } from '../tools';
import type { FlowStage } from './booking';
import type { CallState } from '../call-state';

/** The clinic's clock: a tool of its own, the one source for the time, the day and whether the clinic is open (V-3). */
export const CLINIC_NOW = {
  type: 'function' as const,
  name: 'clinic_now',
  description: 'The clinic\'s local time, date and time zone, whether it is open now, when it closes or next opens, and whether a visit can be booked right now or is taken as a request for the team. Call it before saying anything about the time, the day, opening hours today, or "good morning/afternoon/evening" after the greeting. Never say the clinic is open or closed without it. Its days list answers "is the clinic open <day>?" for the next days, today first, holidays and special days included.',
  strict: true,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

/** Every tool the voice may call on the tools path: the backend's tools, as the planner has them, and the clinic's clock. */
export const VOICE_TOOL_NAMES = [...TOOL_NAMES, 'clinic_now'] as const;
export type VoiceToolName = ToolName | 'clinic_now';
export const isVoiceTool = (name: string): name is VoiceToolName => (VOICE_TOOL_NAMES as readonly string[]).includes(name);

/** The clinic's visit types as the voice may name them: id and name, the only ids find_slots takes on the tools path. */
export const visitTypeChoices = (clinic: ClinicConfig) => clinic.visitTypes.map((v) => ({ id: v.id, name: localName(v, 'en') }));

/**
 * The function tools for a clinic's voice on the tools path, engine-neutral (JSON schema, strict). A visit type is never
 * a guess (a test call made one up and the call died on it): find_slots takes only the clinic's own visit type ids, listed
 * in its schema with their names.
 */
export function voiceToolDefinitions(clinic: ClinicConfig) {
  const choices = visitTypeChoices(clinic);
  return [...toolDefinitions(clinic).map((t) => {
    if (t.name !== 'find_slots') return t;
    const params = t.parameters as { properties: Record<string, Record<string, unknown>> };
    return {
      ...t,
      parameters: { ...params, properties: { ...params.properties, visit_type_id: { type: 'string', enum: choices.map((c) => c.id), description: `The visit, one of: ${choices.map((c) => `${c.id} (${c.name})`).join(', ')}. Take it from what the caller asked for; when they did not say, the most likely one for what they described.` } } },
    };
  }), CLINIC_NOW];
}

/**
 * What a tool hands the voice: the same for every engine.
 * - `ok`, and `outcome`: a reason code when refused ("not_verified", "slot_taken", "after_hours"), else what happened;
 * - `spoken`: the exact words for the caller when the tool has them (said as written, or lightly smoothed, never changed);
 * - `say`: how to answer when there are no fixed words (an instruction, never to be read out);
 * - `data`: the facts (times, names, hours), nothing else is to be stated;
 * - `stage` and `next`: where the visit stands, and the next step of the booking flow.
 */
export interface VoiceToolOutput {
  ok: boolean; outcome: string; spoken?: string; say?: string; data: Record<string, unknown>; stage: FlowStage; next?: string;
}

/** The tool result shaped for the voice. */
export function shapeForVoice(name: string, result: ToolResult, stage: FlowStage, next: string | null, extras?: { visitTypes?: { id: string; name: string }[] }): VoiceToolOutput {
  // find_slots words its answer as say_as (the exact words) and note (how to use them): the same two parts as spoken and say
  const { error, say, spoken, say_as: sayAs, note, ...data } = result.data as Record<string, unknown> & { error?: unknown; say?: unknown; spoken?: unknown; say_as?: unknown; note?: unknown };
  // a visit type the clinic does not have: the ones it does, with their ids, so the next call names a real one
  if (error === 'unknown_visit_type' && extras?.visitTypes) data.visit_types = extras.visitTypes;
  const out: VoiceToolOutput = {
    ok: result.ok,
    outcome: typeof error === 'string' ? error : result.ok ? okOutcome(name, data) : 'refused',
    data, stage,
  };
  const words = [spoken, sayAs].find((w): w is string => typeof w === 'string' && !!w);
  const how = [say, note].filter((w): w is string => typeof w === 'string' && !!w).join(' ');
  if (words) out.spoken = words;
  if (how) out.say = how;
  // a tool that says what to do has the last word; the flow's next step is for when it doesn't
  if (next && !out.say && !out.spoken) out.next = next;
  else if (next && result.ok && stage === 'readback_pending' && !out.next) out.next = next;
  return out;
}

const okOutcome = (name: string, data: Record<string, unknown>) => {
  if (data.booked) return 'booked';
  if (data.cancelled) return 'cancelled';
  if (data.verified) return 'found';
  if (data.registered) return 'added';
  if (data.texted) return 'texted';
  if (data.transferring) return 'transferring';
  if (data.ending) return 'ending';
  if (name === 'find_slots') return Array.isArray(data.slots) && data.slots.length ? 'times_found' : 'no_times';
  return 'ok';
};

/**
 * The call's state in one short line, for the voice model on the tools path (batch 1d): who was found, what waits for
 * a yes, what is done. Added to its conversation when it changes, so it is still there once the oldest turns are cut.
 * Null before anything happened. No record data beyond the pet's first name the caller already heard.
 */
export function callStateNote(state: Pick<CallState, 'verifiedPatient' | 'pending' | 'done'>): string | null {
  const parts = [
    state.verifiedPatient ? `found: ${state.verifiedPatient.firstName}${state.verifiedPatient.isNew ? ' (new)' : ''}` : null,
    state.pending ? `waiting for a yes to: ${state.pending.readback}` : null,
    state.done.length ? `done: ${state.done.join('; ')}` : null,
  ].filter(Boolean);
  return parts.length ? `Call state. ${parts.join('. ')}.` : null;
}
