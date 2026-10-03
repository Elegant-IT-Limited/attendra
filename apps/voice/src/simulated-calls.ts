// SPDX-License-Identifier: AGPL-3.0-only
import { type Planner, type PlannerInput, ScriptedPlanner, type ScriptedStep, type ToolResult } from '@attendra/agent';
import { type ClinicConfig, DEMO_CLINIC, type ToolName } from '@attendra/core';
import type { SimulatedScript } from '@attendra/voice-engine';

/** Each delegation gets the next scripted plan, as a model would decide turn by turn. */
class PlanQueue implements Planner {
  constructor(private readonly plans: ScriptedPlanner[]) {}
  plan(input: PlannerInput, execute: (name: ToolName, args: unknown) => Promise<ToolResult>) {
    const next = this.plans.shift();
    return next ? next.plan(input, execute) : Promise.resolve({ say: null });
  }
}

const slots = (r: ToolResult[]) => (r.find((x) => Array.isArray(x.data.slots))?.data.slots ?? []) as { slot_id: string; when: string; provider?: string }[];
const readback = (r: ToolResult[]) => String(r.at(-1)?.data.say ?? '').replace(/^[^:]*:\s*/, '').replace(/\.$/, '');
const first = (r: ToolResult[]) => ({ slot_id: slots(r)[0]?.slot_id ?? 'none', replaces_appointment_id: null });

/**
 * A booking call that stops at the read-back, waiting for a yes: the moment staff
 * most want to see. It runs through the real agent, tools and database, with the
 * demo patient, so it books nothing unless someone lets it.
 */
export function simulatedCallFor(clinic: ClinicConfig): { script: SimulatedScript; planner: Planner } | null {
  let offered: ToolResult[] = [];
  const keep = (r: ToolResult[]) => { offered = r; return r; };
  if (clinic.id === DEMO_CLINIC.id) {
    const plans = [
      new ScriptedPlanner([
        { tool: 'verify_caller', args: { full_name: 'Maria Delgado', date_of_birth: 'March 4th 1985', phone: '303 555 0147' } },
        { tool: 'find_slots', args: { visit_type_id: 'vt_sick', provider_id: null, from_date: null, part_of_day: 'any' } },
      ] satisfies ScriptedStep[], (r) => {
        const s = slots(keep(r));
        return s.length ? `Thanks, Maria, I've found your record. For a sick visit I can offer ${s[0]!.when}, or ${s[1]?.when ?? 'another time'}, with ${s[0]!.provider}.` : 'I could not find a time. I can have the front desk call you back.';
      }),
      new ScriptedPlanner([{ tool: 'propose_booking', args: () => first(offered) }], (r) => `Just to confirm: ${readback(r)}. Is that right?`),
    ];
    return {
      planner: new PlanQueue(plans),
      script: {
        turns: [
          { assistant: clinic.greeting },
          { caller: 'Hi, this is Maria Delgado, born March 4th 1985, my number is 303 555 0147. My knee has been hurting and I would like to be seen this week.', delegate: true },
          { caller: 'The first one works for me.', delegate: true },
        ],
      },
    };
  }
  return null;
}
