// SPDX-License-Identifier: AGPL-3.0-only
// Runs every scenario and prints a table. `pnpm eval` is scripted and offline;
// `pnpm eval --live` swaps in the real planner model (needs OPENAI_API_KEY), and
// `--judge` adds a model that scores each live transcript and writes
// evals/reports/<date>.md, which git ignores.
import { type PlannerSpeed, type PlannerTiming, ResponsesPlanner } from '@attendra/agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { modelFollowUp } from './follow-up';
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
// the same speed settings as the voice service reads (ATTENDRA_BACKEND_EFFORT, _SIMPLE_MODEL, _SIMPLE_EFFORT), to compare them live
const effort = (name: string) => (process.env[name] || undefined) as PlannerSpeed['effort'];
const speed: PlannerSpeed = {
  effort: effort('ATTENDRA_BACKEND_EFFORT'),
  simple: process.env.ATTENDRA_BACKEND_SIMPLE_MODEL || process.env.ATTENDRA_BACKEND_SIMPLE_EFFORT
    ? { model: process.env.ATTENDRA_BACKEND_SIMPLE_MODEL || undefined, effort: effort('ATTENDRA_BACKEND_SIMPLE_EFFORT') } : undefined,
};
const planner = live ? new ResponsesPlanner(new OpenAI(), process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna', undefined, undefined, speed) : undefined;
// live, a model answers the planner's follow-up questions for a scenario that lists its facts
const followUp = live ? modelFollowUp(new OpenAI(), process.env.ATTENDRA_SIM_MODEL ?? 'gpt-6-luna') : undefined;

// `--tag=hardcore` keeps the scenarios with that tag; `--transcripts` puts every call's transcript in the report, not only the failed ones
const tag = process.argv.find((a) => a.startsWith('--tag='))?.slice(6);
const transcripts = process.argv.includes('--transcripts');
// `--only=a,b` keeps the scenarios whose id contains any of them
const scenarios = loadScenarios().filter((s) => (!only || only.split(',').some((o) => o && s.id.includes(o))) && (!tag || s.tags.includes(tag)));
const c = (n: number) => (s: string) => (process.stdout.isTTY || process.env.FORCE_COLOR ? `\x1b[${n}m${s}\x1b[0m` : s);
const [green, red, dim, bold] = [c(32), c(31), c(2), c(1)];

console.log(bold(`attendra evals`) + dim(`  ${scenarios.length} scenarios · planner: ${live ? `live (${process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna'})` : 'scripted'} · Postgres in-process\n`));
let failed = 0;
const timings: PlannerTiming[] = [];
const runs: { scenario: Scenario; result: ScenarioResult; verdict: Verdict | null; error?: string }[] = [];
for (const s of scenarios) {
  const r = await runScenario(s, planner, followUp);
  if (!r.passed) failed++;
  timings.push(...r.timings);
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
// live: the planner model's own time per request (tools apart), simple turns and the rest, to compare speed settings
if (timings.length) {
  const line = (label: string, list: PlannerTiming[]) => {
    if (!list.length) return;
    const ms = list.map((t) => t.modelMs).sort((a, b) => a - b);
    const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!;
    console.log(dim(`planner model time, ${label}: ${list.length} requests, median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${ms.at(-1)} ms (${[...new Set(list.map((t) => `${t.model}${t.effort ? `/${t.effort}` : ''}`))].join(', ')})`));
  };
  line('simple turns', timings.filter((t) => t.simple));
  line('other turns', timings.filter((t) => !t.simple));
}
if (judge) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(import.meta.dirname, '../reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.md`);
  writeFileSync(file, judgeReport(runs, { date, planner: process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna', judge: judge.model, transcripts }));
  console.log(dim(`report: ${file}`));
}
process.exit(failed ? 1 : 0);
