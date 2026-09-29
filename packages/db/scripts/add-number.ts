// SPDX-License-Identifier: AGPL-3.0-only
// Points a phone number at a clinic: the number the Twilio trunk delivers, which the
// voice service looks up to decide which clinic answers.
//   pnpm db:add-number --clinic clinic_demo_maple --number +13035550100
// Operators run this; clinic staff cannot change numbers from the dashboard.
import { ClinicConfig } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { connect } from '../src/client';

const { values } = parseArgs({ options: { clinic: { type: 'string' }, number: { type: 'string' } } });
if (!values.clinic || !values.number || !/^\+[1-9]\d{7,14}$/.test(values.number)) {
  console.error('usage: db:add-number --clinic <clinic id> --number <E.164, like +13035550100>');
  process.exit(2);
}
const db = connect(process.env.DATABASE_URL!);
const [row] = (await db.execute(sql`select config from clinics where id = ${values.clinic}`)).rows as [{ config: unknown }?];
if (!row) {
  console.error(`no clinic ${values.clinic}`);
  process.exit(1);
}
const config = ClinicConfig.parse(row.config);
// the first number is the one confirmations are texted from, so a new number goes first
const phoneNumbers = [values.number, ...config.phoneNumbers.filter((n) => n !== values.number)];
await db.transaction(async (tx) => {
  // a number answers for one clinic only: take it out of the one it belonged to
  const [prev] = (await tx.execute(sql`select c.id, c.config from phone_numbers p join clinics c on c.id = p.clinic_id where p.e164 = ${values.number} and c.id <> ${values.clinic}`)).rows as [{ id: string; config: { phoneNumbers: string[] } }?];
  if (prev) {
    const left = prev.config.phoneNumbers.filter((n) => n !== values.number);
    await tx.execute(sql`update clinics set config = jsonb_set(config, '{phoneNumbers}', ${JSON.stringify(left)}::jsonb) where id = ${prev.id}`);
  }
  await tx.execute(sql`insert into phone_numbers (e164, clinic_id) values (${values.number}, ${values.clinic}) on conflict (e164) do update set clinic_id = excluded.clinic_id, status = 'active'`);
  await tx.execute(sql`update clinics set config = ${JSON.stringify({ ...config, phoneNumbers })}::jsonb where id = ${values.clinic}`);
});
console.log(`${values.number} now reaches ${config.name}; texts are sent from it`);
process.exit(0);
