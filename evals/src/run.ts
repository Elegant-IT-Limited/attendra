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
  tier: (process.env.ATTENDRA_BACKEND_SERVICE_TIER || undefined) as PlannerSpeed['tier'],
};
// `--timings` also prints the planner model time of every live request, to compare speed settings request by request,
// with each round's tokens and first-token time (rounds are streamed for that), and writes them all to
// evals/reports/timings-<date>.json
const perRequest = process.argv.includes('--timings');
const planner = live ? new ResponsesPlanner(new OpenAI(), process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna', undefined, undefined, speed, { firstToken: perRequest }) : undefined;
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
const timings: (PlannerTiming & { scenario: string })[] = [];
const runs: { scenario: Scenario; result: ScenarioResult; verdict: Verdict | null; error?: string }[] = [];
for (const s of scenarios) {
  const r = await runScenario(s, planner, followUp);
  if (!r.passed) failed++;
  timings.push(...r.timings.map((t) => ({ ...t, scenario: s.id })));
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
  const quantile = (values: number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : null; };
  const median = (values: number[]) => quantile(values, 0.5);
  const known = (values: (number | null)[]) => values.filter((v): v is number => v !== null);
  if (perRequest) {
    for (const t of timings) {
      const rounds = t.requests.map((r) => `${r.ms}${r.firstTokenMs !== null ? `(${r.firstTokenMs})` : ''}${r.calls.length ? ` ${r.calls.join('+')}` : ''}`).join(' · ');
      const tokens = t.requests.length ? `in ${t.requests.map((r) => `${r.inputTokens ?? '?'}/${r.cachedTokens ?? '?'}c`).join(',')} out ${t.requests.map((r) => `${r.outputTokens ?? '?'}/${r.reasoningTokens ?? '?'}r`).join(',')}` : '';
      console.log(dim(`  ${t.scenario.padEnd(34)} ${(t.simple ? 'simple' : 'other').padEnd(6)} ${`${t.model}${t.effort ? `/${t.effort}` : ''}${t.tier ? `/${t.tier}` : ''}`.padEnd(18)} ${t.rounds} round${t.rounds === 1 ? ' ' : 's'} ${String(t.modelMs).padStart(6)} ms  tools ${String(t.toolMs).padStart(5)} ms  [${rounds}]  ${tokens}`));
    }
    console.log('');
  }
  const line = (label: string, list: PlannerTiming[]) => {
    if (!list.length) return;
    const ms = list.map((t) => t.modelMs);
    console.log(dim(`planner model time, ${label}: ${list.length} requests, median ${median(ms)} ms, p90 ${quantile(ms, 0.9)} ms, max ${Math.max(...ms)} ms (${[...new Set(list.map((t) => `${t.model}${t.effort ? `/${t.effort}` : ''}${t.tier ? `/${t.tier}` : ''}`))].join(', ')})`));
    if (!perRequest) return;
    // where the time goes: rounds per request, each round's time and first token, the tokens, and the prompt cache
    const rounds = list.flatMap((t) => t.requests);
    const firstOf = list.map((t) => t.requests[0]).filter((r): r is PlannerTiming['requests'][number] => !!r);
    const later = list.flatMap((t) => t.requests.slice(1));
    const share = (part: number[]) => (part.reduce((a, b) => a + b, 0) / Math.max(1, ms.reduce((a, b) => a + b, 0)) * 100).toFixed(0);
    console.log(dim(`  rounds per request: median ${median(list.map((t) => t.rounds))}, ${list.filter((t) => t.rounds > 1).length}/${list.length} requests took more than one; first rounds ${share(firstOf.map((r) => r.ms))}% of model time, later rounds ${share(later.map((r) => r.ms))}%; tools median ${median(list.map((t) => t.toolMs))} ms`));
    console.log(dim(`  per round: median ${median(rounds.map((r) => r.ms))} ms, first token median ${median(known(rounds.map((r) => r.firstTokenMs))) ?? '-'} ms (p90 ${quantile(known(rounds.map((r) => r.firstTokenMs)), 0.9) ?? '-'}); first rounds median ${median(firstOf.map((r) => r.ms))} ms, later rounds median ${median(later.map((r) => r.ms)) ?? '-'} ms`));
    const served = [...new Set(rounds.map((r) => r.served).filter(Boolean))];
    if (served.length) console.log(dim(`  processing tier served: ${served.join(', ')}`));
    const input = known(rounds.map((r) => r.inputTokens)); const cached = known(rounds.map((r) => r.cachedTokens));
    const output = known(rounds.map((r) => r.outputTokens)); const reasoning = known(rounds.map((r) => r.reasoningTokens));
    const hits = rounds.filter((r) => (r.cachedTokens ?? 0) > 0).length;
    console.log(dim(`  tokens per round: input median ${median(input) ?? '-'} (cached median ${median(cached) ?? '-'}, ${hits}/${rounds.length} rounds hit the cache, ${(cached.reduce((a, b) => a + b, 0) / Math.max(1, input.reduce((a, b) => a + b, 0)) * 100).toFixed(0)}% of input tokens cached), output median ${median(output) ?? '-'} of which reasoning median ${median(reasoning) ?? '-'} (${(reasoning.reduce((a, b) => a + b, 0) / Math.max(1, output.reduce((a, b) => a + b, 0)) * 100).toFixed(0)}% of output)`));
    const parts = ['instructions', 'tools', 'transcript', 'state', 'history', 'notes'] as const;
    console.log(dim(`  prompt chars (median): ${parts.map((p) => `${p} ${median(list.map((t) => t.prompt[p]))}`).join(', ')}`));
  };
  line('simple turns', timings.filter((t) => t.simple));
  line('other turns', timings.filter((t) => !t.simple));
  if (perRequest) {
    const dir = join(import.meta.dirname, '../reports');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `timings-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(file, JSON.stringify({ model: process.env.ATTENDRA_BACKEND_MODEL ?? 'gpt-6-luna', speed, timings }, null, 1));
    console.log(dim(`timings: ${file}`));
  }
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
