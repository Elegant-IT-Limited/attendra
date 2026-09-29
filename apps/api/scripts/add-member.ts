// SPDX-License-Identifier: AGPL-3.0-only
// Adds a person to an organization:
//   pnpm --filter @attendra/api add-member --email ana@clinic.example --name "Ana Ruiz" --org org_maple --role staff
// The password is read from ATTENDRA_NEW_PASSWORD so it never lands in shell history.
import { connect } from '@attendra/db';
import { parseArgs } from 'node:util';
import { createAuth } from '../src/auth';
import { loadEnv } from '../src/config';
import { addMember } from '../src/members';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, org: { type: 'string' }, role: { type: 'string' } } });
const role = values.role as 'owner' | 'admin' | 'staff' | 'viewer';
if (!values.email || !values.name || !values.org || !['owner', 'admin', 'staff', 'viewer'].includes(role)) {
  console.error('usage: add-member --email <email> --name <name> --org <org id> --role owner|admin|staff|viewer  (password in ATTENDRA_NEW_PASSWORD)');
  process.exit(2);
}
const password = process.env.ATTENDRA_NEW_PASSWORD ?? '';
const env = loadEnv();
const db = connect(env.DATABASE_URL);
const id = await addMember(createAuth(db, { publicUrl: env.PUBLIC_URL, secret: env.BETTER_AUTH_SECRET }), db, { email: values.email, name: values.name, password, orgId: values.org, role });
console.log(`added ${values.email} to ${values.org} as ${role} (user ${id}). They set up two-factor at first sign-in.`);
process.exit(0);
