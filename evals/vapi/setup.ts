// SPDX-License-Identifier: AGPL-3.0-only
// Path C of the bake-off (batch 1a, round 2): creates or updates one Vapi assistant for a test clinic, with our tools
// as its function tools, pointed at a running Attendra voice service. Never for a real clinic.
//   VAPI_API_KEY=... VAPI_SERVER_SECRET=... pnpm --filter @attendra/evals vapi-setup -- --url https://<public address> [--clinic clinic_bakeoff]
// With --clinic (and DATABASE_URL), the clinic's settings come from the database (on a deployment: the bake-off clinic,
// pnpm db:seed-bakeoff); without it, the demo clinic as the local demo seeds it. Vapi reaches /webhooks/vapi/v1/events
// at the public address. Prints the assistant id (an id, not a secret) and keeps it in ~/.attendra-vapi-assistant.
import { voiceToolDefinitions } from '@attendra/agent';
import { ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
import { clinicById, connect } from '@attendra/db';
import { toolsVoicePrompt } from '@attendra/voice-engine';
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
if (!clinic.id.startsWith('clinic_bakeoff') && !clinic.id.startsWith('clinic_demo')) throw new Error(`${clinic.id} is not a test clinic: path C is for the bake-off only`);
const NAME = `Attendra bake-off (${clinic.id})`;
const server = { url: `${base}/webhooks/vapi/v1/events?clinic=${clinic.id}`, headers: { 'x-vapi-secret': secret } };

/**
 * Our tool parameters, as Vapi's validator takes them (it answers 400 otherwise): no "$schema" line, and every property
 * with a "type", so an optional field written as anyOf [{type: string, ...}, {type: null}] becomes
 * {type: [string, null], ...}, the same schema in the form Vapi reads.
 */
type Schema = { [k: string]: unknown };
const forVapi = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(forVapi);
  if (!v || typeof v !== 'object') return v;
  const o: Schema = Object.fromEntries(Object.entries(v).filter(([k]) => k !== '$schema').map(([k, x]) => [k, forVapi(x)]));
  const branches = o.anyOf as Schema[] | undefined;
  if (!('type' in o) && Array.isArray(branches) && branches.every((b) => typeof b.type === 'string')) {
    const real = branches.filter((b) => b.type !== 'null');
    const nullable = real.length < branches.length;
    if (real.length === 1) { const rest = { ...o }; delete rest.anyOf; return { ...rest, ...real[0], type: nullable ? [real[0]!.type, 'null'] : real[0]!.type }; }
    o.type = [...new Set(branches.map((b) => b.type))];
  }
  return o;
};

const assistant = {
  name: NAME,
  firstMessage: clinic.greeting,
  firstMessageMode: 'assistant-speaks-first',
  model: {
    provider: 'openai', model: flag('--model') ?? 'gpt-4.1', temperature: 0.3,
    messages: [{ role: 'system', content: toolsVoicePrompt(clinic, { callerNumber: null }) }],
    tools: voiceToolDefinitions(clinic).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: forVapi(t.parameters) }, server })),
  },
  voice: { provider: 'vapi', voiceId: flag('--voice') ?? 'Elliot' },
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'multi' },
  server,
  serverMessages: ['conversation-update', 'end-of-call-report', 'status-update'],
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
