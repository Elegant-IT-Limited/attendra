// SPDX-License-Identifier: AGPL-3.0-only
// The launch load test: browser test calls kept going on many lines at once, plus dashboards' change streams held
// open, for a set time against one deployment; then the calls' turn times, the drops and the box's CPU and memory,
// against THRESHOLDS. docs/load-test.md says how to run it on staging and what it costs. Never point it at production.
//
//   ATTENDRA_COOKIE='<cookie header>' pnpm --filter @attendra/web load-test -- --base https://staging.example.com \
//     --clinic clinic_a,clinic_b,... --calls 20 --streams 10 --minutes 15 --spend [--ssh staging]
//   pnpm --filter @attendra/web load-test -- --dry-run --base http://localhost:3000
//
// The cookie is read from the environment and never printed or written to the report.
import { statsRow } from '@attendra/db';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, runSlot } from './calls';
import { isLoopback, type Options, parseOptions, sessions, USAGE } from './options';
import { callStatsCommand, parseCallStats, parseDockerStats, parseHost, ssh } from './remote';
import { type CallAttempt, type DockerSample, markdown, type MeasuredCall, type Run, summarise } from './report';
import { holdStream } from './streams';
import { conversation, readWav } from './wav';

const here = dirname(fileURLToPath(import.meta.url));
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

let opts: Options;
try {
  opts = parseOptions(process.argv.slice(2));
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(2);
}

function write(run: Run, out: string) {
  mkdirSync(out, { recursive: true });
  const name = `load-test-${run.startedAt.replace(/[:.]/g, '-')}`;
  const summary = summarise(run);
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ ...run, summary }, null, 2)}\n`);
  writeFileSync(join(out, `${name}.md`), markdown(run, summary));
  log(`${summary.verdict}: ${summary.checks.map((c) => `${c.name} ${c.value} (${c.status})`).join('; ')}`);
  log(`report: ${resolve(out, `${name}.md`)}`);
  return summary.verdict;
}

if (opts.reportOnly) {
  const run = JSON.parse(readFileSync(opts.reportOnly, 'utf8')) as Run & { summary?: unknown };
  delete run.summary;
  if (opts.statsFile) Object.assign(run, { measured: parseCallStats(readFileSync(opts.statsFile, 'utf8')), measuredFrom: 'database' });
  process.exit(write(run, opts.out) === 'PASS' ? 0 : 1);
}

const api = (path: string, cookie: string, init: RequestInit = {}) => fetch(`${opts.base}/api${path}`, { ...init, headers: { cookie, origin: opts.base, ...init.headers } });

/** On this machine only: a demo login, with the password the local demo itself publishes on its health route. */
async function demoCookie(): Promise<string> {
  const health = (await (await fetch(`${opts.base}/api/v1/health`)).json()) as { demoSignIn?: { password: string; logins: { email: string; label: string }[] } };
  const login = health.demoSignIn?.logins.find((l) => l.label === 'Front desk') ?? health.demoSignIn?.logins[0];
  if (!health.demoSignIn || !login) throw new Error('no ATTENDRA_COOKIE, and this server is not the local demo');
  const res = await fetch(`${opts.base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: opts.base }, body: JSON.stringify({ email: login.email, password: health.demoSignIn.password }) });
  if (!res.ok) throw new Error(`demo sign-in answered ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

let cookies = sessions(process.env.ATTENDRA_COOKIE);
if (!cookies.length && opts.dryRun) cookies = [await demoCookie()];
if (!cookies.length) {
  console.error(`ATTENDRA_COOKIE is required: a signed-in session's Cookie header (one a line for more sessions)\n${USAGE}`);
  process.exit(2);
}

