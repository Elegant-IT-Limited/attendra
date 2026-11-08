// SPDX-License-Identifier: AGPL-3.0-only
// A draft scenario from one real call (2026-11): `pnpm evals:draft-from-call <call id>` reads the call (its lines,
// what the tools did, the clinic, the households on its numbers), makes every name, number, address, email and date
// up (anonymise.ts), and writes evals/drafts/<date>-<call id first 8>.yaml, which git ignores. `--stdout` prints it
// instead, so on a server no file stays behind. Needs DATABASE_URL and ATTENDRA_DATA_KEY. A person reads every
// draft before turning it into a scenario: the caller's lines are kept, the expectations are left as TODO.
import { type Database, type PhiCipher, connect, createPhiCipher, phiContext, phoneKey, schema, withClinic } from '@attendra/db';
import { and, eq, inArray, or } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Anonymiser, emptyKnown, type KnownEntities } from './anonymise';
import { Scenario } from './scenario';

const { appointments, auditLogs, callActions, calls, callSegments, clinics, patients } = schema;

/** One call as the draft needs it, every value real until the anonymiser has run. */
export interface CallForDraft {
  callId: string;
  startedAt: Date;
  timezone: string;
  industry: string;
  channel: 'phone' | 'web';
  outcome: string | null;
  language: string | null;
  callerNumber: string | null;
  segments: { speaker: 'caller' | 'agent'; text: string; startMs: number; endMs: number }[];
  /** The tools the call ran, when (ms from the call's start), and the error code each returned, if any. Never the arguments. */
  actions: { tool: string; atMs: number; error: string | null }[];
  known: KnownEntities;
}

const OUTCOMES = Scenario.shape.expect.shape.outcome.options;

/** The scenario YAML for a call: anonymised, the caller's lines as turns, the assistant's as TODO comments. */
export function draftScenario(call: CallForDraft): string {
  const anon = new Anonymiser(call.known);
  const caller = call.callerNumber ? anon.numberFor(call.callerNumber) : null;
  const one = (s: string) => anon.text(s).replace(/\s+/g, ' ').trim();
  const q = (s: string) => JSON.stringify(s);
  const id8 = call.callId.slice(0, 8);
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: call.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(call.startedAt);
  const outcome = OUTCOMES.find((o) => o === call.outcome);
  const lines = [
    `# A DRAFT from call ${id8}, anonymised by evals/src/anonymise.ts. Never commit it as it is: read every line,`,
    '# replace anything real that is left, write the expectations, and give it a scenario id.',
    `id: draft-from-call-${id8}`,
    'title: "TODO: what this call shows, in one sentence"',
    'tags: [draft, from-call]',
    `clinic: ${call.industry === 'vet' ? 'riverbend' : 'maple'}`,
    `channel: ${call.channel}`,
    `caller_number: ${caller && call.channel === 'phone' ? q(caller) : 'null'}`,
    `local_time: ${q(localTime)}`,
    'turns:',
  ];
  const ordered = [...call.segments].sort((a, b) => a.startMs - b.startMs);
  const callerAt = ordered.filter((s) => s.speaker === 'caller').map((s) => s.startMs);
  if (!callerAt.length) throw new Error('the call has no caller lines: nothing to draft');
  // the tools that ran after each caller line, before the next one
  const toolsAfter = (startMs: number, next: number | undefined) => call.actions
    .filter((a) => (a.atMs >= startMs && (next === undefined || a.atMs < next)) || (startMs === callerAt[0] && a.atMs < startMs))
    .map((a) => (a.error && /^[a-z_]+$/.test(a.error) ? `${a.tool} (${a.error})` : a.tool)).filter((t) => /^[a-z_ ()]+$/.test(t));
  let said: string[] = [];
  let turn = 0;
  for (const s of ordered) {
    const text = one(s.text);
    if (s.speaker === 'agent') { if (text) said.push(text); continue; }
    for (const a of said) lines.push(`  # TODO expected: ${a}`);
    said = [];
    lines.push(`  - caller: ${q(text || '...')}`);
    const tools = toolsAfter(s.startMs, callerAt[turn + 1]);
    if (tools.length) lines.push(`    # the call's tools after this line: ${tools.join(', ')}`);
    turn++;
  }
  for (const a of said) lines.push(`# TODO expected (the assistant, after the last caller line): ${a}`);
  lines.push('expect:', `  outcome: ${outcome ?? 'info'} # TODO: check it (the call ended as ${outcome ?? 'another outcome'})`);
  if (call.language === 'es') lines.push('  language: es');
  lines.push('');
  return lines.join('\n');
}

