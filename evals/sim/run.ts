// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm sim --scenarios 20`: a model plays each persona in personas.yaml against the
// real assistant, as text, and the quality numbers are printed. It calls OpenAI, for
// the caller and for the planner, so it needs OPENAI_API_KEY and costs credit. CI
// never runs it; the manual quality workflow does.
import { ResponsesPlanner } from '@attendra/agent';
import { qualityOf } from '@attendra/core';
import OpenAI from 'openai';
import { ModelCaller } from './caller';
import { loadPersonas, type Simulation, simulate } from './simulate';

if (!process.env.OPENAI_API_KEY) {
  console.error('pnpm sim calls OpenAI for the caller and the planner: set OPENAI_API_KEY');
  process.exit(2);
}
const arg = process.argv.indexOf('--scenarios');
const count = arg > 0 ? Math.max(1, Number(process.argv[arg + 1]) || 1) : 8;
const personas = loadPersonas();
const openai = new OpenAI();
const plannerModel = process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna';
const callerModel = process.env.ATTENDRA_SIM_MODEL ?? 'gpt-6-luna';
console.log(`attendra sim  ${count} calls · planner ${plannerModel} · caller ${callerModel}\n`);

const runs: Simulation[] = [];
for (let i = 0; i < count; i++) {
  const persona = personas[i % personas.length]!;
  const run = await simulate(persona, new ModelCaller(openai, callerModel, persona), new ResponsesPlanner(openai, plannerModel));
  runs.push(run);
  console.log(`  ${run.goalMet ? 'met ' : 'MISS'}  ${persona.id.padEnd(20)} ${String(run.result.outcome).padEnd(13)} ${run.result.callerTurns} turns${run.result.refusals.length ? `  refused: ${run.result.refusals.join(', ')}` : ''}`);
}

const q = qualityOf(runs.map((r) => r.result), 0.05);
const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
console.log(`
  goals met            ${runs.filter((r) => r.goalMet).length} of ${runs.length}
  handled without staff ${pct(q.containmentRate)}
  booking success      ${pct(q.bookingSuccess)} (${q.bookings} of ${q.bookingAttempts})
  turns to a booking   ${q.avgTurnsToBooking ?? 'n/a'}
  transferred          ${pct(q.transferredShare)}
  flagged              ${pct(q.flaggedShare)} (emergencies, in a text simulation)
  refusals             ${q.refusals.map((r) => `${r.code} ${r.count}`).join(', ') || 'none'}
  estimated voice cost ${q.costPerCall === null ? 'n/a' : `$${q.costPerCall.toFixed(2)} a call`}, from the words spoken
`);
process.exit(0);
