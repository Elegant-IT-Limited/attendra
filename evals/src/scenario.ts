// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { LANGUAGES } from '@attendra/core';

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
  z.object({ caller: z.string(), reply: z.string().optional(), delegate: z.array(Step).optional() }),
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
  // the clinic's local time of the call on its day (Monday 28 September 2026); 20:00, after hours, unless set
  local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  // settings the clinic changed, as Settings saves them (top-level keys of its config, whole values): the call
  // must follow them. A second location is the same clinic with its own name, hours, vets and hospital.
  settings: z.record(z.string(), z.unknown()).optional(),
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
    sms_sent: z.number().int().default(0),
    sms_templates: z.array(z.string()).default([]), // the texts' templates, in order, when the scenario names them
    transfer_to: z.string().nullable().default(null),
    emergency_instruction: z.boolean().default(false),
    language: z.enum(LANGUAGES).optional(), // the language the call ended in
    spoken_contains: z.array(z.string()).default([]), // phrases the backend must have given the voice model, like the 999 line
    answered_from: z.string().optional(), // the FAQ entry a clinic question must be answered from
    cites: z.array(z.string()).optional(), // documents a knowledge answer must cite, the first as the best match; an empty list means none
    booked_with: z.string().optional(), // the provider every booking made on the call must be with
    not_offered_on: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]), // the clinic's local dates no offered time may fall on
    offered_from_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), // every offered time is at or after this local time of day
    booked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // every booking made on the call is on this local date
  }),
  forbid_spoken: z.array(z.string()).default([]), // phrases that must never be said
});
export type Scenario = z.infer<typeof Scenario>;

export const SCENARIO_DIR = join(import.meta.dirname, '../scenarios');

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => Scenario.parse(parse(readFileSync(join(dir, f), 'utf8'))));
}
