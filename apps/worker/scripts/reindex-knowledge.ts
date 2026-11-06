// SPDX-License-Identifier: AGPL-3.0-only
// New chunking rules (2026-11, migration 0047): documents indexed before them are queued again, so a price list
// is split by its lines and every page's text is counted. The running worker indexes them, with its own model.
// Prints counts only. `--apply` queues; `--dry-run` (or nothing) changes nothing. Safe to run again.
import { connect } from '@attendra/db';
import { bossQueue, createBoss, noJobs } from '../src/queue';
import { queueReindex } from '../src/reindex';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply') && !process.argv.includes('--dry-run');
const db = connect(process.env.DATABASE_URL);
// a producer only: the worker that is running does the indexing and owns the queue's upkeep
const boss = apply ? createBoss({ connectionString: process.env.DATABASE_URL }, { producer: true }) : null;
await boss?.start();
// one run a day is one set of jobs: running it twice the same day queues nothing new
const version = `reindex-${new Date().toISOString().slice(0, 10)}`;
const r = await queueReindex(db, boss ? bossQueue(boss) : noJobs, { apply, version });
await boss?.stop();
console.log(`${r.clinics} clinics, ${r.documents} documents chunked by older rules (${r.ready} ready, ${r.failedEmpty} failed as empty)`);
console.log(apply ? `queued for indexing: ${r.queued}` : 'dry run: nothing queued; run with --apply to queue them');
process.exit(0);
