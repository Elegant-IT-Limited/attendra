// SPDX-License-Identifier: AGPL-3.0-only
// Limits the time a clinic may spend in browser test calls, in all, or lifts the limit.
//   pnpm db:test-call-limit --clinic clinic_demo_maple --minutes 10
//   pnpm db:test-call-limit --clinic clinic_demo_maple --none
// Operators run this (a hosted trial sets it on sign-up); clinic staff cannot change it.
import { parseArgs } from 'node:util';
import { connect } from '../src/client';
import { setTestCallLimit } from '../src/repositories/calls';

const { values } = parseArgs({ options: { clinic: { type: 'string' }, minutes: { type: 'string' }, none: { type: 'boolean' } } });
const minutes = values.minutes === undefined ? null : Number(values.minutes);
if (!values.clinic || (minutes === null) === !values.none || (minutes !== null && !(Number.isInteger(minutes) && minutes >= 0))) {
  console.error('usage: db:test-call-limit --clinic <clinic id> (--minutes <whole number> | --none)');
  process.exit(2);
}
const db = connect(process.env.DATABASE_URL!);
if (!(await setTestCallLimit(db, values.clinic, minutes === null ? null : minutes * 60))) {
  console.error(`no clinic ${values.clinic}`);
  process.exit(1);
}
console.log(minutes === null ? `${values.clinic}: no limit on test calls` : `${values.clinic}: ${minutes} minutes of test calls in all`);
process.exit(0);
