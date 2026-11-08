// SPDX-License-Identifier: AGPL-3.0-only
// Emergency settings for vet clinics saved before them (batch 1b), and the older fields folded in and removed (batch 1e):
// each clinic without a setting gets what its older fields meant (an on-call line it transferred to: "handle"; a hospital
// alone: "refer"; its other hospitals, in order, as the next choices); a clinic with a setting keeps it, and its old extra
// hospitals become its next choices while it has none. Then the old keys are removed from the stored configuration.
// A dry run by default, changing nothing; `--apply` writes, with an audit row per clinic. Prints each clinic's id and
// counts only: never a name or a number. A clinic with "none" chooses in Settings > Emergencies.
import { connect } from '../src/client';
import { writeEmergencySettings } from '../src/emergency-settings-migration';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const apply = process.argv.includes('--apply');
const rows = await writeEmergencySettings(connect(process.env.DATABASE_URL), { apply });
for (const r of rows) {
  console.log(`${r.clinic}: ${r.action}; setting ${r.setting} (${r.mode}); hospitals ${r.hospitals} (${r.more} next); moved ${r.moved}; dropped ${r.dropped}; old keys removed ${r.removed}`);
}
const changed = rows.filter((r) => r.action !== 'unchanged').length;
console.log(`${apply ? 'APPLIED' : 'DRY RUN (nothing changed; --apply writes)'}: ${rows.length} vet clinics; ${changed} ${apply ? 'written' : 'to write'}; ${rows.filter((r) => r.setting === 'written').length} settings made from old fields; ${rows.filter((r) => r.removed > 0).length} with old keys; ${rows.filter((r) => r.setting === 'none').length} with no emergency setting`);
process.exit(0);
