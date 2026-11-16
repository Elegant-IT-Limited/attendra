// SPDX-License-Identifier: AGPL-3.0-only
// A clinic's daily numbers (foundation A), per call path: stalls, reply time p50/p90, yes-disagreements, refusal loops
// and internal-talk lines, for the clinic's own day (default: yesterday, its clock). A number that cannot be measured yet
// says why. The same function as the QA export's `numbers`. Read-only; counts and times only, never a word.
//   pnpm db:call-numbers <clinic id> [YYYY-MM-DD] [--json]
import { formatDailyNumbers } from '@attendra/core';
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { callNumbers } from '../src/repositories/call-events';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use (internal talk is read from the transcript, in memory)');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const args = process.argv.slice(2).filter((a) => a !== '--');
const clinicId = args.find((a) => a.startsWith('clinic_'));
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
if (!clinicId) throw new Error('usage: pnpm db:call-numbers <clinic id> [YYYY-MM-DD] [--json]');
const n = await callNumbers(connect(process.env.DATABASE_URL), createPhiCipher(key), clinicId, day);
if (!n) {
  console.error('no clinic with that id');
  process.exit(1);
}
if (args.includes('--json')) console.log(JSON.stringify(n, null, 2));
else for (const line of formatDailyNumbers(`call numbers · ${clinicId} · ${n.day} (${n.timezone}) · ${n.calls} calls${n.truncated ? ' (first 1000 only)' : ''}`, n.paths)) console.log(line);
process.exit(0);
