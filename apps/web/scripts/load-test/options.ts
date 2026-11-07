// SPDX-License-Identifier: AGPL-3.0-only

export interface Options {
  base: string;
  /** Test calls are spread over these; the voice service allows only a few open per clinic (docs/test-calls.md). */
  clinics: string[];
  calls: number;
  streams: number;
  minutes: number;
  /** Each entry is one caller: its lines, WAV paths in order. Empty: the committed scripts (audio/lines.json). */
  audio: string[][];
  /** Silence after each line, for the assistant's answer. */
  gapSeconds: number;
  /** A call is hung up after this long and dialled again, so calls start and end all through the test. */
  callSeconds: number;
  /** Between one call's first dial and the next's. */
  staggerSeconds: number;
  /** docker stats over ssh, and db:call-stats at the end: off unless a host is given. */
  ssh: { host: string; port: number | null; sampleSeconds: number; apiContainer: string } | null;
  /** db:call-stats --json --calls output saved earlier: first audio, stalls and turn times from the database. */
  statsFile: string | null;
  out: string;
  dryRun: boolean;
  /** Real (billed) browser calls are placed only with --spend; without it, simulated calls where the server has them. */
  spend: boolean;
  headed: boolean;
  /** Rebuild the report from a run's JSON (with --stats-file, say), with no calls and no streams. */
  reportOnly: string | null;
}

export const USAGE = `usage: ATTENDRA_COOKIE='<cookie header>' pnpm --filter @attendra/web load-test -- --base <url> --clinic <id>[,<id>...]
  [--calls 20] [--streams 10] [--minutes 15] [--audio a.wav,b.wav ...] [--gap 8] [--call-seconds 180] [--stagger 3]
  [--ssh <host> [--ssh-port 22] [--sample 10] [--api-container attendra-api-1]] [--stats-file stats.json]
  [--out load-reports] [--spend] [--headed]
  --dry-run: 1 call, 1 stream, 1 minute against a local demo (signs in as a demo login when no cookie is given)
  --report <run.json> [--stats-file stats.json]: rebuild the report only`;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (url: string) => LOOPBACK.has(new URL(url).hostname);

const positive = (name: string, v: string | undefined, fallback: number) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} takes a number above 0`);
  return n;
};

export function parseOptions(argv: string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--') ? [args[i + 1]!] : []));
  const one = (name: string) => all(name).at(-1);
  const has = (name: string) => args.includes(`--${name}`);
  const known = new Set(['base', 'clinic', 'calls', 'streams', 'minutes', 'audio', 'gap', 'call-seconds', 'stagger', 'ssh', 'ssh-port', 'sample', 'api-container', 'stats-file', 'out', 'dry-run', 'spend', 'headed', 'report']);
  const unknown = args.filter((a) => a.startsWith('--') && !known.has(a.slice(2)));
  if (unknown.length) throw new Error(`unknown option ${unknown.join(', ')}`);

  const reportOnly = one('report') ?? null;
  const dryRun = has('dry-run');
  const base = (one('base') ?? '').replace(/\/$/, '');
  if (!reportOnly) {
    if (!base) throw new Error('--base is required');
    if (!/^https?:\/\//.test(base)) throw new Error('--base is a URL, http(s)://...');
    if (dryRun && !isLoopback(base)) throw new Error('--dry-run runs against this machine only: --base must be localhost or 127.0.0.1');
  }
  const host = one('ssh');
  return {
    base,
    clinics: all('clinic').flatMap((c) => c.split(',')).map((c) => c.trim()).filter(Boolean),
    calls: dryRun ? 1 : positive('calls', one('calls'), 20),
    streams: dryRun ? 1 : positive('streams', one('streams'), 10),
    minutes: dryRun ? 1 : positive('minutes', one('minutes'), 15),
    audio: all('audio').map((a) => a.split(',').map((p) => p.trim()).filter(Boolean)),
    gapSeconds: positive('gap', one('gap'), 8),
    callSeconds: positive('call-seconds', one('call-seconds'), dryRun ? 40 : 180),
    staggerSeconds: positive('stagger', one('stagger'), 3),
    ssh: host ? { host, port: one('ssh-port') ? positive('ssh-port', one('ssh-port'), 22) : null, sampleSeconds: positive('sample', one('sample'), 10), apiContainer: one('api-container') ?? 'attendra-api-1' } : null,
    statsFile: one('stats-file') ?? null,
    out: one('out') ?? 'load-reports',
    dryRun,
    spend: has('spend'),
    headed: has('headed'),
    reportOnly,
  };
}

/** The session cookies, one Cookie header a line: calls and streams take them in turn, so each session's per-minute limit is shared by fewer pages. */
export function sessions(env: string | undefined): string[] {
  return (env ?? '').split(/\r?\n/).map((l) => l.trim().replace(/^cookie:\s*/i, '')).filter(Boolean);
}

/** A Cookie header as the cookies a browser context is given for the address. */
export function cookiesFor(header: string, base: string) {
  const secure = new URL(base).protocol === 'https:';
  return header.split(';').map((p) => p.trim()).filter((p) => p.includes('=')).map((p) => {
    const eq = p.indexOf('=');
    return { name: p.slice(0, eq), value: p.slice(eq + 1), url: base, secure, httpOnly: true, sameSite: 'Lax' as const };
  });
}
