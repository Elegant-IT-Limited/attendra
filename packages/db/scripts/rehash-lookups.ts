// SPDX-License-Identifier: AGPL-3.0-only
// Recomputes every patient's lookup, identity and search hashes, and every call's number search keys, with the data
// key, after an upgrade that changes how records are matched or found (v0.4.1: letters such as ø and ł; v0.5: name,
// date of birth and phone together; v0.10: the first letters, sounds, birthdays and digit runs the search reads).
// A dry run by default: it prints what would change, counts only. `--apply` writes. Safe to run more than once.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { rehashCallLookups } from '../src/repositories/calls';
import { rehashPatientLookups } from '../src/repositories/patients';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply');
const db = connect(process.env.DATABASE_URL);
const cipher = createPhiCipher(key);
const { checked, changed, withoutPhone, duplicates, searchable } = await rehashPatientLookups(db, cipher, { apply });
const callRun = await rehashCallLookups(db, cipher, { apply });
const verb = apply ? 'updated' : 'would update';
console.log(`checked ${checked} patients, ${verb} ${changed}`);
// v0.10: the search keys, so a search finds every record from the first letter without reading the newest thousands
if (searchable) console.log(`${searchable} patients ${apply ? 'now have' : 'need'} the search keys for their names, birthday and phone`);
console.log(`checked ${callRun.checked} calls with a number, ${verb} ${callRun.changed} for the Calls search by digits`);
// these cannot be verified on a call until the front desk fixes them in the dashboard
if (withoutPhone) console.log(`${withoutPhone} patients have no phone number: add one on their page so the assistant can verify them`);
if (duplicates) console.log(`${duplicates} patients are on file twice with the same name, date of birth and phone: merge them`);
if (!apply && (changed || callRun.changed)) console.log('dry run: nothing was written. Run again with --apply to write.');
process.exit(0);
