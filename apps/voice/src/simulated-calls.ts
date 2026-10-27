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
 * demo patient, so it books nothing unless someone lets it. Any other clinic (a new
 * one has nobody on file) gets a new caller asking for times, which waits there.
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
  return newCallerAsking(clinic);
}

/** What the new caller and the scripted planner say, in the clinic's first language. */
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const ASKING = {
  en: {
    caller: (visit: string) => `Hi, I'm new to the clinic. When could I come in for ${article(visit)} ${visit}?`,
    offer: (visit: string, a: string, b: string | undefined, provider: string | undefined) => `For ${article(visit)} ${visit} I can offer ${a}${b ? `, or ${b}` : ''}${provider ? `, with ${provider}` : ''}. Would one of those work? And may I have your name?`,
    none: 'I could not find a time this week. I can have the front desk call you back.',
  },
  es: {
    caller: (visit: string) => `Hola, es la primera vez que llamo. ¿Cuándo tienen hora para ${visit}?`,
    offer: (visit: string, a: string, b: string | undefined, provider: string | undefined) => `Para ${visit} puedo ofrecerle ${a}${b ? `, o ${b}` : ''}${provider ? `, con ${provider}` : ''}. ¿Le sirve alguna? ¿Y me dice su nombre?`,
    none: 'No encontré un horario esta semana. Puedo pedir que la recepción le devuelva la llamada.',
  },
} as const;

/**
 * Any clinic but the demo's own: a new caller asks when they could come in for the first visit a new
 * caller may book, and is offered the first open times (find_slots needs no identity), then the call
 * waits for an answer. Nothing is booked or saved but the call itself.
 */
function newCallerAsking(clinic: ClinicConfig): { script: SimulatedScript; planner: Planner } | null {
  const visit = clinic.visitTypes.find((v) => v.audience !== 'existing' && !v.staffOnly) ?? clinic.visitTypes[0];
  if (!visit) return null;
  const lang = clinic.primaryLanguage === 'es' ? 'es' : 'en';
  const words = ASKING[lang];
  const name = (lang !== 'en' && visit.names?.[lang]) || visit.name;
  const plans = [
    new ScriptedPlanner([
      { tool: 'find_slots', args: { visit_type_id: visit.id, provider_id: null, from_date: null, part_of_day: 'any' } },
    ] satisfies ScriptedStep[], (r) => {
      const s = slots(r);
      return s.length ? words.offer(name, s[0]!.when, s[1]?.when, s[0]!.provider) : words.none;
    }),
  ];
  return {
    planner: new PlanQueue(plans),
    script: { turns: [{ assistant: clinic.greeting }, { caller: words.caller(name), delegate: true }] },
  };
}
