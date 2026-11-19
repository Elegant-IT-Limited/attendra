// SPDX-License-Identifier: AGPL-3.0-only
// Call speed (2026-11-19): for a clinic's calls in a window, per call path, how long callers waited after they stopped
// speaking, from the calls' event logs (types and times only, never a word): the reply's start (median and p90, against
// the target of under 1.5 s and 2.5 s) and the answer after a lookup, with the lookups run ahead and the acknowledgements.
// Read-only. The event log is kept 7 days.
//   pnpm db:call-speed <clinic id> [<clinic id>...] [--since 2026-11-19T10:00Z] [--until ...] [--days 1] [--json]
import { callSpeed, formatCallSpeed, type SpeedCall } from '@attendra/core';
import { connect } from '../src/client';
import { speedCallsIn } from '../src/repositories/call-events';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const clinicIds = args.filter((a) => a.startsWith('clinic_'));
if (!clinicIds.length) throw new Error('usage: pnpm db:call-speed <clinic id> [<clinic id>...] [--days N | --since ISO] [--until ISO] [--json]');
const since = flag('--since') ? new Date(flag('--since')!) : new Date(Date.now() - Number(flag('--days') ?? 1) * 86_400_000);
const until = flag('--until') ? new Date(flag('--until')!) : new Date();
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error('--since and --until take an ISO date or time');
const db = connect(process.env.DATABASE_URL);
const calls: SpeedCall[] = [];
for (const id of clinicIds) calls.push(...await speedCallsIn(db, id, since, until));
const paths = callSpeed(calls);
if (args.includes('--json')) console.log(JSON.stringify({ since, until, paths }, null, 2));
else {
  console.log(`call speed ${since.toISOString()} to ${until.toISOString()}: ${calls.length} calls with an event log`);
  for (const line of formatCallSpeed(paths)) console.log(line);
}
process.exit(0);
