import { CEDAR_PARK_CLINIC, DEMO_CLINIC } from '@attendra/core';
import { sql } from 'drizzle-orm';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiKeyRepository, authenticateApiKey, avatarFor, CallRepository, callStats, callTimeline, CallSummaryRepository, cleanTitles, createPhiCipher, type Database,
  FrontDeskRepository, householdOf, inviteToTeam, KnowledgeRepository, listMembers, normalisePhones, PatientRecords, PatientRemoval, phoneUsage, PostgresAuditLog,
  PostgresPatientDirectory, PostgresTaskQueue, qualityRows, saveAvatar, ScheduleRepository, seedCedarPark, seedDemo, seedDemoSchedule, staffNames,
  teamInvitations, clinicCosts, handoffWeeks, listHandoffs, recordHandoff, setHandoffVerdict, viewHandoff, saveVapiSecret, vapiCallEnded, vapiCallLive, vapiConcurrency, vapiSecretHashOf, vapiSecretOf, visitTypeCoverageReport, WebhookRepository, withClinic, withClinicScope,
} from '../src';
import { openTestDatabase, TEST_DATA_KEY } from '../src/testing';

/**
 * Row-level security, per repository, on the services' own role (migration 0051) whatever
 * ATTENDRA_TEST_AS says. Each module in src/repositories has a case: it works for its own
 * clinic (A), shows nothing of A to another clinic (B), and the clinic tables it uses read no
 * row of any clinic on a query with no clinic set. A new repository file without a case fails.
 */
const A = DEMO_CLINIC.id;
const B = CEDAR_PARK_CLINIC.id;
const cipher = createPhiCipher(TEST_DATA_KEY);
let t: Awaited<ReturnType<typeof openTestDatabase>>;
let db: Database;
let patientsA: Record<string, string>;
let callA: string;

const SINCE = new Date(Date.now() - 86_400_000);
const UNTIL = new Date(Date.now() + 86_400_000);
const MARIA = { name: 'Maria Delgado', dob: '1985-03-04', phone: '+13035550147' };

beforeAll(async () => {
  t = await openTestDatabase({ as: 'service' });
  db = t.db;
  ({ patientIds: patientsA } = await seedDemo(db, cipher));
  await seedCedarPark(db, cipher);
  // the logins are fixtures: Better Auth makes them in the app
  await t.owner.execute(sql`insert into auth_users (id, name, email, email_verified) values
    ('u_omar', 'Omar Owner', 'omar@maple.example', true), ('u_cara', 'Cara Cedar', 'cara@cedar.example', true)`);
  await t.owner.execute(sql`insert into memberships (id, organization_id, user_id, role) values ('m_omar', 'org_demo', 'u_omar', 'owner'), ('m_cara', 'org_cedar_park', 'u_cara', 'owner')`);
  const calls = new CallRepository(db, cipher);
  callA = await calls.open(A, 'rls_call_a', MARIA.phone);
  await calls.appendSegment(A, callA, { speaker: 'caller', text: 'Hi, this is Maria.', startMs: 0, endMs: 900 });
  await calls.recordAction(A, callA, { tool: 'find_patient', argsRedacted: {}, result: { ok: true }, taskRevision: 1, patientId: patientsA.maria! });
  await calls.close(A, callA, { reason: 'caller_hangup', voiceSeconds: 30, outcome: 'task_created', emergency: false });
}, 60_000);
afterAll(async () => { await t?.close(); });

interface Case {
  /** Works on the services' role for its own clinic. */
  own: () => Promise<void>;
  /** Clinic B sees nothing of clinic A through it. */
  other: () => Promise<void>;
  /** The row-level security tables it reads or writes: none of their rows shows without a clinic. */
  tables: string[];
}

