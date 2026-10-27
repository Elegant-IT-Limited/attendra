// SPDX-License-Identifier: AGPL-3.0-only
// One number, one owner (2026-11): puts every pet on a number under the owner of the number's first-registered
// record. Prints counts only. `--apply` writes; without it, a dry run that changes nothing. Safe to run again.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { unifyHouseholds } from '../src/repositories/patients';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply');
const { clinics, numbers, pets } = await unifyHouseholds(connect(process.env.DATABASE_URL), createPhiCipher(key), { apply });
console.log(`${apply ? 'unified' : 'would unify'} ${numbers} numbers with more than one owner name (${pets} pets moved to the number's first owner) across ${clinics} clinics`);
process.exit(0);
