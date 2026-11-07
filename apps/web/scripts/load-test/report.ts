// SPDX-License-Identifier: AGPL-3.0-only
import { isDropped } from '@attendra/core';
import { percentile } from '@attendra/db';
import { THRESHOLDS } from './thresholds';

/** One dial: a browser test call (or a simulated one) from the moment its button was pressed. */
export interface CallAttempt {
  slot: number; clinicId: string; callId: string | null;
  dialledAt: string; liveAt: string | null; endedAt: string | null;
  /** script: hung up by the test after --call-seconds; itself: the assistant or the server ended it; failed: never went live, or stopped with an error. */
  endedBy: 'script' | 'itself' | 'failed';
  failure: string | null;
}

export interface StreamRecord {
  index: number; clinicId: string;
  /** Connections made, the first included: each one after a drop is a reconnect. */
  opens: number;
  readyMs: number | null;
  drops: { at: string; reason: string }[];
  /** Reconnects that did not reach `ready`. */
  failedReconnects: number;
  changes: number;
  /** The longest time with no byte at all on an open stream (the API sends a heartbeat every 15 s). */
  longestSilenceMs: number;
}

export interface ContainerSample { name: string; cpuPct: number; memBytes: number; memLimitBytes: number; memPct: number }
export interface DockerSample { at: string; containers: ContainerSample[] }

/** A call measured as db:call-stats measures it (`statsRow`), from the database or from the API. */
export interface MeasuredCall {
  id: string; closeReason: string | null; firstAudioMs: number | null; stalls: number | null; answerTimeouts: number | null;
  voiceOnlyMs: number[]; lookupMs: number[];
}

export interface Run {
  version: 1;
  base: string; clinics: string[]; mode: 'real' | 'simulated';
  plan: { calls: number; streams: number; minutes: number; callSeconds: number };
  startedAt: string; endedAt: string;
  calls: CallAttempt[];
  streams: StreamRecord[];
  rateLimited: number;
  /** Where `measured` came from: the database (db:call-stats, which has first audio and stalls) or the API. */
  measuredFrom: 'database' | 'api' | 'none';
  measured: MeasuredCall[];
  host: { cores: number; memBytes: number } | null;
  samples: DockerSample[];
  notes: string[];
}

export type Status = 'pass' | 'fail' | 'not measured';
export interface Check { name: string; value: string; limit: string; status: Status }

export interface Summary {
  verdict: 'PASS' | 'FAIL' | 'INCOMPLETE';
  calls: { dialled: number; live: number; endedByScript: number; endedItself: number; failed: number; droppedOnServer: number; measured: number };
  turns: { n: number; p50: number | null; p90: number | null; max: number | null; voiceOnly: { n: number; p50: number | null; p90: number | null }; lookup: { n: number; p50: number | null; p90: number | null } };
  firstAudio: { n: number; p50: number | null; p90: number | null };
  stalls: number | null; answerTimeouts: number | null;
  streams: { held: number; ready: number; drops: number; reconnects: number; failedReconnects: number; changesMin: number | null; changesMax: number | null; longestSilenceMs: number | null };
  resources: { hostCpuPeak: number | null; containers: { name: string; cpuPeakPct: number; memPeakPct: number; memPeakBytes: number }[] };
  checks: Check[];
}

const stats = (xs: number[]) => ({ n: xs.length, p50: percentile(xs, 0.5), p90: percentile(xs, 0.9) });
const short = (id: string) => id.slice(0, 8);

