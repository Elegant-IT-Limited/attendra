// SPDX-License-Identifier: AGPL-3.0-only
import type { StaffRole } from '@attendra/db';

/**
 * What each role may do in the dashboard. One table, checked by the API guard on
 * every route; the web app reads the same table only to hide buttons.
 *
 * viewer  reads the call list and the audit trail, never a transcript or a task
 * staff   works the front desk: transcripts, the task queue, test calls from the browser
 * admin   also edits clinic settings
 * owner   everything, including members (members are managed from the CLI in v0.2)
 */
export const PERMISSIONS = {
  'calls:list': ['owner', 'admin', 'staff', 'viewer'],
  'calls:read': ['owner', 'admin', 'staff'],
  'calls:test': ['owner', 'admin', 'staff'],
  'tasks:read': ['owner', 'admin', 'staff'],
  'tasks:work': ['owner', 'admin', 'staff'],
  'tasks:reassign': ['owner', 'admin'],
  'settings:read': ['owner', 'admin', 'staff', 'viewer'],
  'settings:write': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: StaffRole, permission: Permission) => (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);

export const permissionsFor = (role: StaffRole) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
