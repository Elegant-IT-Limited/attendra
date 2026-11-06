// SPDX-License-Identifier: AGPL-3.0-only
// Path C of the bake-off (batch 1a, round 2): creates or updates one Vapi assistant for the demo clinic, with our tools
// as its function tools, pointed at a running Attendra voice service. Never for a real clinic.
//   VAPI_API_KEY=... VAPI_SERVER_SECRET=... pnpm --filter @attendra/evals vapi-setup -- --url https://<public address of the voice service>
// The public address is where Vapi reaches /vapi/v1/events (a tunnel to the local demo's voice service on :8080).
// Prints the assistant id and keeps it in ~/.attendra-vapi-assistant (an id, not a secret).
import { voiceToolDefinitions } from '@attendra/agent';
import { ClinicConfig, RIVERBEND_CLINIC } from '@attendra/core';
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
// the demo clinic as the local demo seeds it, booking out of hours as in the other runs
const clinic = ClinicConfig.parse({ ...RIVERBEND_CLINIC, afterHours: 'book' });
const NAME = 'Attendra bake-off (demo clinic)';
const server = { url: `${base}/vapi/v1/events?clinic=${clinic.id}`, headers: { 'x-vapi-secret': secret } };

const assistant = {
  name: NAME,
  firstMessage: clinic.greeting,
  firstMessageMode: 'assistant-speaks-first',
  model: {
    provider: 'openai', model: flag('--model') ?? 'gpt-4.1', temperature: 0.3,
    messages: [{ role: 'system', content: toolsVoicePrompt(clinic, { callerNumber: null }) }],
    tools: voiceToolDefinitions(clinic).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters }, server })),
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
console.log(`${existing ? 'updated' : 'created'} assistant ${saved.id} (${NAME}), tools at ${base}/vapi/v1/events`);
