// SPDX-License-Identifier: AGPL-3.0-only
// The whole backend in one process, with no Docker and no keys: an in-memory
// Postgres (PGlite), the demo clinic, a week of calls played through the real agent,
// and the API in demo mode on :8081. `pnpm demo` at the repo root starts this and
// the dashboard together. Everything is gone when the process stops.
//
// With OPENAI_API_KEY set (in the shell, or in a .env file at the repo root), the
// voice service starts here too, on 127.0.0.1:8080, and the dashboard's Test call
// page talks to the receptionist through your microphone. That uses your OpenAI
// credit: about $0.05 a minute. No phone number or Twilio account is needed.
import { createPhiCipher } from '@attendra/db';
import { openTestDatabase } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { createVoiceApp } from '@attendra/voice/runtime';
import { bossQueue, createBoss } from '@attendra/worker/queue';
import { startWorker, summariserFromEnv } from '@attendra/worker/runtime';
import { LocalSummariser } from '@attendra/worker/summarise';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createApi } from '../src/app';
import { createAuth } from '../src/auth';
import { httpVoiceClient } from '../src/voice';
import { DEMO_LOGINS, LOCAL_DEMO_PASSWORD, seedDemoWorkspace } from './demo-data';

// Only the voice settings come from .env: the rest of it may describe a deployment
// (PUBLIC_URL, ports) and must not change how the local demo runs.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) {
  const file = parseEnv(readFileSync(envFile, 'utf8'));
  for (const key of ['OPENAI_API_KEY', 'GPT_LIVE_MODEL', 'ATTENDRA_BACKEND_MODEL', 'ATTENDRA_SUMMARY_MODEL', 'BROWSER_CALL_MAX_SECONDS'] as const) {
    if (!process.env[key] && file[key]) process.env[key] = file[key];
  }
}

const port = Number(process.env.API_PORT ?? 8081);
const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000';
const log = createLogger({ name: 'api', level: process.env.LOG_LEVEL ?? 'info' });

const { db, client } = await openTestDatabase();
// fresh keys each run: nothing outlives the process, so nothing needs to be kept
const cipher = createPhiCipher(randomBytes(32).toString('base64'));
const auth = createAuth(db, { publicUrl, secret: randomBytes(32).toString('base64'), log });
const results = await seedDemoWorkspace(db, cipher, auth, LOCAL_DEMO_PASSWORD);
// The worker, in this process, on the same in-memory Postgres. Test calls made from
// the browser are summarised by the model when there is a key; with test calls off
// (the e2e suite), or no key, by the local summariser, which never calls OpenAI.
const boss = createBoss({ pglite: client });
boss.on('error', (err) => log.error({ err: { message: err.message } }, 'job queue error'));
await boss.start();
const summariser = process.env.ATTENDRA_TEST_CALLS === 'off' ? new LocalSummariser() : summariserFromEnv(process.env);
await startWorker({ boss, db, cipher, summariser, log: createLogger({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' }), schedulePurge: false });

const failed = results.filter((r) => !r.passed);
if (failed.length) log.warn({ failed: failed.map((r) => r.id) }, 'some demo calls did not play as their scenario expects');

// On this machine only, so the sign-in page may show the password.
const demoSignIn = { password: LOCAL_DEMO_PASSWORD, logins: DEMO_LOGINS.map(({ email, label }) => ({ email, label })) };
let voice = null;
let voiceNote = 'Test calls are off. Put OPENAI_API_KEY in .env to talk to the receptionist from the browser.';
if (process.env.OPENAI_API_KEY && process.env.ATTENDRA_TEST_CALLS !== 'off') {
  const voicePort = Number(process.env.VOICE_PORT || 8080);
  const maxSeconds = Number(process.env.BROWSER_CALL_MAX_SECONDS || 300);
  const internalToken = randomBytes(32).toString('base64url');
  const voiceApp = createVoiceApp({
    db, cipher, log: createLogger({ name: 'voice', level: process.env.LOG_LEVEL ?? 'info' }),
    openaiApiKey: process.env.OPENAI_API_KEY,
    liveModel: process.env.GPT_LIVE_MODEL || 'gpt-live-1',
    backendModel: process.env.ATTENDRA_BACKEND_MODEL || 'gpt-6-luna',
    internalToken,
    browserCallMaxSeconds: Number.isFinite(maxSeconds) ? Math.min(Math.max(maxSeconds, 30), 1800) : 300,
    jobs: bossQueue(boss),
  });
  try {
    await voiceApp.listen({ port: voicePort, host: '127.0.0.1' });
    voice = httpVoiceClient(`http://127.0.0.1:${voicePort}`, internalToken);
    voiceNote = 'Test calls are on: open Test call in the dashboard and allow the microphone.';
  } catch (err) {
    voiceNote = `Test calls are off: port ${voicePort} is taken (${(err as { code?: string }).code ?? 'error'}). Set VOICE_PORT to another port.`;
  }
}

const app = await createApi({ db, cipher, auth, log, voice, options: { publicUrl, demoMode: true, demoSignIn } });
await app.listen({ port, host: '127.0.0.1' });
console.log(`\n  Attendra demo API on http://127.0.0.1:${port}  (${results.length} calls recorded)`);
console.log(`  ${voiceNote}`);
console.log(`  Open ${publicUrl} and sign in as ${DEMO_LOGINS.map((l) => l.email).join(' or ')}, password ${LOCAL_DEMO_PASSWORD}\n`);
