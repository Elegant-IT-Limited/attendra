// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The alert path's own test: one P0 (`paging_test`) and its "back to normal", sent through the same alerter, Slack
 * webhook and paging rules as a real P0. With no ntfy topic set, the P0 line starts with <!channel> (the on-call
 * phone notifies); the "back to normal" carries no ping. Nothing is wrong when it runs, and the lines say so.
 *
 * The alert window is 1 minute here (15 in the services), so "back to normal" follows a minute later, not 15.
 * Run where the services run, with their settings:  pnpm --filter @attendra/voice paging:test
 * Prints when each line was taken by Slack; never prints the webhook.
 */
import { createAlerter, postToSlack } from '@attendra/observability';

const WINDOW_MS = 60_000;
const webhookUrl = process.env.ATTENDRA_SLACK_WEBHOOK_URL;
if (!webhookUrl) {
  console.log('NOT SENT: ATTENDRA_SLACK_WEBHOOK_URL is not set here');
  process.exit(1);
}

const sent: string[] = [];
let failed = '';
const alerts = createAlerter({
  webhookUrl, service: 'voice', windowMs: WINDOW_MS,
  log: { warn: (_obj, msg) => { failed = msg; console.log(`warn: ${msg}`); } },
  // Slack's own post, timed: the moment each line was taken
  post: async (url, body) => { await postToSlack(url, body); sent.push(new Date().toISOString()); },
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

alerts.alert('paging_test', 'TEST, no action needed: checking that a P0 page reaches the on-call phone.');
await wait(6000);
if (failed || !sent[0]) { console.log(`NOT SENT: ${failed || 'no answer from Slack'}`); process.exit(1); }
console.log(`SENT P0 (with @channel unless ntfy is set) at ${sent[0]}`);
// the window closes with nothing more of the kind: "back to normal"
await wait(WINDOW_MS + 6000);
if (failed || !sent[1]) { console.log(`NOT SENT back to normal: ${failed || 'no answer from Slack'}`); process.exit(1); }
console.log(`SENT back to normal at ${sent[1]}`);
process.exit(0);
