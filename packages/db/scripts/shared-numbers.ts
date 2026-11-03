// SPDX-License-Identifier: AGPL-3.0-only
// The shared-number check (2026-11): which numbers carry more than one owner, or one number stored in two spellings.
// Read-only, counts and dates only: never a name, a number or a hash. There is no --apply: it never writes.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { formatSharedNumbers, sharedNumbers } from '../src/repositories/patients';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
for (const line of formatSharedNumbers(await sharedNumbers(connect(process.env.DATABASE_URL), createPhiCipher(key)))) console.log(line);
process.exit(0);