type Me = { testCalls: boolean; simulatedCalls: boolean; idleMinutes: number; clinics: { id: string; permissions: string[] }[] };
const meRes = await api('/v1/me', cookies[0]!);
if (meRes.status !== 200) {
  console.error(`/api/v1/me answered ${meRes.status}: the session cookie does not work on ${opts.base}`);
  process.exit(2);
}
const me = (await meRes.json()) as Me;
const clinics = opts.clinics.length ? opts.clinics : opts.dryRun ? me.clinics.slice(0, 1).map((c) => c.id) : [];
if (!clinics.length) {
  console.error(`--clinic is required\n${USAGE}`);
  process.exit(2);
}
const missing = clinics.filter((id) => !me.clinics.find((c) => c.id === id)?.permissions.includes('calls:test'));
if (missing.length) {
  console.error(`this login cannot make test calls at ${missing.join(', ')}`);
  process.exit(2);
}
// a real browser call is billed by OpenAI: only when asked for; otherwise the server's simulated calls (the local demo)
const mode: Run['mode'] | null = opts.spend && me.testCalls ? 'real' : me.simulatedCalls ? 'simulated' : null;
if (!mode) {
  console.error(me.testCalls
    ? `This server places real test calls, billed by OpenAI per minute: about ${opts.calls * opts.minutes} call minutes for this run (docs/load-test.md has the price). Add --spend to go ahead.`
    : 'This server has no test calls and no simulated calls (no voice service).');
  process.exit(2);
}
if (mode === 'real' && isLoopback(opts.base) && !opts.dryRun) log('note: real calls against this machine');

const notes: string[] = [];
if (me.idleMinutes < opts.minutes + 5) notes.push(`The server signs out after ${me.idleMinutes} idle minutes, close to the ${opts.minutes}-minute run: pages may be signed out (ATTENDRA_IDLE_MINUTES).`);

// one conversation file per caller script, for Chromium's fake microphone
const scripts = opts.audio.length
  ? opts.audio
  : Object.entries(JSON.parse(readFileSync(join(here, 'audio', 'lines.json'), 'utf8')) as Record<string, string[]>).map(([name, lines]) => lines.map((_, i) => join(here, 'audio', `${name}-${i + 1}.wav`)));
const audioDir = mkdtempSync(join(tmpdir(), 'attendra-load-'));
const audioFiles = mode === 'real'
  ? scripts.map((files, i) => {
    const file = join(audioDir, `caller-${i + 1}.wav`);
    writeFileSync(file, conversation(files.map((f) => readWav(readFileSync(f))), opts.gapSeconds * 1000));
    return file;
  })
  : [null];

const startedAt = new Date();
const deadline = startedAt.getTime() + opts.minutes * 60_000;
log(`${opts.calls} ${mode} calls and ${opts.streams} streams for ${opts.minutes} min on ${opts.base}, ${clinics.length} clinic(s), ${cookies.length} session(s)`);
if (mode === 'real') log(`about ${opts.calls * opts.minutes} call minutes of OpenAI realtime audio`);
const stop = new AbortController();

// the box: its size once, then docker stats every --sample seconds
let host: Run['host'] = null;
const samples: DockerSample[] = [];
let sampling: Promise<void> = Promise.resolve();
if (opts.ssh) {
  const { host: target, port, sampleSeconds } = opts.ssh;
  host = parseHost(await ssh(target, port, ['sh', '-c', 'nproc; free -b']));
  sampling = (async () => {
    while (!stop.signal.aborted) {
      const at = new Date().toISOString();
      try {
        samples.push({ at, containers: parseDockerStats(await ssh(target, port, ['docker', 'stats', '--no-stream', '--format', '{{json .}}'])) });
      } catch (err) {
        notes.push(`docker stats at ${at} failed: ${(err as Error).message}`);
      }
      await sleep(sampleSeconds * 1000);
    }
  })();
}

const streams = Array.from({ length: opts.streams }, (_, i) => {
  const clinicId = clinics[i % clinics.length]!;
  return holdStream({ url: `${opts.base}/api/v1/clinics/${clinicId}/changes`, cookie: cookies[i % cookies.length]!, index: i, clinicId, signal: stop.signal });
});

