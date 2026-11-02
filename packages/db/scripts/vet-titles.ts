// SPDX-License-Identifier: AGPL-3.0-only
// "Dr." built in (2026-11): vets' names stored without a title, and a title choice for each person at a vet clinic.
// Prints counts only. `--apply` writes; `--dry-run` (or nothing) changes nothing. Safe to run again.
import { connect } from '../src/client';
import { cleanTitles } from '../src/repositories/title-cleanup';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply') && !process.argv.includes('--dry-run');
const r = await cleanTitles(connect(process.env.DATABASE_URL), { apply });
const verb = apply ? 'changed' : 'would change';
console.log(`${r.clinics} clinics checked: ${verb} ${r.settings} clinics' settings; ${r.stripped} names lose a typed title, ${r.titled} people get a title`);
console.log(`rows to change: ${r.stripped + r.titled}`);
process.exit(0);
