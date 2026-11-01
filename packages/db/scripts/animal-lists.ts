// SPDX-License-Identifier: AGPL-3.0-only
// The animals list (what vets see) for vet clinics opened before it came with sign-up (2026-11): clinics whose list
// is empty get the default once. Prints counts only. `--apply` writes; without it, a dry run that changes nothing.
import { connect } from '../src/client';
import { seedAnimalLists } from '../src/repositories/provisioning';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply');
const { clinics, vet, empty, filled } = await seedAnimalLists(connect(process.env.DATABASE_URL), { apply });
console.log(`${clinics} clinics, ${vet} vet clinics, ${empty} with no animals list: ${apply ? `${filled} given the default list` : 'would be given the default list'}`);
process.exit(0);
