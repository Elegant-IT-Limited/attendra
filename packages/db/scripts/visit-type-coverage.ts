// SPDX-License-Identifier: AGPL-3.0-only
// The visit-type check (2026-11-15): per clinic, how many vets do each visit type, and the types nobody does.
// Read-only, clinic ids and counts only: visit types by their place in Settings, never a name. There is no --apply.
import { connect } from '../src/client';
import { formatVisitTypeCoverage, visitTypeCoverageReport } from '../src/repositories/visit-type-coverage';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
for (const line of formatVisitTypeCoverage(await visitTypeCoverageReport(connect(process.env.DATABASE_URL)))) console.log(line);
process.exit(0);