/** The numbers and the verdict, from a run alone: no network, so a run's JSON can be summed again later. */
export function summarise(run: Run): Summary {
  const ours = new Set(run.calls.flatMap((c) => (c.callId ? [short(c.callId)] : [])));
  const measured = run.measured.filter((m) => ours.has(short(m.id)));
  const droppedOnServer = new Set(measured.filter((m) => isDropped(m.closeReason)).map((m) => short(m.id)));
  const failed = new Set(run.calls.filter((c) => c.endedBy === 'failed').map((c, i) => (c.callId ? short(c.callId) : `attempt-${i}`)));
  const dropped = new Set([...failed, ...droppedOnServer]);

  const voiceOnly = measured.flatMap((m) => m.voiceOnlyMs);
  const lookup = measured.flatMap((m) => m.lookupMs);
  const turns = [...voiceOnly, ...lookup];
  const firstAudio = measured.flatMap((m) => (m.firstAudioMs === null ? [] : [m.firstAudioMs]));
  const fromDb = run.measuredFrom === 'database';
  const sum = (k: 'stalls' | 'answerTimeouts') => (fromDb ? measured.reduce((n, m) => n + (m[k] ?? 0), 0) : null);

  const streamDrops = run.streams.reduce((n, s) => n + s.drops.length, 0) + run.streams.filter((s) => s.readyMs === null && !s.drops.length).length;
  const changes = run.streams.map((s) => s.changes);

  const cores = run.host?.cores ?? null;
  const hostCpuPeak = cores && run.samples.length ? Math.max(...run.samples.map((s) => s.containers.reduce((n, c) => n + c.cpuPct, 0) / (cores * 100))) : null;
  const byName = new Map<string, { name: string; cpuPeakPct: number; memPeakPct: number; memPeakBytes: number }>();
  for (const s of run.samples) {
    for (const c of s.containers) {
      const p = byName.get(c.name) ?? { name: c.name, cpuPeakPct: 0, memPeakPct: 0, memPeakBytes: 0 };
      byName.set(c.name, { name: c.name, cpuPeakPct: Math.max(p.cpuPeakPct, c.cpuPct), memPeakPct: Math.max(p.memPeakPct, c.memPct), memPeakBytes: Math.max(p.memPeakBytes, c.memBytes) });
    }
  }
  const containers = [...byName.values()].sort((a, b) => b.memPeakPct - a.memPeakPct);
  const memPeak = containers.length ? containers[0]! : null;

  const ms = (n: number | null) => (n === null ? '-' : `${Math.round(n)} ms`);
  const share = (n: number | null) => (n === null ? '-' : `${Math.round(n * 100)}%`);
  const at = (ok: boolean | null): Status => (ok === null ? 'not measured' : ok ? 'pass' : 'fail');
  const turnP90 = percentile(turns, 0.9);
  const firstP90 = percentile(firstAudio, 0.9);
  const checks: Check[] = [
    { name: 'Turn time p90', value: ms(turnP90), limit: `≤ ${THRESHOLDS.turnP90Ms} ms`, status: at(turnP90 === null ? null : turnP90 <= THRESHOLDS.turnP90Ms) },
    { name: 'First audio p90', value: ms(firstP90), limit: `≤ ${THRESHOLDS.firstAudioP90Ms} ms`, status: at(firstP90 === null ? null : firstP90 <= THRESHOLDS.firstAudioP90Ms) },
    { name: 'Dropped calls', value: String(dropped.size), limit: `≤ ${THRESHOLDS.droppedCalls}`, status: at(run.calls.length ? dropped.size <= THRESHOLDS.droppedCalls : null) },
    { name: 'Dropped streams', value: String(streamDrops), limit: `≤ ${THRESHOLDS.droppedStreams}`, status: at(run.streams.length ? streamDrops <= THRESHOLDS.droppedStreams : null) },
    { name: 'Rate-limited answers (429)', value: String(run.rateLimited), limit: `≤ ${THRESHOLDS.rateLimited}`, status: at(run.rateLimited <= THRESHOLDS.rateLimited) },
    { name: 'Host CPU at peak', value: share(hostCpuPeak), limit: `≤ ${share(THRESHOLDS.hostCpuShare)} of ${cores ?? '?'} cores`, status: at(hostCpuPeak === null ? null : hostCpuPeak <= THRESHOLDS.hostCpuShare) },
    { name: 'Container memory at peak', value: memPeak ? `${memPeak.name} ${Math.round(memPeak.memPeakPct)}%` : '-', limit: `≤ ${share(THRESHOLDS.containerMemShare)} of its limit`, status: at(memPeak ? memPeak.memPeakPct / 100 <= THRESHOLDS.containerMemShare : null) },
  ];
  const verdict = checks.some((c) => c.status === 'fail') ? 'FAIL' : checks.some((c) => c.status === 'not measured') ? 'INCOMPLETE' : 'PASS';

  return {
    verdict,
    calls: {
      dialled: run.calls.length, live: run.calls.filter((c) => c.liveAt).length, endedByScript: run.calls.filter((c) => c.endedBy === 'script').length,
      endedItself: run.calls.filter((c) => c.endedBy === 'itself').length, failed: failed.size, droppedOnServer: droppedOnServer.size, measured: measured.length,
    },
    turns: { ...stats(turns), max: turns.length ? Math.max(...turns) : null, voiceOnly: stats(voiceOnly), lookup: stats(lookup) },
    firstAudio: stats(firstAudio),
    stalls: sum('stalls'), answerTimeouts: sum('answerTimeouts'),
    streams: {
      held: run.streams.length, ready: run.streams.filter((s) => s.readyMs !== null).length, drops: streamDrops,
      reconnects: run.streams.reduce((n, s) => n + Math.max(0, s.opens - 1), 0), failedReconnects: run.streams.reduce((n, s) => n + s.failedReconnects, 0),
      changesMin: changes.length ? Math.min(...changes) : null, changesMax: changes.length ? Math.max(...changes) : null,
      longestSilenceMs: run.streams.length ? Math.max(...run.streams.map((s) => s.longestSilenceMs)) : null,
    },
    resources: { hostCpuPeak, containers },
    checks,
  };
}

