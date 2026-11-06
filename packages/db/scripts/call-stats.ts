// SPDX-License-Identifier: AGPL-3.0-only
// Call statistics for clinics over a window: the numbers every voice batch is measured by (batch 1a; the audit's
// "before" numbers as a tool). Read-only. Prints counts and timings only: never a word of a transcript, a name or a number.
//   pnpm db:call-stats <clinic id> [<clinic id>...] [--days 14] [--since 2026-11-06T10:30Z] [--until ...] [--calls] [--json]
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { callStats, formatCallStats, groupCallStats } from '../src/repositories/call-stats';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const clinicIds = args.filter((a) => a.startsWith('clinic_'));
if (!clinicIds.length) throw new Error('usage: pnpm db:call-stats <clinic id> [<clinic id>...] [--days N | --since ISO] [--until ISO] [--calls] [--json]');
const since = flag('--since') ? new Date(flag('--since')!) : new Date(Date.now() - Number(flag('--days') ?? 14) * 86_400_000);
const until = flag('--until') ? new Date(flag('--until')!) : undefined;
if (Number.isNaN(since.getTime()) || (until && Number.isNaN(until.getTime()))) throw new Error('--since and --until take an ISO date or time');
const rows = await callStats(connect(process.env.DATABASE_URL), createPhiCipher(key), { clinicIds, since, until });
if (args.includes('--json')) console.log(JSON.stringify({ since, until: until ?? null, groups: groupCallStats(rows), calls: args.includes('--calls') ? rows.map((r) => ({ ...r, id: r.id.slice(0, 8) })) : undefined }, null, 2));
else {
  console.log(`call stats ${since.toISOString()} to ${(until ?? new Date()).toISOString()}: ${rows.length} calls`);
  for (const line of formatCallStats(rows, { perCall: args.includes('--calls') })) console.log(line);
}
process.exit(0);
