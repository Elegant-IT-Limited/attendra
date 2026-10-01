// SPDX-License-Identifier: AGPL-3.0-only
// Runs every scenario and prints a table. `pnpm eval` is scripted and offline;
// `pnpm eval --live` swaps in the real planner model (needs OPENAI_API_KEY), and
// `--judge` adds a model that scores each live transcript and writes
// evals/reports/<date>.md, which git ignores.
import { ResponsesPlanner } from '@attendra/agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { Judge, judgeReport, type Verdict } from './judge';
import { loadScenarios, type Scenario } from './scenario';
import { runScenario, type ScenarioResult } from './simulator';

const live = process.argv.includes('--live');
const judging = process.argv.includes('--judge');
if (judging && !live) {
  console.error('--judge scores live transcripts: run pnpm eval --live --judge');
  process.exit(2);
}
const judge = judging ? new Judge(new OpenAI(), process.env.ATTENDRA_JUDGE_MODEL ?? 'gpt-6-luna') : null;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const planner = live ? new ResponsesPlanner(new OpenAI(), process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna') : undefined;

const scenarios = loadScenarios().filter((s) => !only || s.id.includes(only));
const c = (n: number) => (s: string) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${n}m${s}\x1b[0m` : s);
const [green, red, dim, bold] = [c(32), c(31), c(2), c(1)];

console.log(bold(`attendra evals`) + dim(`  ${scenarios.length} scenarios · planner: ${live ? `live (${process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna'})` : 'scripted'} · Postgres in-process\n`));
let failed = 0;
const runs: { scenario: Scenario; result: ScenarioResult; verdict: Verdict | null; error?: string }[] = [];
for (const s of scenarios) {
  const r = await runScenario(s, planner);
  if (!r.passed) failed++;
  if (judge) {
    // a judge that fails is a gap in the report, never a failed eval
    try { runs.push({ scenario: s, result: r, verdict: await judge.score(s, r) }); }
    catch (err) { runs.push({ scenario: s, result: r, verdict: null, error: (err as { status?: number }).status ? `judge http ${(err as { status: number }).status}` : 'judge unavailable' }); }
  }
  const refusals = r.refusals.length ? dim(`  refused: ${r.refusals.join(', ')}`) : '';
  console.log(`  ${r.passed ? green('pass') : red('FAIL')}  ${s.id.padEnd(34)} ${r.outcome.padEnd(13)} ${dim(`${String(r.ms).padStart(4)} ms`)}${refusals}`);
  for (const f of r.failures) console.log(`        ${red('·')} ${f}`);
}
console.log(`\n${failed ? red(`${failed} failed`) : green('all passed')}${dim(`, ${scenarios.length - failed}/${scenarios.length}`)}`);
if (judge) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(import.meta.dirname, '../reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.md`);
  writeFileSync(file, judgeReport(runs, { date, planner: process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna', judge: judge.model }));
  console.log(dim(`report: ${file}`));
}
process.exit(failed ? 1 : 0);
