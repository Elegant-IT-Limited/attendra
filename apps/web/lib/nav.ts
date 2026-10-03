// SPDX-License-Identifier: AGPL-3.0-only
import { CalendarDays, Gauge, House, ListChecks, type LucideIcon, Mic, Phone, Settings, ShieldCheck, Stethoscope, UserCog, Users } from 'lucide-react';

export interface NavItem { href: string; label: string; icon: LucideIcon; permission: string; shortcut?: string }

// The menu in the groups a front desk thinks in. A group with nothing the role may open is not shown.
export const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ href: '', label: 'Today', icon: House, permission: 'calls:list', shortcut: 't' }] },
  {
    group: 'Front desk',
    items: [
      { href: 'schedule', label: 'Schedule', icon: CalendarDays, permission: 'schedule:read', shortcut: 's' },
      { href: 'patients', label: 'Patients', icon: Users, permission: 'patients:read', shortcut: 'p' },
      { href: 'doctors', label: 'Doctors', icon: Stethoscope, permission: 'settings:read', shortcut: 'd' },
      { href: 'requests', label: 'Requests', icon: ListChecks, permission: 'tasks:read', shortcut: 'r' },
      { href: 'calls', label: 'Calls', icon: Phone, permission: 'calls:list', shortcut: 'c' },
    ],
  },
  {
    group: 'Assistant',
    items: [
      { href: 'test-call', label: 'Test call', icon: Mic, permission: 'calls:test' },
      { href: 'quality', label: 'Quality', icon: Gauge, permission: 'quality:read' },
      { href: 'settings', label: 'Settings', icon: Settings, permission: 'settings:read' },
    ],
  },
  {
    group: 'Admin',
    items: [
      { href: 'team', label: 'Team', icon: UserCog, permission: 'members:manage' },
      { href: 'audit', label: 'Audit log', icon: ShieldCheck, permission: 'audit:read' },
    ],
  },
];

/** The three pages a phone keeps in its bottom bar, beside More, where the rest live. */
export const PHONE_BAR = ['', 'schedule', 'requests'];
