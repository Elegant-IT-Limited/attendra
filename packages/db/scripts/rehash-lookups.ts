// SPDX-License-Identifier: AGPL-3.0-only
// Recomputes every patient's lookup and identity hashes with the data key, after an upgrade
// that changes how patients are matched (v0.4.1: letters such as ø and ł; v0.5: name, date
// of birth and phone together). Safe to run more than once.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { rehashPatientLookups } from '../src/repositories/patients';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { checked, changed, withoutPhone, duplicates } = await rehashPatientLookups(connect(process.env.DATABASE_URL), createPhiCipher(key));
console.log(`checked ${checked} patients, updated ${changed}`);
// these cannot be verified on a call until the front desk fixes them in the dashboard
if (withoutPhone) console.log(`${withoutPhone} patients have no phone number: add one on their page so the assistant can verify them`);
if (duplicates) console.log(`${duplicates} patients are on file twice with the same name, date of birth and phone: merge them`);
process.exit(0);