/** Where a draft is written: evals/drafts/<call date in UTC>-<call id first 8>.yaml. */
export const draftFile = (call: Pick<CallForDraft, 'callId' | 'startedAt'>, dir = join(import.meta.dirname, '../drafts')) =>
  join(dir, `${call.startedAt.toISOString().slice(0, 10)}-${call.callId.slice(0, 8)}.yaml`);

const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const PHONE_IN = /\+?\d[\d\s().-]{5,}\d/g;

/** What the clinic's settings say that must be made up: its names, its vets, its addresses, every number; and its own visit words, kept. */
export function knownFromConfig(config: unknown): KnownEntities {
  const k = emptyKnown();
  const c = (config ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? [v.trim()] : []);
  k.clinic.push(...str(c.name));
  // the emergency setting's hospitals (its own, and the next choices) and the clinic's other locations: names and addresses
  const e = (c.emergencies ?? {}) as Record<string, unknown>;
  for (const h of [e.hospital, e.backupHospital, e.afterHoursHospital, e.moreHospitals, c.locations].flat()) {
    if (h && typeof h === 'object') { k.clinic.push(...str((h as Record<string, unknown>).name)); k.addresses.push(...str((h as Record<string, unknown>).address)); }
  }
  k.assistant.push(...str(c.assistantName));
  for (const p of Array.isArray(c.providers) ? c.providers : []) k.vets.push(...str((p as Record<string, unknown>)?.name));
  k.addresses.push(...str(c.address));
  for (const v of Array.isArray(c.visitTypes) ? c.visitTypes : []) k.keep.push(...strings([(v as Record<string, unknown>)?.name, (v as Record<string, unknown>)?.names]));
  k.keep.push(...strings((c.lists as Record<string, unknown> | undefined)?.categories), ...strings((Array.isArray(c.providers) ? c.providers : []).map((p) => (p as Record<string, unknown>)?.categories)));
  // phone numbers only: ten digits or more, never a date (the holidays are in the settings too)
  k.numbers.push(...strings(c).flatMap((s) => s.match(PHONE_IN) ?? []).filter((n) => n.replace(/\D/g, '').length >= 10 && !/^\d{4}-\d{2}-\d{2}/.test(n)));
  return k;
}

/**
 * Reads one call for a draft, from whichever clinic has it, each clinic in its own scope. Reading the
 * transcript is a PHI access: it is audited (call.transcript.drafted) in the same transaction. Null when no clinic has the call.
 */