/** The report a person reads: what ran, the checks with their limits, then the detail. Counts and timings only. */
export function markdown(run: Run, s: Summary): string {
  const n = (v: number | null, unit = ' ms') => (v === null ? '-' : `${Math.round(v)}${unit}`);
  const failures = new Map<string, number>();
  for (const c of run.calls) if (c.failure) failures.set(c.failure, (failures.get(c.failure) ?? 0) + 1);
  const lines = [
    `# Load test: ${s.verdict}`,
    '',
    `${run.base}, ${run.clinics.length} clinic${run.clinics.length === 1 ? '' : 's'}, ${run.startedAt} to ${run.endedAt}.`,
    `Planned: ${run.plan.calls} ${run.mode} calls at a time (each hung up after ${run.plan.callSeconds} s and dialled again), ${run.plan.streams} change streams, ${run.plan.minutes} min.`,
    `Turn times from: ${run.measuredFrom === 'database' ? 'the database (db:call-stats)' : run.measuredFrom === 'api' ? 'the API (first audio and stalls need db:call-stats: see docs/load-test.md)' : 'nothing (no call was measured)'}.`,
    '',
    '| Check | Result | Limit | |',
    '|---|---|---|---|',
    ...s.checks.map((c) => `| ${c.name} | ${c.value} | ${c.limit} | ${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'not measured'} |`),
    '',
    '## Calls',
    '',
    `- Dialled ${s.calls.dialled}, live ${s.calls.live}; hung up by the test ${s.calls.endedByScript}, ended by themselves ${s.calls.endedItself}, failed ${s.calls.failed}, dropped on the server ${s.calls.droppedOnServer}; measured ${s.calls.measured}.`,
    ...[...failures].map(([f, k]) => `- ${k} × ${f}`),
    `- Turn time (${s.turns.n} turns): p50 ${n(s.turns.p50)}, p90 ${n(s.turns.p90)}, max ${n(s.turns.max)}. Voice-only (${s.turns.voiceOnly.n}): p50 ${n(s.turns.voiceOnly.p50)}, p90 ${n(s.turns.voiceOnly.p90)}. Lookups (${s.turns.lookup.n}): p50 ${n(s.turns.lookup.p50)}, p90 ${n(s.turns.lookup.p90)}.`,
    `- First audio (${s.firstAudio.n} calls): p50 ${n(s.firstAudio.p50)}, p90 ${n(s.firstAudio.p90)}. Stalls: ${s.stalls ?? '-'}. Answers past the limit: ${s.answerTimeouts ?? '-'}.`,
    '',
    '## Change streams',
    '',
    `- Held ${s.streams.held}, ready ${s.streams.ready}; drops ${s.streams.drops}, reconnects ${s.streams.reconnects} (${s.streams.failedReconnects} failed).`,
    `- Changes received per stream: ${s.streams.changesMin ?? '-'} to ${s.streams.changesMax ?? '-'}. Longest silence on an open stream: ${n(s.streams.longestSilenceMs)}.`,
    '',
    '## Resources',
    '',
    s.resources.containers.length
      ? [`Host: ${run.host?.cores ?? '?'} cores, ${run.host ? Math.round(run.host.memBytes / 2 ** 30) : '?'} GiB; all containers together at peak ${s.resources.hostCpuPeak === null ? '-' : `${Math.round(s.resources.hostCpuPeak * 100)}%`} of the cores.`, '',
        '| Container | CPU peak | Memory peak | of its limit |', '|---|---|---|---|',
        ...s.resources.containers.map((c) => `| ${c.name} | ${Math.round(c.cpuPeakPct)}% | ${Math.round(c.memPeakBytes / 2 ** 20)} MiB | ${Math.round(c.memPeakPct)}% |`)].join('\n')
      : 'Not sampled (run with --ssh <host> to sample docker stats on the box).',
  ];
  if (run.notes.length) lines.push('', '## Notes', '', ...run.notes.map((t) => `- ${t}`));
  return `${lines.join('\n')}\n`;
}