const CASES: Record<string, Case> = {
  'api-keys.ts': (() => {
    let key = '';
    return {
      tables: ['api_keys'],
      own: async () => {
        ({ key } = await new ApiKeyRepository(db).create(A, { name: 'Front desk tool', scopes: ['requests:read'], expiresAt: UNTIL, userId: 'u_omar' }));
        expect((await new ApiKeyRepository(db).list(A)).map((k) => k.name)).toEqual(['Front desk tool']);
        // found by its hash before the clinic is known: api_key_by_hash, the one way past the policy
        expect(await authenticateApiKey(db, key)).toMatchObject({ clinicId: A, createdByUserId: 'u_omar' });
      },
      other: async () => {
        expect(await new ApiKeyRepository(db).list(B)).toEqual([]);
      },
    };
  })(),
  'audit.ts': {
    tables: ['audit_logs'],
    own: async () => {
      await new PostgresAuditLog(db).record(A, { actor: 'user:u_omar', action: 'patient.viewed', entity: 'patient', entityId: patientsA.maria! });
      expect([...(await staffNames(db, A, ['u_omar'])).values()]).toEqual(['Omar Owner']);
    },
    other: async () => {
      expect((await staffNames(db, B, ['u_omar'])).size).toBe(0);
    },
  },
  'call-stats.ts': {
    tables: ['calls', 'call_segments'],
    own: async () => {
      expect((await callStats(db, cipher, { clinicIds: [A], since: SINCE })).map((r) => r.id)).toContain(callA);
    },
    other: async () => {
      expect((await callStats(db, cipher, { clinicIds: [B], since: SINCE })).map((r) => r.id)).not.toContain(callA);
    },
  },
  'calls.ts': {
    tables: ['calls', 'call_segments', 'call_actions', 'call_costs', 'call_search_keys'],
    own: async () => {
      expect(await callTimeline(db, cipher, callA)).toMatchObject({ clinicId: A, segments: [{ speaker: 'caller' }] });
    },
    other: async () => {
      // the session is A's: B opening it is a routing bug, refused, and B never sees A's call
      await expect(new CallRepository(db, cipher).open(B, 'rls_call_a', null)).rejects.toThrow(/another clinic/);
    },
  },
  'front-desk.ts': {
    tables: ['calls', 'tasks', 'patients'],
    own: async () => {
      const list = await new FrontDeskRepository(db, cipher).listCalls(A, { limit: 50 });
      expect(JSON.stringify(list)).toContain(callA);
    },
    other: async () => {
      expect(JSON.stringify(await new FrontDeskRepository(db, cipher).listCalls(B, { limit: 50 }))).not.toContain(callA);
    },
  },
  'vapi.ts': {
    tables: ['vapi_secrets', 'calls', 'call_costs'],
    own: async () => {
      await saveVapiSecret(db, cipher, A, 'location-a-secret-for-the-rls-test-0123456789');
      expect(await vapiSecretOf(db, cipher, A)).toBe('location-a-secret-for-the-rls-test-0123456789');
      expect(await vapiSecretHashOf(db, A)).toMatch(/\S+/);
      expect((await clinicCosts(db, A, SINCE, UNTIL)).engines.reduce((n, e) => n + e.calls, 0)).toBeGreaterThan(0);
      // the live Vapi calls are the deployment's (no clinic): counted and ended on the services' role
      const at = new Date();
      expect((await vapiCallLive(db, 'rls-vapi-1', at, 100)).live).toBeGreaterThanOrEqual(1);
      await vapiCallEnded(db, 'rls-vapi-1', at);
      expect((await vapiConcurrency(db, at)).live).toBe(0);
    },
    other: async () => {
      expect(await vapiSecretOf(db, cipher, B)).toBeNull();
      expect(await vapiSecretHashOf(db, B)).toBeNull();
      expect((await clinicCosts(db, B, SINCE, UNTIL)).engines).toEqual([]);
    },
  },
  'handoffs.ts': (() => {
    let id = '';
    return {
      tables: ['handoffs', 'audit_logs'],
      own: async () => {
        id = await recordHandoff(db, cipher, A, callA, { kind: 'callback', reason: 'caller_asked_person', lineId: 'callback_taken', steps: [{ tool: 'create_callback', result: 'ok' }], excerpt: [{ speaker: 'caller', text: 'Call me back.' }] });
        expect((await listHandoffs(db, { clinicId: A })).map((h) => h.id)).toContain(id);
        expect((await listHandoffs(db)).map((h) => h.id)).toContain(id);
        expect((await viewHandoff(db, cipher, A, id, 'reviewer@example.com'))?.excerpt).toEqual([{ speaker: 'caller', text: 'Call me back.' }]);
        expect(await setHandoffVerdict(db, A, id, { verdict: 'needed', fixCategory: null, by: 'reviewer@example.com' })).toBe(true);
        expect((await handoffWeeks(db, { clinicId: A, from: SINCE, to: UNTIL })).reduce((n, w) => n + w.handoffs, 0)).toBeGreaterThan(0);
      },
      other: async () => {
        expect(await listHandoffs(db, { clinicId: B })).toEqual([]);
        expect(await viewHandoff(db, cipher, B, id, 'reviewer@example.com')).toBeNull();
        expect(await setHandoffVerdict(db, B, id, { verdict: 'not_needed', fixCategory: null, by: 'reviewer@example.com' })).toBe(false);
        expect((await handoffWeeks(db, { clinicId: B, from: SINCE, to: UNTIL })).reduce((n, w) => n + w.handoffs, 0)).toBe(0);
      },
    };
  })(),
  'invitations.ts': {
    tables: ['audit_logs'],
    own: async () => {
      expect(await inviteToTeam(db, A, { userId: 'u_omar', role: 'owner' }, { email: 'ana@maple.example', role: 'staff' })).toMatchObject({ result: 'done' });
      expect((await teamInvitations(db, A)).map((i) => i.email)).toEqual(['ana@maple.example']);
    },
    other: async () => {
      expect(await teamInvitations(db, B)).toEqual([]);
    },
  },
  'knowledge.ts': {
    tables: ['knowledge_documents'],
    own: async () => {
      await new KnowledgeRepository(db).save(A, { title: 'Parking', sourceType: 'text', content: Buffer.from('Park behind the clinic.'), userId: 'u_omar' });
      expect((await new KnowledgeRepository(db).list(A)).map((d) => d.title)).toEqual(['Parking']);
    },
    other: async () => {
      expect(await new KnowledgeRepository(db).list(B)).toEqual([]);
    },
  },
  'patient-records.ts': {
    tables: ['patients', 'patient_search_keys'],
    own: async () => {
      expect((await new PatientRecords(db, cipher).newest(A, 'u_omar')).map((p) => p.id)).toContain(patientsA.maria);
    },
    other: async () => {
      expect((await new PatientRecords(db, cipher).newest(B, 'u_cara')).map((p) => p.id)).not.toContain(patientsA.maria);
    },
  },
  'patient-removal.ts': {
    tables: ['patients', 'patient_search_keys', 'appointments', 'tasks', 'calls', 'sms_messages'],
    own: async () => {
      // a preview only: the record stays for the other cases
      expect(await new PatientRemoval(db, cipher).previewDelete(A, patientsA.maria!, 'pet', new Date())).toMatchObject({ records: 1 });
    },
    other: async () => {
      expect(await new PatientRemoval(db, cipher).previewDelete(B, patientsA.maria!, 'household', new Date())).toBeNull();
      expect(await new PatientRemoval(db, cipher).delete(B, patientsA.maria!, 'pet', 'u_cara', new Date())).toBeNull();
      expect(await new PatientRemoval(db, cipher).previewMerge(B, 'pet', patientsA.maria!, patientsA.james!)).toEqual({ problem: 'not_found' });
    },
  },
  'patients.ts': {
    tables: ['patients'],
    own: async () => {
      expect(await new PostgresPatientDirectory(db, cipher).findByIdentity(A, MARIA.name, MARIA.dob, MARIA.phone)).toMatchObject({ status: 'found' });
    },
    other: async () => {
      expect(await new PostgresPatientDirectory(db, cipher).findByIdentity(B, MARIA.name, MARIA.dob, MARIA.phone)).not.toMatchObject({ status: 'found' });
    },
  },
  'phone-cleanup.ts': {
    // a job across clinics: each one under its own clinic, so it counts A's records and B's
    tables: ['patients', 'tasks'],
    own: async () => {
      expect(await normalisePhones(db, cipher, { apply: false })).toMatchObject({ clinics: 2, unreadable: 0 });
    },
    other: async () => {
      // B alone has two pets, A six: one clinic's records never count twice
      const rows = await withClinic(db, B, async (tx) => (await tx.execute(sql`select count(*)::int as n from patients`)).rows);
      expect(rows).toEqual([{ n: 2 }]);
    },
  },
  'profile.ts': {
    tables: [],
    own: async () => {
      await saveAvatar(db, 'u_omar', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
      expect(await avatarFor(db, 'u_omar', 'u_omar')).not.toBeNull();
    },
    other: async () => {
      // no clinic shared: Cedar Park's owner cannot fetch Maple Street's owner's picture
      expect(await avatarFor(db, 'u_cara', 'u_omar')).toBeNull();
    },
  },
  'provisioning.ts': {
    tables: ['calls', 'call_actions', 'sms_messages'],
    own: async () => {
      // a text the carrier took: written by the voice service's messenger, a fixture here
      await t.owner.execute(sql`insert into sms_messages (clinic_id, call_id, template, to_hash, status, idempotency_key, provider_sid, sent_at)
        values (${A}, ${callA}, 'booked', 'h', 'sent', 'rls-text-1', 'SM00000000000000000000000000000001', now())`);
      expect(await phoneUsage(db, A, SINCE, UNTIL)).toMatchObject({ calls: 1, texts: 1 });
    },
    other: async () => {
      expect(await phoneUsage(db, B, SINCE, UNTIL)).toMatchObject({ calls: 0, seconds: 0 });
    },
  },
  'quality.ts': {
    tables: ['calls', 'call_summaries'],
    own: async () => {
      expect((await qualityRows(db, A, SINCE, UNTIL)).map((r) => r.callId)).toContain(callA);
    },
    other: async () => {
      expect(await qualityRows(db, B, SINCE, UNTIL)).toEqual([]);
    },
  },
  'schedule.ts': {
    tables: ['appointments'],
    own: async () => {
      await seedDemoSchedule(db, cipher, { patientIds: patientsA, staffUserIds: ['u_omar'] });
      expect((await new ScheduleRepository(db, cipher).rangeWithoutNames(A, { from: SINCE, to: new Date(Date.now() + 15 * 86_400_000) })).length).toBeGreaterThan(0);
    },
    other: async () => {
      expect(await new ScheduleRepository(db, cipher).rangeWithoutNames(B, { from: SINCE, to: new Date(Date.now() + 15 * 86_400_000) })).toEqual([]);
    },
  },
  'summaries.ts': {
    tables: ['calls', 'call_segments', 'call_summaries'],
    own: async () => {
      const summaries = new CallSummaryRepository(db, cipher);
      expect(await summaries.forSummary(A, callA)).toMatchObject({ transcript: expect.anything() });
      expect(await summaries.save(A, callA, { summary: 'Asked for a refill.', intent: 'refill', sentiment: 'calm', needsReview: false, reviewReason: null, followUp: null }, 'local')).toBe('saved');
    },
    other: async () => {
      expect(await new CallSummaryRepository(db, cipher).forSummary(B, callA)).toBeNull();
    },
  },
  'tasks.ts': {
    tables: ['tasks', 'clinic_counters'],
    own: async () => {
      const { id } = await new PostgresTaskQueue(db, cipher).create(A, { type: 'callback', callId: callA, patientId: patientsA.maria!, idempotencyKey: 'rls-1', details: { reason: 'question' } });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await withClinic(db, A, (tx) => householdOf(tx, cipher, A, patientsA.maria!, null))).not.toBeNull();
    },
    other: async () => {
      expect(await withClinic(db, B, (tx) => householdOf(tx, cipher, B, patientsA.maria!, callA))).toBeNull();
    },
  },
  'team.ts': {
    tables: [],
    own: async () => {
      expect((await listMembers(db, A)).map((m) => m.userId)).toEqual(['u_omar']);
    },
    other: async () => {
      expect((await listMembers(db, B)).map((m) => m.userId)).toEqual(['u_cara']);
    },
  },
  'title-cleanup.ts': {
    // settings only, in the tenant registry: no clinic table
    tables: [],
    own: async () => {
      expect(await cleanTitles(db, { apply: false })).toMatchObject({ clinics: 2 });
    },
    other: async () => {
      expect((await cleanTitles(db, { apply: false })).clinics).toBe(2);
    },
  },
  'visit-type-coverage.ts': {
    tables: [],
    own: async () => {
      expect((await visitTypeCoverageReport(db)).clinics.map((c) => c.clinicId).sort()).toEqual([B, A].sort());
    },
    other: async () => {
      expect((await visitTypeCoverageReport(db)).unreadable).toBe(0);
    },
  },
  'webhooks.ts': {
    tables: ['webhook_endpoints'],
    own: async () => {
      await new WebhookRepository(db, cipher).create(A, { url: 'https://hooks.example/attendra', description: 'desk', events: ['request.done'], secret: 'whsec_rls_test_only', userId: 'u_omar' });
      expect((await new WebhookRepository(db, cipher).list(A)).map((e) => e.url)).toEqual(['https://hooks.example/attendra']);
    },
    other: async () => {
      expect(await new WebhookRepository(db, cipher).list(B)).toEqual([]);
    },
  },
};

