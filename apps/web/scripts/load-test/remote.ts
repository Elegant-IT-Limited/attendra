// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import type { ContainerSample, MeasuredCall } from './report';

const UNITS: Record<string, number> = { b: 1, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
/** "80.5MiB" as bytes. */
export function bytes(text: string): number {
  const m = /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(text);
  if (!m) return Number.NaN;
  const unit = UNITS[m[2]!.toLowerCase()];
  return unit === undefined ? Number.NaN : Number(m[1]) * unit;
}

/** `docker stats --no-stream --format '{{json .}}'`, one container a line. */
export function parseDockerStats(out: string): ContainerSample[] {
  return out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).map((l) => {
    const j = JSON.parse(l) as { Name: string; CPUPerc: string; MemUsage: string; MemPerc: string };
    const [used = '', limit = ''] = j.MemUsage.split('/');
    return { name: j.Name, cpuPct: Number.parseFloat(j.CPUPerc), memBytes: bytes(used), memLimitBytes: bytes(limit), memPct: Number.parseFloat(j.MemPerc) };
  });
}

/** `nproc` then the "Mem:" line of `free -b`. */
export function parseHost(out: string): { cores: number; memBytes: number } | null {
  const cores = Number(out.trim().split('\n')[0]);
  const mem = /^Mem:\s+(\d+)/m.exec(out);
  return Number.isFinite(cores) && cores > 0 && mem ? { cores, memBytes: Number(mem[1]) } : null;
}

/**
 * The rows of `db:call-stats --json --calls`, as the load test counts them. pnpm may print its own lines first, so the
 * JSON is read from its first line that opens an object.
 */
export function parseCallStats(out: string): MeasuredCall[] {
  const start = out.search(/^\{/m);
  if (start < 0) throw new Error('no JSON in the db:call-stats output');
  const json = JSON.parse(out.slice(start)) as { calls?: MeasuredCall[] };
  if (!json.calls) throw new Error('the db:call-stats output has no calls: run it with --calls --json');
  return json.calls.map((c) => ({ id: c.id, closeReason: c.closeReason, firstAudioMs: c.firstAudioMs, stalls: c.stalls, answerTimeouts: c.answerTimeouts, voiceOnlyMs: c.voiceOnlyMs, lookupMs: c.lookupMs }));
}

/** The command that reads the window's call numbers on the box, in the API's container (it has the data key and the database). */
export function callStatsCommand(container: string, clinics: string[], since: string, until: string) {
  return ['docker', 'exec', container, 'pnpm', '--silent', 'db:call-stats', ...clinics, '--since', since, '--until', until, '--calls', '--json'];
}

/** Runs a command on the box over ssh (keys only: BatchMode never asks for a password). Arguments are quoted for the remote shell. */
export function ssh(host: string, port: number | null, command: string[], timeoutMs = 60_000): Promise<string> {
  const quoted = command.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', ...(port ? ['-p', String(port)] : []), host, quoted], { timeout: timeoutMs, maxBuffer: 64 * 2 ** 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ssh ${host}: ${stderr.trim().split('\n').at(-1) || err.message}`));
      else resolve(stdout);
    });
  });
}
