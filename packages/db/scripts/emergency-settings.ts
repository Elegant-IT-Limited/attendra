// SPDX-License-Identifier: AGPL-3.0-only
// Emergency settings (batch 1b) for vet clinics saved before them: each gets what its older fields meant (an on-call
// line it transferred to: "handle"; a hospital alone: "refer"). Prints each clinic's id and mode, no names or numbers.
// `--apply` writes; without it, a dry run that changes nothing. A clinic with "none" chooses in Settings > Emergencies.
import { connect } from '../src/client';
import { writeEmergencySettings } from '../src/repositories/provisioning';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply');
const rows = await writeEmergencySettings(connect(process.env.DATABASE_URL), { apply });
for (const r of rows) console.log(`${r.clinic}: ${r.mode} (${r.action})`);
console.log(`${rows.length} vet clinics; ${rows.filter((r) => r.action === (apply ? 'written' : 'would write')).length} ${apply ? 'written' : 'to write'}; ${rows.filter((r) => r.action === 'none').length} with no emergency setting`);
process.exit(0);
