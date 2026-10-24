// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createPhiCipher } from '@attendra/db';
import { createAlerter, createLogger } from '@attendra/observability';
import { loadEnv } from './config';
import { SPEND_ALERT_PATH, spendTriggers, TwilioFallback, TwilioSpendAlerts, twilioSender } from '@attendra/telephony';
import twilio from 'twilio';
import { bossQueue, createBoss, eventSink } from './queue';
import { embedderFromEnv, startWorker, summariserFromEnv } from './runtime';

const env = loadEnv();
const log = createLogger({ name: 'worker', level: env.LOG_LEVEL });
const alerts = createAlerter({ webhookUrl: env.ATTENDRA_SLACK_WEBHOOK_URL, service: 'worker', log });
const boss = createBoss({ connectionString: env.DATABASE_URL });
// pg-boss reports its own errors (a dropped connection, a failed maintenance run) here; ids only
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const summariser = summariserFromEnv(env);
if (summariser.model === 'local') log.warn('no OPENAI_API_KEY: calls are summarised from their facts, without a model');
await startWorker({
  boss, db: connect(env.DATABASE_URL, { onError: (code) => log.error({ code }, 'database connection error') }), cipher: createPhiCipher(env.ATTENDRA_DATA_KEY), summariser, embedder: embedderFromEnv(env), log,
  events: eventSink(bossQueue(boss)),
  texts: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? twilioSender(twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, { timeout: 5000 })) : undefined,
  sms: { publicUrl: env.ATTENDRA_VOICE_PUBLIC_URL, dailyCap: env.ATTENDRA_SMS_DAILY_CAP, monthlyCap: env.ATTENDRA_SMS_MONTHLY_CAP },
  alerts,
  // the backup route needs the trunk as well as the account
  // Twilio calls the voice service when a day's spend passes a line; it needs the service's public address
  spend: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.ATTENDRA_VOICE_PUBLIC_URL
    ? { client: new TwilioSpendAlerts(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN), callbackUrl: `${env.ATTENDRA_VOICE_PUBLIC_URL.replace(/\/+$/, '')}${SPEND_ALERT_PATH}`, triggers: spendTriggers(env.ATTENDRA_SPEND_ALERT_SMS_USD, env.ATTENDRA_SPEND_ALERT_TOTAL_USD) }
    : undefined,
  fallback: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_TRUNK_SID
    ? { client: new TwilioFallback(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN), trunkSid: env.TWILIO_TRUNK_SID, slackWebhookUrl: env.ATTENDRA_SLACK_WEBHOOK_URL }
    : undefined,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // finish the jobs in hand, then stop taking new ones
  process.on(signal, () => { void alerts.flush().then(() => boss.stop({ graceful: true, timeout: 20_000 })).then(() => process.exit(0)); });
}
