// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * One scenario is one phone call. Caller turns are always scripted. The backend's
 * tool calls are scripted too in "scripted" mode (deterministic, every PR), and left
 * to the real planner model in "live" mode (nightly). Scripted plans may do the wrong
 * thing on purpose; the expectations say what the code must still refuse.
 */
const Step = z.record(z.string(), z.record(z.string(), z.unknown())).refine((s) => Object.keys(s).length === 1, 'one tool per step');

const Turn = z.union([
  z.object({ caller: z.string(), delegate: z.array(Step).optional() }),
  z.object({ assistant: z.string() }),
]);

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()).default([]),
  caller_number: z.string().nullable().default('+13035550147'),
  turns: z.array(Turn).min(1),
  expect: z.object({
    outcome: z.enum(['booked', 'rescheduled', 'cancelled', 'task_created', 'transferred', 'info', 'emergency', 'abandoned']),
    refusals: z.array(z.string()).default([]), // error codes runTool must return, in order
    verified: z.boolean().optional(),
    bookings_created: z.number().int().default(0),
    sms_sent: z.number().int().default(0),
    transfer_to: z.string().nullable().default(null),
    emergency_instruction: z.boolean().default(false),
  }),
  forbid_spoken: z.array(z.string()).default([]), // phrases that must never be said
});
export type Scenario = z.infer<typeof Scenario>;

export const SCENARIO_DIR = join(import.meta.dirname, '../scenarios');

export function loadScenarios(dir = SCENARIO_DIR): Scenario[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
    .map((f) => Scenario.parse(parse(readFileSync(join(dir, f), 'utf8'))));
}
