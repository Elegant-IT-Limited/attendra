// SPDX-License-Identifier: AGPL-3.0-only
// The deployment's BYO SIP trunk credential at Vapi, for our Twilio Vapi trunk (batch 6): made once, shared by every
// location; its id goes in VAPI_SIP_CREDENTIAL_ID. Prints the request it would send, and sends it only with --apply.
//   pnpm --filter @attendra/api vapi-sip-credential -- --inbound <cidr,cidr,...> [--termination <trunk>.pstn.twilio.com] [--port 5060] [--update <credential id>] [--apply]
// --inbound: every Twilio Elastic SIP Trunking signalling network (Twilio's current list, primary and failover edges),
// as a.b.c.d/nn. With --apply it needs VAPI_API_KEY (on the server, never in chat) and prints the credential id only.
import { vapiClient, vapiSipCredential } from '@attendra/voice-engine';

const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const inbound = (flag('--inbound') ?? '').split(',').map((c) => c.trim()).filter(Boolean);
const body = vapiSipCredential({ inboundCidrs: inbound, terminationHost: flag('--termination'), port: flag('--port') ? Number(flag('--port')) : undefined });
console.log(JSON.stringify(body, null, 2));
if (!args.includes('--apply')) {
  console.log('dry run: nothing sent (add --apply to create it, or --update <id> --apply to replace its gateways)');
  process.exit(0);
}
const key = process.env.VAPI_API_KEY;
if (!key) throw new Error('--apply needs VAPI_API_KEY');
const client = vapiClient(key);
const update = flag('--update');
const saved = update ? await client.updateCredential(update, { gateways: body.gateways }) : await client.createCredential(body);
console.log(`${update ? 'updated' : 'created'} credential ${saved.id}: set VAPI_SIP_CREDENTIAL_ID=${saved.id} in the API's environment`);
process.exit(0);
