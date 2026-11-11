// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, type ExcerptLine, HANDOFF_STEPS_MAX, handoffExcerpt, type HandoffKind, type HandoffReason, type HandoffStep, type KnownNames, NO_INFORMATION } from '@attendra/core';
import type { CallState } from './call-state';
import type { ToolResult } from './tools';

/**
 * When a tool's result is a handoff (note 47): the assistant handed the call to the clinic's team (a request, a
 * callback, a transfer), or had no answer. Codes only: the kind, a fixed reason from the steps before it, and which
 * fixed line the assistant was given (its id, never its words). An emergency is recorded where the emergency machine
 * routes it (delegation.ts), not here.
 */
export interface HandoffEvent { kind: HandoffKind; reason: HandoffReason; lineId: string | null }

/** The result code a step is kept as: 'ok', the refusal's error code, or what an answer-less clinic question came to. */
export function stepResult(tool: string, result: ToolResult): string {
  if (typeof result.data.error === 'string') return result.data.error;
  if (!result.ok) return 'refused';
  if ((tool === 'get_clinic_info' || tool === 'search_knowledge') && noAnswer(result)) return outOfScope(result) ? 'out_of_scope' : 'no_answer';
  return 'ok';
}

const said = (result: ToolResult) => (typeof result.data.say === 'string' ? result.data.say : '');
/** The clinic's facts gave no answer: the line handed over is the "no information" one. */
const noAnswer = (result: ToolResult) => !result.data.answer && !(Array.isArray(result.data.passages) && result.data.passages.length) && (said(result).includes(NO_INFORMATION) || outOfScope(result));
/** The polite line for a question that is not about the clinic (knowledge outOfScopeLine), said exactly. */
const outOfScope = (result: ToolResult) => said(result).startsWith('Say exactly:') && Array.isArray(result.data.passages) && !result.data.passages.length && !('today' in result.data);

/** Identity refusals: the caller could not be found or checked. */
const IDENTITY = new Set(['too_many_attempts', 'not_verified', 'number_not_opened', 'owner_check', 'identity_required', 'verify_first', 'last_four_no_match', 'no_pets_on_number', 'guardian_required']);
/** The tools broke, not the rules: a failed run, or arguments the model got wrong. */
const TOOL_ERROR = new Set(['tool_failed', 'invalid_arguments', 'backend_error']);

/** The reason behind a handoff, from the steps before it, newest first: what went wrong just before the team was needed. */
export function reasonFromSteps(steps: readonly HandoffStep[]): HandoffReason | null {
  for (const s of [...steps].reverse()) {
    if (s.result === 'medical_question') return 'policy_refusal';
    if (IDENTITY.has(s.result)) return 'identity_not_verified';
    if (TOOL_ERROR.has(s.result)) return 'tool_error';
    if (s.result === 'no_answer') return 'no_answer_in_clinic_info';
    if (s.result === 'out_of_scope') return 'out_of_scope';
  }
  return null;
}

/**
 * The handoff a tool's result is, or null. A callback or a transfer the caller asked for with nothing gone wrong before
 * it is "caller asked for a person"; a refill is the team's by rule ("policy refusal": only the team approves
 * medicine); a clinic question with no answer is "no answer", or "out of scope", or a refused medical question.
 */
export function handoffFor(tool: string, args: unknown, result: ToolResult, state: Pick<CallState, 'emergencyLocked'>, before: readonly HandoffStep[]): HandoffEvent | null {
  const emergency = state.emergencyLocked;
  if (tool === 'create_callback' && result.ok && !result.data.error) {
    return emergency ? { kind: 'emergency', reason: 'emergency', lineId: 'urgent_request_taken' } : { kind: 'callback', reason: reasonFromSteps(before) ?? 'caller_asked_person', lineId: 'callback_taken' };
  }
  if (tool === 'create_refill_request' && result.ok && !result.data.error) return { kind: 'request', reason: 'policy_refusal', lineId: 'refill_taken' };
  if (tool === 'transfer_call' && result.ok && result.data.transferring) {
    const target = (args as { target?: unknown } | null)?.target;
    return emergency || target === 'on_call' ? { kind: 'emergency', reason: 'emergency', lineId: 'transfer' } : { kind: 'transfer', reason: reasonFromSteps(before) ?? 'caller_asked_person', lineId: 'transfer' };
  }
  if (tool === 'get_clinic_info' || tool === 'search_knowledge') {
    if (result.data.error === 'medical_question') return { kind: 'no_answer', reason: 'policy_refusal', lineId: 'medical_refusal' };
    const code = stepResult(tool, result);
    if (code === 'out_of_scope') return { kind: 'no_answer', reason: 'out_of_scope', lineId: 'out_of_scope' };
    if (code === 'no_answer') return { kind: 'no_answer', reason: 'no_answer_in_clinic_info', lineId: 'no_information' };
  }
  return null;
}

/** The last steps before a handoff, as kept with it. */
export const lastSteps = (steps: readonly HandoffStep[]) => steps.slice(-HANDOFF_STEPS_MAX);

/** Names the tools saw on this call, by kind: their arguments and results (owner_name, pet_name, a found pet's owner). */
export interface SeenNames { people: Set<string>; pets: Set<string> }
export const seenNames = (): SeenNames => ({ people: new Set(), pets: new Set() });
const PEOPLE_KEYS = ['owner_name', 'full_name', 'first_name', 'last_name', 'name', 'guardian_name', 'caller_name'] as const;
const PET_KEYS = ['pet_name'] as const;
/** Adds the names in a tool's arguments and result to what the call has seen. */
export function noteNames(seen: SeenNames, args: unknown, data: Record<string, unknown>) {
  for (const o of [args, data]) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    for (const k of PEOPLE_KEYS) if (typeof r[k] === 'string' && r[k]) seen.people.add(r[k] as string);
    for (const k of PET_KEYS) if (typeof r[k] === 'string' && r[k]) seen.pets.add(r[k] as string);
    if (Array.isArray(r.pets)) for (const p of r.pets) if (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string') seen.pets.add((p as { name: string }).name);
  }
}

/** Every name this call knows, by kind, for masking an excerpt: the caller and owners, the pets, the clinic's vets. */
export function knownNames(state: CallState, clinic: ClinicConfig, seen: SeenNames = seenNames()): KnownNames {
  const p = state.verifiedPatient;
  const pet = !!p?.species || !!p?.guardianName;
  const people = [state.memory.get('saidName'), ...state.memory.namesChecked.map((c) => c.name), p?.guardianName, pet ? null : p?.firstName, ...seen.people];
  const pets = [...state.memory.pets, state.memory.get('petName'), state.known.get('pet\'s name'), pet ? p?.firstName : null, ...seen.pets];
  return {
    people: [...new Set(people.filter((n): n is string => typeof n === 'string' && !!n.trim()))],
    pets: [...new Set(pets.filter((n): n is string => typeof n === 'string' && !!n.trim()))],
    vets: clinic.providers.map((v) => v.name),
  };
}

/** The masked excerpt around a handoff now, when the clinic keeps them (note 47, Level 2); null otherwise. */
export function excerptFor(state: CallState, clinic: ClinicConfig, atMs: number, seen?: SeenNames): ExcerptLine[] | null {
  if (!clinic.handoffExcerpts) return null;
  const lines = handoffExcerpt(state.turns, atMs, knownNames(state, clinic, seen));
  return lines.length ? lines : null;
}
