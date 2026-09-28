// SPDX-License-Identifier: AGPL-3.0-only
// Loads the demo clinic and synthetic patients into DATABASE_URL. Never point this at real patient data.
import { connect } from '../src/client';
import { createPhiCipher } from '../src/crypto';
import { seedDemo } from '../src/seed';

const key = process.env.ATTENDRA_DATA_KEY;
if (!key) throw new Error('ATTENDRA_DATA_KEY is required (32 random bytes, base64): openssl rand -base64 32');
const { clinic, patientIds } = await seedDemo(connect(process.env.DATABASE_URL!), createPhiCipher(key));
console.log(`seeded ${clinic.name} (${clinic.phoneNumbers.join(', ')}) with ${Object.keys(patientIds).length} synthetic patients`);
process.exit(0);