const repositoryFiles = readdirSync(join(import.meta.dirname, '../src/repositories')).filter((f) => f.endsWith('.ts')).sort();

describe('row-level security per repository, as attendra_service', () => {
  it('has a case for every repository module', () => {
    expect(repositoryFiles.filter((f) => !CASES[f])).toEqual([]);
    expect(Object.keys(CASES).filter((f) => !repositoryFiles.includes(f))).toEqual([]);
  });

  it('runs as a role row-level security holds', async () => {
    const [r] = (await db.execute(sql`select current_user as role, rolsuper, rolbypassrls from pg_roles where rolname = current_user`)).rows;
    expect(r).toEqual({ role: 'attendra_service', rolsuper: false, rolbypassrls: false });
  });

  describe.each(Object.keys(CASES))('%s', (file) => {
    const c = CASES[file]!;
    it('works for its own clinic', async () => { await c.own(); });
    it("shows another clinic nothing of this one's", async () => { await c.other(); });
  });

  // after every case ran, so each table holds rows of A
  describe.each(Object.keys(CASES).filter((f) => CASES[f]!.tables.length))('the tables %s uses', (file) => {
    it.each(CASES[file]!.tables)('%s: no row without a clinic, and none of A as B', async (table) => {
      const count = async (run: Database | Parameters<Parameters<typeof withClinic>[2]>[0], where = sql`true`) =>
        ((await run.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where ${where}`)).rows[0] as { n: number }).n;
      expect(await count(t.owner, sql`clinic_id = ${A}`)).toBeGreaterThan(0);
      expect(await count(db)).toBe(0);
      expect(await withClinicScope(db, B, (tx) => count(tx, sql`clinic_id = ${A}`))).toBe(0);
      expect(await withClinic(db, B, (tx) => count(tx, sql`clinic_id = ${A}`))).toBe(0);
    });
  });

  it('reads no row of any clinic table without a clinic, while the owner sees them', async () => {
    const forced = (await t.owner.execute(sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity order by 1`)).rows as { name: string }[];
    expect(forced.length).toBeGreaterThan(15);
    let ownerSees = 0;
    for (const { name } of forced) {
      expect([name, ((await db.execute(sql`select count(*)::int as n from ${sql.identifier(name)}`)).rows[0] as { n: number }).n]).toEqual([name, 0]);
      ownerSees += ((await t.owner.execute(sql`select count(*)::int as n from ${sql.identifier(name)}`)).rows[0] as { n: number }).n;
    }
    expect(ownerSees).toBeGreaterThan(0);
  });

  it('keeps every clinic table behind forced row-level security, but the tenant registry and the team tables', async () => {
    // tables with a clinic_id and no forced policy: the registry (0051) and the team's own rows, which are not patient data
    const open = (await t.owner.execute(sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'clinic_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r' and not c.relforcerowsecurity order by 1`)).rows.map((r: unknown) => (r as { name: string }).name);
    expect(open).toEqual(['clinic_memberships', 'invitations', 'phone_numbers']);
  });

  it('may call no function that runs as the owner but the ones 0051 made for it', async () => {
    const definers = (await t.owner.execute(sql`select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and has_function_privilege('attendra_service', p.oid, 'execute') order by 1`)).rows.map((r: unknown) => (r as { name: string }).name);
    expect(definers).toEqual(['api_key_by_hash']);
  });
});