export async function loadCall(db: Database, cipher: PhiCipher, callId: string): Promise<CallForDraft | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) throw new Error('a call id is a UUID');
  for (const clinic of await db.select({ id: clinics.id, timezone: clinics.timezone, config: clinics.config }).from(clinics).orderBy(clinics.id)) {
    const clinicId = clinic.id;
    const found = await withClinic(db, clinicId, async (tx) => {
      const [call] = await tx.select().from(calls).where(and(eq(calls.clinicId, clinicId), eq(calls.id, callId)));
      if (!call) return null;
      const segCtx = phiContext(clinicId, 'call_segments.text');
      const segments = (await tx.select().from(callSegments).where(and(eq(callSegments.clinicId, clinicId), eq(callSegments.callId, callId))).orderBy(callSegments.startMs, callSegments.id))
        .map((s) => ({ speaker: s.speaker, text: cipher.decrypt(s.textEnc, segCtx), startMs: s.startMs, endMs: s.endMs }));
      const actions = (await tx.select().from(callActions).where(and(eq(callActions.clinicId, clinicId), eq(callActions.callId, callId))).orderBy(callActions.id))
        .map((a) => {
          const error = (a.result as { error?: unknown } | null)?.error;
          return { tool: a.tool, atMs: a.createdAt.getTime() - call.startedAt.getTime(), error: typeof error === 'string' ? error : null };
        });
      const callerNumber = call.fromEnc ? cipher.decrypt(call.fromEnc, phiContext(clinicId, 'calls.from')) : null;
      // the households the call touched: its number's, its patient's, the pets it added, booked or cancelled
      const booked = await tx.select({ id: appointments.patientId }).from(appointments)
        .where(and(eq(appointments.clinicId, clinicId), or(eq(appointments.createdByCallId, callId), eq(appointments.cancelledByCallId, callId))));
      const ids = [...new Set([call.patientId, ...booked.map((b) => b.id)].filter((x): x is string => !!x))];
      const first = await tx.select({ phoneHash: patients.phoneHash }).from(patients).where(and(eq(patients.clinicId, clinicId), or(
        eq(patients.createdByCallId, callId), ids.length ? inArray(patients.id, ids) : undefined)));
      const hashes = [...new Set([...first.map((p) => p.phoneHash), callerNumber ? cipher.hash(phoneKey(clinicId, callerNumber)) : null].filter((x): x is string => !!x))];
      const people = hashes.length ? await tx.select().from(patients).where(and(eq(patients.clinicId, clinicId), inArray(patients.phoneHash, hashes))).orderBy(patients.createdAt) : [];
      await tx.insert(auditLogs).values({ clinicId, actor: 'system', action: 'call.transcript.drafted', entity: 'call', entityId: callId, callId });
      const known = knownFromConfig(clinic.config);
      const vet = (clinic.config as { industry?: unknown } | null)?.industry === 'vet';
      const dec = (v: string | null, col: string) => (v ? cipher.decrypt(v, phiContext(clinicId, `patients.${col}`)) : '');
      if (callerNumber) known.numbers.unshift(callerNumber);
      for (const p of people) {
        const firstName = dec(p.firstNameEnc, 'first_name');
        const lastName = dec(p.lastNameEnc, 'last_name');
        const guardian = dec(p.guardianNameEnc, 'guardian_name');
        if (vet) { known.pets.push(firstName); if (guardian) known.owners.push(guardian); if (lastName) known.owners.push(lastName); } else known.owners.push(`${firstName} ${lastName}`, ...(guardian ? [guardian] : []));
        const phone = dec(p.phoneEnc, 'phone');
        if (phone) known.numbers.push(phone);
      }
      return {
        callId, startedAt: call.startedAt, timezone: clinic.timezone, industry: vet ? 'vet' : 'clinic', channel: call.channel, outcome: call.outcome,
        language: call.language, callerNumber, segments, actions, known,
      } satisfies CallForDraft;
    });
    if (found) return found;
  }
  return null;
}

async function main() {
  const key = process.env.ATTENDRA_DATA_KEY;
  if (!key) throw new Error('ATTENDRA_DATA_KEY is required: the same key the services use');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const callId = args.find((a) => !a.startsWith('--'));
  if (!callId) throw new Error('usage: pnpm evals:draft-from-call <call id> [--stdout]');
  const call = await loadCall(connect(process.env.DATABASE_URL), createPhiCipher(key), callId);
  if (!call) {
    console.error('no clinic has a call with that id');
    process.exit(1);
  }
  const yaml = draftScenario(call);
  if (args.includes('--stdout')) {
    process.stdout.write(yaml);
  } else {
    const file = draftFile(call);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, yaml);
    console.log(`wrote ${file} (git ignores evals/drafts/): read every line before it becomes a scenario`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
