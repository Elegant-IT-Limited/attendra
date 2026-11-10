// SPDX-License-Identifier: AGPL-3.0-only
import { clinicNameById, connect, createPhiCipher, logConnectionRole, serviceDatabaseUrl } from '@attendra/db';
import { createAlerter, createLogger } from '@attendra/observability';
import { loadEnv } from './config';
import { SPEND_ALERT_PATH, spendTriggers, TwilioBalance, TwilioFallback, TwilioSpendAlerts, twilioSender } from '@attendra/telephony';
import twilio from 'twilio';
import { bossQueue, createBoss, eventSink } from './queue';
import { embedderFromEnv, startWorker, summariserFromEnv } from './runtime';

const env = loadEnv();
const log = createLogger({ name: 'worker', level: env.LOG_LEVEL });
// an alert about a clinic or a call names the clinic and links the call; `db` is read only once an alert needs a name
const alerts = createAlerter({ webhookUrl: env.ATTENDRA_SLACK_WEBHOOK_URL, service: 'worker', log, appUrl: env.PUBLIC_URL, clinicName: async (id) => clinicNameById(db, id) });
// pg-boss on the owner's URL: it creates and upgrades its own schema; the worker's queries on the services' role when given
const boss = createBoss({ connectionString: env.DATABASE_URL });
const db = connect(serviceDatabaseUrl(env), { onError: (code) => log.error({ code }, 'database connection error') });
await logConnectionRole(db, log, !!env.ATTENDRA_SERVICE_DATABASE_URL);
// pg-boss reports its own errors (a dropped connection, a failed maintenance run) here; ids only
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const summariser = summariserFromEnv(env);
if (summariser.model === 'local') log.warn('no OPENAI_API_KEY: calls are summarised from their facts, without a model');
await startWorker({
  boss, db, cipher: createPhiCipher(env.ATTENDRA_DATA_KEY), summariser, embedder: embedderFromEnv(env), log,
  events: eventSink(bossQueue(boss)),
  texts: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? twilioSender(twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, { timeout: 5000 })) : undefined,
  sms: { publicUrl: env.ATTENDRA_VOICE_PUBLIC_URL, dailyCap: env.ATTENDRA_SMS_DAILY_CAP, monthlyCap: env.ATTENDRA_SMS_MONTHLY_CAP },
  alerts,
  // the backup route needs the trunk as well as the account
  // Twilio calls the voice service when a day's spend passes a line; it needs the service's public address
  spend: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.ATTENDRA_VOICE_PUBLIC_URL
    ? { client: new TwilioSpendAlerts(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN), callbackUrl: `${env.ATTENDRA_VOICE_PUBLIC_URL.replace(/\/+$/, '')}${SPEND_ALERT_PATH}`, triggers: spendTriggers(env.ATTENDRA_SPEND_ALERT_SMS_USD, env.ATTENDRA_SPEND_ALERT_TOTAL_USD) }
    : undefined,
  // the balance, every hour: a P0 under the line, as calls and texts stop at $0
  balance: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
    ? { client: new TwilioBalance(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN), alertUnder: env.ATTENDRA_TWILIO_BALANCE_ALERT }
    : undefined,
  fallback: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_TRUNK_SID
    ? { client: new TwilioFallback(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN), trunkSid: env.TWILIO_TRUNK_SID, slackWebhookUrl: env.ATTENDRA_SLACK_WEBHOOK_URL }
    : undefined,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // finish the jobs in hand, then stop taking new ones
  process.on(signal, () => { void alerts.flush().then(() => boss.stop({ graceful: true, timeout: 20_000 })).then(() => process.exit(0)); });
}
