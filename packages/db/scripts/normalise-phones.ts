// SPDX-License-Identifier: AGPL-3.0-only
// One number, one form (2026-11): every stored phone (records, requests, each clinic's settings) as E.164.
// Prints counts only. `--apply` writes; `--dry-run` (or nothing) changes nothing. Safe to run again.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { normalisePhones } from '../src/repositories/phone-cleanup';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply') && !process.argv.includes('--dry-run');
const r = await normalisePhones(connect(process.env.DATABASE_URL), createPhiCipher(key), { apply });
const verb = apply ? 'normalised' : 'would normalise';
console.log(`${r.clinics} clinics checked: ${verb} ${r.records} records, ${r.requests} requests, ${r.settings} clinics' settings; ${r.storedTwice} numbers were stored in more than one form; ${r.unreadable} numbers can't be read whole and are left as given`);
console.log(`rows to change: ${r.records + r.requests + r.settings}`);
process.exit(0);