const attempts: CallAttempt[] = [];
let rateLimited = 0;
const browsers = await Promise.all(audioFiles.map((f) => launch(f, opts.headed)));
const slots = Array.from({ length: opts.calls }, (_, i) => runSlot({
  browser: browsers[i % browsers.length]!, base: opts.base, clinicId: clinics[i % clinics.length]!, cookie: cookies[i % cookies.length]!, slot: i,
  mode, startAt: startedAt.getTime() + i * opts.staggerSeconds * 1000, deadline, callMs: opts.callSeconds * 1000,
  attempts, onRateLimited: () => { rateLimited++; }, log,
}).catch((err) => log(`slot ${i} stopped: ${(err as Error).message}`)));

await Promise.all(slots);
await sleep(deadline - Date.now());
stop.abort();
await Promise.all([...streams.map((s) => s.done), sampling]);
await Promise.all(browsers.map((b) => b.close()));
const endedAt = new Date();
log(`done: ${attempts.length} calls dialled; reading their numbers`);

// the call rows: from the database when it can be reached, from the API otherwise
await sleep(5000); // the last calls' rows are closed a moment after they hang up
const ids = [...new Set(attempts.flatMap((a) => (a.callId ? [a.callId] : [])))];
const statsCmd = callStatsCommand(opts.ssh?.apiContainer ?? 'attendra-api-1', clinics, startedAt.toISOString(), new Date(endedAt.getTime() + 60_000).toISOString());
let measured: MeasuredCall[] = [];
let measuredFrom: Run['measuredFrom'] = 'none';
if (opts.statsFile) {
  measured = parseCallStats(readFileSync(opts.statsFile, 'utf8'));
  measuredFrom = 'database';
} else if (opts.ssh) {
  try {
    measured = parseCallStats(await ssh(opts.ssh.host, opts.ssh.port, statsCmd, 300_000));
    measuredFrom = 'database';
  } catch (err) {
    notes.push(`db:call-stats over ssh failed (${(err as Error).message}); turn times are from the API.`);
  }
}
if (measuredFrom === 'none' && ids.length) {
  type Detail = { id: string; channel: string; startedAt: string; endedAt: string | null; outcome: string | null; closeReason: string | null; voiceSeconds: number | null;
    transcript: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[]; actions: { tool: string; result: unknown; at: string }[] };
  for (const [i, id] of ids.entries()) {
    const clinicId = attempts.find((a) => a.callId === id)!.clinicId;
    const res = await api(`/v1/clinics/${clinicId}/calls/${id}`, cookies[i % cookies.length]!);
    if (res.status !== 200) { notes.push(`call ${id.slice(0, 8)}: the API answered ${res.status}`); continue; }
    const d = (await res.json()) as Detail;
    const row = statsRow({ ...d, engine: null, voiceFlow: null, startedAt: new Date(d.startedAt), endedAt: d.endedAt ? new Date(d.endedAt) : null, firstAudioMs: null, stalls: null, answerTimeouts: null },
      clinicId, d.transcript, d.actions.map((a) => ({ ...a, at: new Date(a.at) })), null);
    measured.push({ id, closeReason: row.closeReason, firstAudioMs: null, stalls: null, answerTimeouts: null, voiceOnlyMs: row.voiceOnlyMs, lookupMs: row.lookupMs });
  }
  measuredFrom = 'api';
  notes.push(`First audio and stalls are in the database only. On the box: \`${statsCmd.join(' ')} > stats.json\`, then \`pnpm --filter @attendra/web load-test -- --report <this run's .json> --stats-file stats.json\`.`);
}

const run: Run = {
  version: 1, base: opts.base, clinics, mode,
  plan: { calls: opts.calls, streams: opts.streams, minutes: opts.minutes, callSeconds: opts.callSeconds },
  startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
  calls: attempts, streams: streams.map((s) => s.record), rateLimited, measuredFrom, measured, host, samples, notes,
};
const verdict = write(run, opts.out);
// a dry run proves the script, not the server: it passes when a call went live, was measured, and the stream held
const worked = attempts.some((a) => a.liveAt) && measured.length > 0 && run.streams.every((s) => s.readyMs !== null && !s.drops.length);
process.exit((opts.dryRun ? worked : verdict === 'PASS') ? 0 : 1);
