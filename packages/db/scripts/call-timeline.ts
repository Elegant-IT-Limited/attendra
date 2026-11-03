// SPDX-License-Identifier: AGPL-3.0-only
// One call's timeline (2026-11): per stored line, the speaker, start_ms, end_ms and length in characters, and the gap
// since the line before. Read-only; never the text. Usage: pnpm db:call-timeline <call id>
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { callTimeline, formatCallTimeline } from '../src/repositories/calls';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const callId = process.argv.slice(2).find((a) => a !== '--');
if (!callId) throw new Error('usage: pnpm db:call-timeline <call id>');
const timeline = await callTimeline(connect(process.env.DATABASE_URL), createPhiCipher(key), callId);
if (!timeline) {
  console.error('no clinic has a call with that id');
  process.exit(1);
}
for (const line of formatCallTimeline(callId, timeline)) console.log(line);
process.exit(0);
