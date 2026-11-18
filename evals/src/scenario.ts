// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { EMERGENCY_RESULTS, LANGUAGES } from '@attendra/core';

/**
 * One scenario is one phone call. Caller turns are always scripted. The backend's
 * tool calls are scripted too in "scripted" mode (deterministic, every PR), and left
 * to the real planner model in "live" mode (nightly). Scripted plans may do the wrong
 * thing on purpose; the expectations say what the code must still refuse.
 */
const Step = z.record(z.string(), z.record(z.string(), z.unknown())).refine((s) => Object.keys(s).length === 1, 'one tool per step');

const Turn = z.union([
  // reply: what the voice model says back, as it would appear in the call transcript.
  // Only the demo recording and the forbid_spoken check read it; the agent logic runs
  // on the tool results, exactly as in a live call. {offered.N}, {readback} and
  // {booked} are filled in from the call as it happened.
  // dropped: the voice let this turn go, with no reply and no hand-off (a test call, 2026-10-26); the call's watchdog
  // gives the voice the caller's words back after 5 s, and the hand-off follows. Never answered with "say that again".
  z.object({ caller: z.string(), reply: z.string().optional(), delegate: z.array(Step).optional(), dropped: z.boolean().optional() }),
  z.object({ assistant: z.string() }),
]);

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()).default([]),
  // which demo clinic takes the call: Maple Street (English and Spanish), Cedar Park (English), or Riverbend, the veterinary clinic
  clinic: z.enum(['maple', 'cedar_park', 'riverbend']).default('maple'),
  // defaults to the clinic's first demo patient: Maria at Maple Street, Ruth at Cedar Park, Biscuit's owner at Riverbend
  caller_number: z.string().nullable().optional(),
  // a browser test call from the dashboard, with no transfers: no caller ID when caller_number is null, or "called as"
  // that number when it is set (the test-call page's Call as), which the call treats as its caller ID
  channel: z.enum(['phone', 'web']).default('phone'),
  // the caller speaks over the greeting ("Hello?"): the call has only its first words, and must never start it again
  greeting_interrupted: z.boolean().default(false),
  // the voice says nothing when the call connects: the real call runner must have it greet within 2 s, once
  silent_start: z.boolean().default(false),
  // the clinic's local time of the call on its day (Monday 28 September 2026); 20:00, after hours, unless set
  local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  // settings the clinic changed, as Settings saves them (top-level keys of its config, whole values): the call
  // must follow them. A second location is the same clinic with its own name, hours, vets and hospital.
  settings: z.record(z.string(), z.unknown()).optional(),
  // what the clinic's records say about the number calling, as the voice service gives it to the backend
  // ("Name on file for this number: Carmen."): a known caller is greeted by name
  history: z.string().optional(),
  turns: z.array(Turn).min(1),
  // live only: what the caller knows beyond their scripted lines (a pharmacy, a callback number, a yes to a
  // reminder). With it, a model playing the caller answers the real planner's follow-up questions after the
  // scripted lines run out, up to four lines, so a call is judged on how it ends, not on a script it outran
  facts: z.string().optional(),
  expect: z.object({
    outcome: z.enum(['booked', 'rescheduled', 'cancelled', 'task_created', 'transferred', 'info', 'emergency', 'abandoned']),
    refusals: z.array(z.string()).default([]), // error codes runTool must return, in order
    verified: z.boolean().optional(),
    bookings_created: z.number().int().default(0),
    // requests for the team made on the call that are flagged urgent (one taken during an animal's emergency)
    urgent_requests: z.number().int().optional(),
    sms_sent: z.number().int().default(0),
    sms_templates: z.array(z.string()).default([]), // the texts' templates, in order, when the scenario names them
    // what each text says, in order: every key and value given is in that text's details ({ pet: Biscuit, visit: dental check-up })
    sms_vars: z.array(z.record(z.string(), z.string())).default([]),
    transfer_to: z.string().nullable().default(null),
    emergency_instruction: z.boolean().default(false),
    // how the call's emergency ended, as the Calls page shows it ('cleared' is "Emergency cleared"; note 49 B1)
    emergency_result: z.enum(EMERGENCY_RESULTS).optional(),
    language: z.enum(LANGUAGES).optional(), // the language the call ended in
    spoken_contains: z.array(z.string()).default([]), // phrases the backend must have given the voice model, like the 999 line
    // phrases the backend's tool results gave the planner (a vet's own field from get_clinic_info), and ones they never gave (a field kept for the team)
    returned: z.array(z.string()).default([]),
    never_returned: z.array(z.string()).default([]),
    // the same, on the Vapi path only, as its voice gets them (core forVapiVoice: "Doctor Maya Chen", "8, 8:30 or 9 AM")
    vapi_returned: z.array(z.string()).default([]),
    vapi_never_returned: z.array(z.string()).default([]),
    // lines said on the Vapi call through its control URL (a correction our rules decided), each exactly as said
    vapi_said: z.array(z.string()).default([]),
    answered_from: z.string().optional(), // the FAQ entry a clinic question must be answered from
    cites: z.array(z.string()).optional(), // documents a knowledge answer must cite, the first as the best match; an empty list means none
    booked_with: z.string().optional(), // the provider every booking made on the call must be with
    offered_with: z.array(z.string()).optional(), // every time offered on the call is with one of these providers (a pet's kind of animal, K1)
    not_offered_on: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]), // the clinic's local dates no offered time may fall on
    offered_from_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), // every offered time is at or after this local time of day
    booked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // every booking made on the call is on this local date
    // every booking made on the call, in time order: its local date and time and its visit type (two visits for one pet, 2026-11-16)
    bookings: z.array(z.object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), visit: z.string() })).optional(),
    // the found pet's visits still booked when the call ends (any booked before it too), in time order: a move or a
    // cancellation touched only the visit the caller picked (call bugs, 2026-11-17)
    visits_after: z.array(z.object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), visit: z.string() })).optional(),
    hung_up: z.boolean().optional(),
    // the team's note on the appointments made on the call (decrypted), each phrase in one of them ("booked by caller: Alex"),
    // or no note on any of them
    appointment_note_contains: z.array(z.string()).default([]),
    appointment_note_empty: z.boolean().default(false),
    // live only: what the planner model read the caller wanting from the call, into the call memory (2026-11-14); scripted
    // runs have no model to read it, so the check is skipped there
    intent: z.enum(['book', 'move', 'cancel', 'question']).optional(),
    // the first thing the assistant says after the caller's first line contains this (the number question at once, or not)
    first_reply_contains: z.string().optional(),
    // a pet on file on that number when the call ends, with the kind of animal its record says (a pet added on the call
    // as the caller described it, never asked twice)
    pet_on_file: z.object({ phone: z.string(), name: z.string(), species: z.string() }).optional(),
    // the first names on file for this number when the call ends, in any order, read the way the pet page reads a
    // household (everyone on the same phone): a pet added on the call joins its owner's number, and nobody else's
    household: z.object({ phone: z.string(), names: z.array(z.string()).min(1) }).optional(), // the assistant ended the call itself (an abusive caller after the warning, or a finished call)
    // live only: a line the planner wrote asks what the caller already answered, or asks two things at once
    no_repeated_questions: z.boolean().default(true),
    one_question_per_reply: z.boolean().default(true),
  }),
  forbid_spoken: z.array(z.string()).default([]), // phrases that must never be said
});
export type Scenario = z.infer<typeof Scenario>;

export const SCENARIO_DIR = join(import.meta.dirname, '../scenarios');

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => Scenario.parse(parse(readFileSync(join(dir, f), 'utf8'))));
}
