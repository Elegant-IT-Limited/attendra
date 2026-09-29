// SPDX-License-Identifier: AGPL-3.0-only
// The whole backend in one process, with no Docker and no keys: an in-memory
// Postgres (PGlite), the demo clinic, a week of calls played through the real agent,
// and the API in demo mode on :8081. `pnpm demo` at the repo root starts this and
// the dashboard together. Everything is gone when the process stops.
import { createPhiCipher } from '@attendra/db';
import { openTestDatabase } from '@attendra/db/testing';
import { createLogger } from '@attendra/observability';
import { randomBytes } from 'node:crypto';
import { createApi } from '../src/app';
import { createAuth } from '../src/auth';
import { DEMO_LOGINS, LOCAL_DEMO_PASSWORD, seedDemoWorkspace } from './demo-data';

const port = Number(process.env.API_PORT ?? 8081);
const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000';
const log = createLogger({ name: 'api', level: process.env.LOG_LEVEL ?? 'info' });

const { db } = await openTestDatabase();
// fresh keys each run: nothing outlives the process, so nothing needs to be kept
const cipher = createPhiCipher(randomBytes(32).toString('base64'));
const auth = createAuth(db, { publicUrl, secret: randomBytes(32).toString('base64'), log });
const results = await seedDemoWorkspace(db, cipher, auth, LOCAL_DEMO_PASSWORD);
const failed = results.filter((r) => !r.passed);
if (failed.length) log.warn({ failed: failed.map((r) => r.id) }, 'some demo calls did not play as their scenario expects');

// On this machine only, so the sign-in page may show the password.
const demoSignIn = { password: LOCAL_DEMO_PASSWORD, logins: DEMO_LOGINS.map(({ email, label }) => ({ email, label })) };
const app = await createApi({ db, cipher, auth, log, options: { publicUrl, demoMode: true, demoSignIn } });
await app.listen({ port, host: '127.0.0.1' });
console.log(`\n  Attendra demo API on http://127.0.0.1:${port}  (${results.length} calls recorded)`);
console.log(`  Open ${publicUrl} and sign in as ${DEMO_LOGINS.map((l) => l.email).join(' or ')}, password ${LOCAL_DEMO_PASSWORD}\n`);
