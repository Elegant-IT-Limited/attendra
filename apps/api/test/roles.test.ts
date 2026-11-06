import { CAPABILITIES, DEMO_CLINIC, PERMISSIONS, type Permission, ROLES, can } from '@attendra/core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi } from './helpers';

/**
 * Every role against what its description says (tester finding 3, 2026-11-04: a Viewer saw
 * nothing at all while the Team page said it sees calls and settings). The words come from
 * the permission table, and each role walks the read route behind every page.
 */
const C = `/api/v1/clinics/${DEMO_CLINIC.id}`;
type Role = 'owner' | 'admin' | 'staff' | 'viewer';
let api: Awaited<ReturnType<typeof startApi>>;
let as: Record<Role, string>;

beforeAll(async () => {
  api = await startApi({ demoMode: false });
  as = {
    owner: await api.signIn('omar@maple.example', true),
    admin: await api.signIn('olga@maple.example', true),
    staff: await api.signIn('ana@maple.example', true),
    viewer: await api.signIn('vic@maple.example', true),
  };
}, 120_000);
afterAll(() => api.close());

describe('one source for roles', () => {
  it('a role\'s "can" list is exactly the capabilities whose permission it has', () => {
    for (const r of ROLES) expect(r.can, r.id).toEqual(CAPABILITIES.filter((c) => can(r.id, c.permission)).map((c) => c.text));
    // the viewer as approved on 2026-11-06: the call list, the schedule and requests, read-only, no names
    expect(ROLES.find((r) => r.id === 'viewer')!.can).toEqual(['See the call list', 'See the schedule', 'See requests']);
  });

  it('every permission a route asks for is in the table, and every one in the table is used by a route', () => {
    const src = join(__dirname, '../src');
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) walk(join(dir, f.name));
        else if (f.name.endsWith('.ts')) for (const m of readFileSync(join(dir, f.name), 'utf8').matchAll(/@Requires\('([a-z:]+)'\)|can\([^,]+, '([a-z:]+)'\)/g)) used.add(m[1] ?? m[2]!);
      }
    };
    walk(src);
    for (const p of used) expect(Object.keys(PERMISSIONS), p).toContain(p);
    for (const p of Object.keys(PERMISSIONS)) expect(used, p).toContain(p);
  });

  it('/me serves the same roles, and each clinic\'s permissions follow the role', async () => {
    for (const role of ['owner', 'admin', 'staff', 'viewer'] as const) {
      const me = (await api.request('GET', '/api/v1/me', { cookie: as[role] })).json();
      expect(me.roles).toEqual(ROLES);
      const here = me.clinics.find((c: { id: string }) => c.id === DEMO_CLINIC.id);
      expect(here.role).toBe(role);
      expect(here.permissions).toEqual((Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p)));
      expect(here.accountWide).toBe(role === 'owner');
    }
  });
});

describe('each role walks the page behind every menu item', () => {
  // the read route each page opens with, and the permission it needs
  const PAGES: [string, Permission, string][] = [
    ['Today', 'calls:list', `${C}/overview`],
    ['Calls', 'calls:list', `${C}/calls`],
    ['Schedule', 'schedule:list', `${C}/appointments?from=2026-11-02&days=7`],
    ['Requests', 'tasks:list', `${C}/tasks`],
    ['Pets', 'patients:read', `${C}/patients`],
    ['Doctors', 'settings:read', `${C}/doctors`],
    ['Settings (any page draws from it)', 'clinic:read', `${C}/settings`],
    ['Knowledge', 'settings:read', `${C}/knowledge/documents`],
    ['Quality', 'quality:read', `${C}/quality`],
    ['Team', 'members:manage', `${C}/members`],
    ['Audit log', 'audit:read', `${C}/audit`],
    ['Webhooks', 'integrations:manage', `${C}/webhooks`],
  ];
  for (const role of ['owner', 'admin', 'staff', 'viewer'] as const) {
    it(`${role}: allowed exactly where the table says`, async () => {
      for (const [page, permission, url] of PAGES) {
        const res = await api.request('GET', url, { cookie: as[role] });
        expect(res.statusCode, `${role} on ${page}`).toBe(can(role, permission) ? 200 : 403);
      }
      // a transcript and a request's own text are never a viewer's
      expect((await api.request('GET', `${C}/calls/${api.callId}`, { cookie: as[role] })).statusCode).toBe(can(role, 'calls:read') ? 200 : 403);
    });
  }
});

describe('a viewer sees what its description says, and nothing more', () => {
  it('the call list without names', async () => {
    const list = (await api.request('GET', `${C}/calls`, { cookie: as.viewer })).json();
    expect(list.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toMatch(/Maria|Delgado/);
  });

  it('requests: number, kind and state, with no patient, details or notes', async () => {
    const { tasks } = (await api.request('GET', `${C}/tasks`, { cookie: as.viewer })).json();
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t).toMatchObject({ patientName: null, patientId: null, details: {}, notes: [], custom: {}, callId: null });
    expect(JSON.stringify(tasks)).not.toMatch(/lisinopril|5550147|Maria/);
    // searching is by names and numbers: not a viewer's
    expect((await api.request('POST', `${C}/tasks/search`, { cookie: as.viewer, body: { status: 'open', q: 'Maria' } })).statusCode).toBe(403);
  });

  it('the schedule with no patient, and no visit opens', async () => {
    const staff = (await api.request('GET', `${C}/appointments?from=2026-11-02&days=7`, { cookie: as.staff })).json();
    const viewer = (await api.request('GET', `${C}/appointments?from=2026-11-02&days=7`, { cookie: as.viewer })).json();
    expect(viewer.appointments.map((a: { id: string }) => a.id)).toEqual(staff.appointments.map((a: { id: string }) => a.id));
    for (const a of viewer.appointments) expect(a).toMatchObject({ patientName: '', patientId: '' });
    if (staff.appointments[0]) expect((await api.request('GET', `${C}/appointments/${staff.appointments[0].id}`, { cookie: as.viewer })).statusCode).toBe(403);
  });

  it('settings with no private numbers: vets\' phones, transfer numbers, callers put through', async () => {
    const full = (await api.request('GET', `${C}/settings`, { cookie: as.staff })).json();
    const seen = (await api.request('GET', `${C}/settings`, { cookie: as.viewer })).json();
    expect(seen.providers.map((p: { id: string }) => p.id)).toEqual(full.providers.map((p: { id: string }) => p.id));
    for (const p of seen.providers) { expect(p.phone).toBeUndefined(); expect(p.otherPhones).toBeUndefined(); expect(p.custom).toBeUndefined(); }
    expect(seen.routing).toEqual([]);
    expect(seen.vipCallers).toBeUndefined();
  });
});
