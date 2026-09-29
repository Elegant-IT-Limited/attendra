// SPDX-License-Identifier: AGPL-3.0-only
import type { StaffRole } from '@attendra/db';

/**
 * What each role may do in the dashboard. One table, checked by the API guard on
 * every route; the web app reads the same table only to hide buttons.
 *
 * viewer  reads the call list and the settings, never a transcript, a task, a patient or the schedule
 * staff   works the front desk: transcripts, the task queue, patients, the schedule, test calls from the browser
 * admin   also edits clinic settings, reassigns requests and manages members, except owners
 * owner   everything, including other owners
 */
export const PERMISSIONS = {
  'calls:list': ['owner', 'admin', 'staff', 'viewer'],
  'calls:read': ['owner', 'admin', 'staff'],
  'calls:test': ['owner', 'admin', 'staff'],
  'patients:read': ['owner', 'admin', 'staff'],
  'patients:write': ['owner', 'admin', 'staff'],
  'schedule:read': ['owner', 'admin', 'staff'],
  'schedule:write': ['owner', 'admin', 'staff'],
  'tasks:read': ['owner', 'admin', 'staff'],
  'tasks:work': ['owner', 'admin', 'staff'],
  'tasks:reassign': ['owner', 'admin'],
  'settings:read': ['owner', 'admin', 'staff', 'viewer'],
  'settings:write': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
  'members:manage': ['owner', 'admin'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: StaffRole, permission: Permission) => (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);

export const permissionsFor = (role: StaffRole) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
