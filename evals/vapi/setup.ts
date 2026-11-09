// SPDX-License-Identifier: AGPL-3.0-only
// Path C of the bake-off (batch 1a, round 2): creates or updates one Vapi assistant for a test clinic, with our tools
// as its function tools, pointed at a running Attendra voice service. Never for a real clinic: a location's assistant is
// made by provisioning (batch 6), from the same builder.
//   VAPI_API_KEY=... VAPI_SERVER_SECRET=... pnpm --filter @attendra/evals vapi-setup -- --url https://<public address> [--clinic clinic_bakeoff]
// With --clinic (and DATABASE_URL), the clinic's settings come from the database (on a deployment: the bake-off clinic,
// pnpm db:seed-bakeoff); without it, the demo clinic as the local demo seeds it. Vapi reaches /webhooks/vapi/v1/events
// at the public address. Prints the assistant id (an id, not a secret) and keeps it in ~/.attendra-vapi-assistant.
import { ClinicConfig, isVapiTestClinic, RIVERBEND_CLINIC } from '@attendra/core';
import { clinicById, connect } from '@attendra/db';
import { vapiAssistant, vapiServerUrl } from '@attendra/voice-engine';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const key = process.env.VAPI_API_KEY;
const secret = process.env.VAPI_SERVER_SECRET;
const base = flag('--url')?.replace(/\/+$/, '');
if (!key || !secret || secret.length < 32 || !base?.startsWith('https://')) {
  throw new Error('needs VAPI_API_KEY, VAPI_SERVER_SECRET (32+ characters) and --url https://<public address of the voice service>');
}
const clinicId = flag('--clinic');
if (clinicId && !process.env.DATABASE_URL) throw new Error('--clinic reads the clinic from DATABASE_URL');
// the test clinic as the database holds it, or the demo clinic as the local demo seeds it (booking out of hours)
const clinic = clinicId ? ClinicConfig.parse(await clinicById(connect(process.env.DATABASE_URL!), clinicId)) : ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });
if (!isVapiTestClinic(clinic.id)) throw new Error(`${clinic.id} is not a test clinic: this script is for the bake-off only (a location's assistant is made by provisioning, PUT clinics/:id/vapi)`);
const NAME = `Attendra bake-off (${clinic.id})`;
// the same assistant a location gets from provisioning (packages/voice-engine vapi.ts), with the deployment-wide test secret
const built = vapiAssistant(clinic, { serverUrl: vapiServerUrl(base, clinic.id), secret, name: NAME });
const assistant = {
  ...built,
  model: { ...built.model, ...(flag('--model') ? { model: flag('--model') } : {}) },
  ...(flag('--voice') ? { voice: { provider: 'vapi', voiceId: flag('--voice') } } : {}),
  metadata: { attendra: 'bake-off', clinic: clinic.id },
};

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`https://api.vapi.ai${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`vapi ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<{ id: string; name?: string }[] & { id: string }>;
};
const existing = ((await api('GET', '/assistant?limit=100')) as unknown as { id: string; name?: string }[]).find((a) => a.name === NAME);
const saved = existing ? await api('PATCH', `/assistant/${existing.id}`, assistant) : await api('POST', '/assistant', assistant);
writeFileSync(join(homedir(), '.attendra-vapi-assistant'), `${saved.id}\n`);
console.log(`${existing ? 'updated' : 'created'} assistant ${saved.id} (${NAME}), tools at ${base}/webhooks/vapi/v1/events`);
process.exit(0);
