// SPDX-License-Identifier: AGPL-3.0-only
// One call's event log (foundation A): per event, its offset from the call's start, the gap since the one before (over
// 2 s marked), its type, response id, item id, how many deltas were folded into it, and an error's type and code.
// Read-only; the log holds no words. Kept 7 days. Usage: pnpm db:call-events <call id>
import { formatCallEvents } from '@attendra/core';
import { connect } from '../src/client';
import { findCallEvents } from '../src/repositories/call-events';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const callId = process.argv.slice(2).find((a) => a !== '--');
if (!callId) throw new Error('usage: pnpm db:call-events <call id>');
const found = await findCallEvents(connect(process.env.DATABASE_URL), callId);
if (!found) {
  console.error('no clinic has a call with that id');
  process.exit(1);
}
if (!found.events.length) console.log(`call ${callId} · clinic ${found.clinicId} · ${found.path}: no events (calls before this release have none, and the log is kept 7 days)`);
else for (const line of formatCallEvents(`call ${callId} · clinic ${found.clinicId} · ${found.path} · started ${found.startedAt.toISOString()} · ${found.events.length} rows`, found.events)) console.log(line);
process.exit(0);
