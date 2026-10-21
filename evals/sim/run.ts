// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm sim --scenarios 20`: a model plays each persona in personas.yaml against the
// real assistant, as text, and the quality numbers are printed. It calls OpenAI, for
// the caller and for the planner, so it needs OPENAI_API_KEY and costs credit. CI
// never runs it; the manual quality workflow does.
import { ResponsesPlanner } from '@attendra/agent';
import { qualityOf } from '@attendra/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { callDetails } from '../src/judge';
import { ModelCaller } from './caller';
import { loadPersonas, type Simulation, simulate } from './simulate';

if (!process.env.OPENAI_API_KEY) {
  console.error('pnpm sim calls OpenAI for the caller and the planner: set OPENAI_API_KEY');
  process.exit(2);
}
const arg = process.argv.indexOf('--scenarios');
// `--only=vet-abusive` keeps the personas whose id has that text; `--all` runs every persona once
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const personas = loadPersonas().filter((p) => !only || p.id.includes(only));
if (!personas.length) { console.error(`no persona matches --only=${only}`); process.exit(2); }
const count = process.argv.includes('--all') || only ? personas.length : arg > 0 ? Math.max(1, Number(process.argv[arg + 1]) || 1) : 8;
const openai = new OpenAI();
const plannerModel = process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna';
const callerModel = process.env.ATTENDRA_SIM_MODEL ?? 'gpt-6-luna';
console.log(`attendra sim  ${count} calls · planner ${plannerModel} · caller ${callerModel}\n`);

const runs: Simulation[] = [];
for (let i = 0; i < count; i++) {
  const persona = personas[i % personas.length]!;
  const run = await simulate(persona, new ModelCaller(openai, callerModel, persona), new ResponsesPlanner(openai, plannerModel));
  runs.push(run);
  console.log(`  ${run.goalMet ? 'met ' : 'MISS'}  ${persona.id.padEnd(26)} ${String(run.result.outcome).padEnd(13)} ${run.result.callerTurns} turns${run.result.hungUp ? '  ended by the assistant' : ''}${run.result.refusals.length ? `  refused: ${run.result.refusals.join(', ')}` : ''}`);
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
// every call in full, to read what happened (synthetic people only); git ignores the reports
const dir = join(import.meta.dirname, '../reports');
mkdirSync(dir, { recursive: true });
const file = join(dir, `sim-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, [
  `# Simulated calls, ${new Date().toISOString().slice(0, 10)}`, '', `Planner ${plannerModel}, caller ${callerModel}. ${runs.filter((r) => r.goalMet).length} of ${runs.length} goals met.`, '',
  ...runs.flatMap((r, i) => [
    `## ${i + 1}. ${r.persona.id}: ${r.goalMet ? 'met' : 'MISSED'} (${r.result.outcome}, expected ${r.persona.expect.join(' or ')}${r.persona.expect_hung_up === undefined ? '' : r.result.hungUp ? ', ended by the assistant' : ', not ended by the assistant'})`, '',
    `Goal: ${r.persona.goal}`, '',
    ...callDetails({ transcript: r.transcript, calls: r.calls }), '',
  ]),
].join('\n'));
console.log(`report: ${file}`);
process.exit(0);
