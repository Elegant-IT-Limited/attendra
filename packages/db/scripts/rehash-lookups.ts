// SPDX-License-Identifier: AGPL-3.0-only
// Recomputes every patient's lookup hash with the data key, after an upgrade that changes
// how names are compared (v0.4.1: letters such as ø and ł). Safe to run more than once.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { rehashPatientLookups } from '../src/repositories/patients';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { checked, changed } = await rehashPatientLookups(connect(process.env.DATABASE_URL), createPhiCipher(key));
console.log(`checked ${checked} patients, updated ${changed} lookup hashes`);
process.exit(0);
