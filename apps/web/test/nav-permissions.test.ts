import { PERMISSIONS, ROLES, can } from '@attendra/core';
import { describe, expect, it } from 'vitest';
import { NAV } from '../lib/nav';

describe('the menu follows the permission table', () => {
  it('every menu item asks for a permission that exists', () => {
    for (const item of NAV.flatMap((g) => g.items)) expect(Object.keys(PERMISSIONS), item.label).toContain(item.permission);
  });

  it('each role sees exactly the pages its description promises', () => {
    const pages = (role: (typeof ROLES)[number]['id']) => NAV.flatMap((g) => g.items).filter((i) => can(role, i.permission as keyof typeof PERMISSIONS)).map((i) => i.label);
    // Viewer (approved 2026-11-06): the call list, the schedule and requests, read-only, with no names
    expect(pages('viewer')).toEqual(['Today', 'Schedule', 'Requests', 'Calls']);
    expect(pages('staff')).toEqual(['Today', 'Schedule', 'Patients', 'Doctors', 'Requests', 'Calls', 'Test call', 'Settings']);
    expect(pages('admin')).toEqual([...pages('staff').slice(0, 7), 'Quality', 'Settings', 'Team', 'Audit log']);
    expect(pages('owner')).toEqual(pages('admin'));
  });
});
