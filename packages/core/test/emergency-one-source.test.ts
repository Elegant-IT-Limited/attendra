import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Batch 1e: `emergencies` is the ONLY source of a vet clinic's emergency route. The older fields stay in the
 * ClinicConfig schema (one line, deprecated) only so an un-migrated stored configuration parses; the migration
 * (`pnpm db:emergency-settings`) is the one place that reads them, to fold them in and remove them. Any other source
 * file that names them fails here: read `emergencies` (emergencyHospitalsOf, emergencyRoute, hospitalNow) instead.
 */
const ROOT = join(__dirname, '../../..');
const OLD = /\b(emergencyHospital|moreEmergencyHospitals)\b/;
// where source lives: every app, every package's src and scripts, the evals' own code
const PLACES = [
  ...readdirSync(join(ROOT, 'apps')).map((a) => `apps/${a}`),
  ...readdirSync(join(ROOT, 'packages')).flatMap((p) => [`packages/${p}/src`, `packages/${p}/scripts`]),
  'evals/src', 'evals/scripts',
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', 'test', 'tests', 'e2e', '.turbo', 'playwright-report', 'test-results']);
// the migration, which folds the old fields in and removes them
const ALLOWED_FILES = new Set(['packages/db/src/emergency-settings-migration.ts', 'packages/db/scripts/emergency-settings.ts']);
// the schema's one deprecated line, so an un-migrated stored configuration still parses
const SCHEMA = { file: 'packages/core/src/clinic.ts', line: /^\s*emergencyHospital: EmergencyHospital\.optional\(\), moreEmergencyHospitals: z\.array\(EmergencyHospital\)\.max\(4\)\.optional\(\),$/ };

function sources(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(full);
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('emergencies is the one source of the emergency route (batch 1e)', () => {
  it('no source file reads the old emergency hospital fields, except the schema line and the migration', () => {
    const files = PLACES.flatMap((p) => sources(join(ROOT, p)));
    expect(files.length).toBeGreaterThan(200); // the walk found the code
    const hits = files.flatMap((full) => {
      const file = relative(ROOT, full);
      if (ALLOWED_FILES.has(file)) return [];
      return readFileSync(full, 'utf8').split('\n').flatMap((line, i) => {
        if (!OLD.test(line)) return [];
        if (file === SCHEMA.file && SCHEMA.line.test(line)) return [];
        return [`${file}:${i + 1}: ${line.trim().slice(0, 120)}`];
      });
    });
    expect(hits, 'read `emergencies` instead (emergencyHospitalsOf, emergencyRoute, hospitalNow)').toEqual([]);
  });

  it('the schema keeps the old fields on exactly one line, marked deprecated', () => {
    const lines = readFileSync(join(ROOT, SCHEMA.file), 'utf8').split('\n');
    const at = lines.findIndex((l) => SCHEMA.line.test(l));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toMatch(/@deprecated/);
    expect(lines.filter((l) => OLD.test(l))).toHaveLength(1);
  });
});
