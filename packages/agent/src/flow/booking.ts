// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, industryPack, PACKS } from '@attendra/core';
import type { CallState } from '../call-state';

/**
 * Where a visit stands on this call, read from the call state itself (never kept apart from it, so it cannot drift):
 *   idle → number_asked → number_confirmed → pet_chosen → times_offered → readback_pending → done
 * The voice cannot skip a step: the tools refuse a write out of order (a booking needs an offered time, a read-back
 * spoken, and the caller's clear yes since it), and every tool result says what comes next (`next`).
 */
export type FlowStage = 'idle' | 'number_asked' | 'number_confirmed' | 'pet_chosen' | 'times_offered' | 'readback_pending' | 'done';
export const FLOW_STAGES: readonly FlowStage[] = ['idle', 'number_asked', 'number_confirmed', 'pet_chosen', 'times_offered', 'readback_pending', 'done'];

/** The tools that change something: after one of these succeeds the visit is done, until the caller asks for another. */
const COMMITS = new Set(['commit_pending']);
/** The tools that start a new visit on the same call: a done visit is no longer the last word. */
const RESTARTS = new Set(['find_slots', 'propose_booking', 'propose_cancellation', 'list_appointments']);

/** What the flow keeps beyond the call state: whether the last write is the last word yet. Part of the call state's JSON. */
export interface FlowMemory { committedAt: number | null }

export function flowStage(state: CallState, flow: FlowMemory): FlowStage {
  if (state.pending) return 'readback_pending';
  if (flow.committedAt !== null) return 'done';
  if (state.verifiedPatient) return state.offered.size ? 'times_offered' : 'pet_chosen';
  if (state.memory.verified || state.phonesConfirmed.size || state.memory.get('number')?.readBack) return 'number_confirmed';
  if (state.phoneReadback) return 'number_asked';
  return state.offered.size ? 'times_offered' : 'idle';
}

/** Moves the flow on after a tool ran. */
export function afterTool(flow: FlowMemory, name: string, ok: boolean, turn: number) {
  if (ok && COMMITS.has(name)) flow.committedAt = turn;
  else if (RESTARTS.has(name)) flow.committedAt = null;
}

/**
 * What to do next, from where the visit stands, in the call's language where words are said: the order of a booking
 * as code (number first, then the pet, times before questions, a read-back as a question, the yes, then the commit),
 * instead of rules in a prompt. Null when the tool's own result already says what to do, or nothing needs doing.
 */
export function nextStep(stage: FlowStage, state: CallState, clinic: ClinicConfig, callerNumber: string | null): string | null {
  const pack = PACKS[state.language];
  const pets = industryPack(clinic.industry).identity === 'pet';
  switch (stage) {
    case 'idle':
      if (!pets) return 'For a visit, find the patient first with verify_caller: their full name and date of birth, phone null for the number they are calling from.';
      return `For a visit, the number comes first: ask "${pack.profileNumberQuestion({ last4: callerNumber ? callerNumber.replace(/\D/g, '').slice(-4) : null })}" then call verify_caller with what they say (phone null when it is the number they are calling from) and pet_name when they named the pet. A question about the clinic needs no number: answer it with get_clinic_info.`;
    case 'number_asked':
      return 'Wait for the caller\'s answer to the number read-back. On a yes, call verify_caller again with the same number; on a no, ask for the number again.';
    case 'number_confirmed':
      return state.memory.pets.length
        ? 'The number is confirmed. Ask which pet the visit is for (the tool result has the words), then call verify_caller with pet_name.'
        : 'The number is confirmed. Ask the pet\'s name, then call verify_caller with it; a pet not on the number is new: register_patient.';
    case 'pet_chosen':
      return 'Offer times now: call find_slots with the most likely visit type (a check-up for a well animal, a sick visit when they describe a problem) and the day and time they asked for; say which visit the times are for. Do not ask about preferences first.';
    case 'times_offered':
      return 'Offer at most three of the times returned, with the weekday and date. When the caller picks one, call propose_booking with its slot_id; when they want another day or time, call find_slots again.';
    case 'readback_pending':
      return `Read the change back as a question, in these words: "${state.pending!.readback}?" Then wait. On a clear yes, call commit_pending at once, before anything else; on a no or a change, ask what to change.`;
    case 'done':
      return `It is done: say so in the words given, then ask "${pack.spoken.anythingElse}"`;
    default:
      return null;
  }
}
