// SPDX-License-Identifier: AGPL-3.0-only
// Points a phone number at a clinic: the number the Twilio trunk delivers, which the
// voice service looks up to decide which clinic answers.
//   pnpm db:add-number --clinic clinic_demo_maple --number +13035550100
// Operators run this; clinic staff cannot change numbers from the dashboard.
import { parseArgs } from 'node:util';
import { connect } from '../src/client';
import { assignNumber } from '../src/repositories/provisioning';

const { values } = parseArgs({ options: { clinic: { type: 'string' }, number: { type: 'string' } } });
if (!values.clinic || !values.number || !/^\+[1-9]\d{7,14}$/.test(values.number)) {
  console.error('usage: db:add-number --clinic <clinic id> --number <E.164, like +13035550100>');
  process.exit(2);
}
const db = connect(process.env.DATABASE_URL!);
// the first number is the one confirmations are texted from, so a new number goes first
if (!(await assignNumber(db, values.clinic, values.number))) {
  console.error(`no clinic ${values.clinic}`);
  process.exit(1);
}
console.log(`${values.number} now reaches ${values.clinic}; texts are sent from it`);
process.exit(0);
