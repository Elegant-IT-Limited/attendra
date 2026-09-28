// SPDX-License-Identifier: AGPL-3.0-only
// Runs every scenario and prints a table. `pnpm eval` is scripted and offline;
// `pnpm eval --live` swaps in the real planner model (needs OPENAI_API_KEY).
import { ResponsesPlanner } from '@attendra/agent';
import OpenAI from 'openai';
import { loadScenarios } from './scenario';
import { runScenario } from './simulator';

const live = process.argv.includes('--live');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const planner = live ? new ResponsesPlanner(new OpenAI(), process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna') : undefined;

const scenarios = loadScenarios().filter((s) => !only || s.id.includes(only));
const c = (n: number) => (s: string) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${n}m${s}\x1b[0m` : s);
const [green, red, dim, bold] = [c(32), c(31), c(2), c(1)];

console.log(bold(`attendra evals`) + dim(`  ${scenarios.length} scenarios · planner: ${live ? `live (${process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna'})` : 'scripted'} · Postgres in-process\n`));
let failed = 0;
for (const s of scenarios) {
  const r = await runScenario(s, planner);
  if (!r.passed) failed++;
  const refusals = r.refusals.length ? dim(`  refused: ${r.refusals.join(', ')}`) : '';
  console.log(`  ${r.passed ? green('pass') : red('FAIL')}  ${s.id.padEnd(34)} ${r.outcome.padEnd(13)} ${dim(`${r.ms} ms`)}${refusals}`);
  for (const f of r.failures) console.log(`        ${red('·')} ${f}`);
}
console.log(`\n${failed ? red(`${failed} failed`) : green('all passed')}${dim(`, ${scenarios.length - failed}/${scenarios.length}`)}`);
process.exit(failed ? 1 : 0);
