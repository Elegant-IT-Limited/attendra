// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The roles, what each may do, and how each is described: one source. The API guard checks
 * PERMISSIONS on every route; /me serves ROLES; the Team page, the invitation page and email,
 * the banner, the menu and the MCP server all read the labels and descriptions from here.
 * A role's list of what it can do is generated from PERMISSIONS, so the words on screen
 * cannot drift from what the guard allows (a test walks every role through every page).
 *
 * Access is per location: an owner is account-wide (every location of the business);
 * the other roles hold at the locations a person was invited to.
 */
export type StaffRoleId = 'owner' | 'admin' | 'staff' | 'viewer';
export const ROLE_IDS = ['owner', 'admin', 'staff', 'viewer'] as const satisfies readonly StaffRoleId[];

// each permission gets its own list (a test may narrow one without touching the others)
const ALL = () => ['owner', 'admin', 'staff', 'viewer'] as const;
const DESK = () => ['owner', 'admin', 'staff'] as const;
const MANAGERS = () => ['owner', 'admin'] as const;

export const PERMISSIONS = {
  // the call list: times, outcomes and flags; names only for roles that may read calls
  'calls:list': ALL(),
  'calls:read': DESK(),
  'calls:test': DESK(),
  // on a live call: send the assistant a note, take the call, or end it
  'calls:coach': DESK(),
  'patients:read': DESK(),
  'patients:write': DESK(),
  // a whole list of patients from a spreadsheet: managers only
  'patients:import': MANAGERS(),
  // the schedule grid: visits by vet and time; names only for roles with schedule:read
  'schedule:list': ALL(),
  'schedule:read': DESK(),
  'schedule:write': DESK(),
  // book outside the hours, on a holiday or when a provider is away, with a reason
  'schedule:override': DESK(),
  // the request queue: type, number, age and who has it; names, numbers and details only with tasks:read
  'tasks:list': ALL(),
  'tasks:read': DESK(),
  'tasks:work': DESK(),
  'tasks:reassign': MANAGERS(),
  // what any page needs to draw itself: hours, vets' names, visit types; private numbers only with settings:read
  'clinic:read': ALL(),
  'settings:read': DESK(),
  'settings:write': MANAGERS(),
  'audit:read': MANAGERS(),
  // how the assistant is doing: containment, bookings, refusals, cost
  'quality:read': MANAGERS(),
  'members:manage': MANAGERS(),
  // webhooks: where the clinic's events go, and their secrets
  'integrations:manage': MANAGERS(),
} as const satisfies Record<string, readonly StaffRoleId[]>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Who must sign in with a second step (ATTENDRA_TWO_FACTOR): everyone ('required', the default),
 * nobody ('optional'), or the roles that manage the team, the keys and the webhooks ('managers':
 * owners and practice managers; the others may turn it on). A person with one of these roles at
 * any of their locations must have it on.
 */
export type TwoFactorMode = 'required' | 'optional' | 'managers';
export const TWO_FACTOR_MODES = ['required', 'optional', 'managers'] as const satisfies readonly TwoFactorMode[];
export function twoFactorRoles(mode: TwoFactorMode | undefined): StaffRoleId[] {
  if (mode === 'optional') return [];
  if (mode === 'managers') return [...MANAGERS()];
  return [...ROLE_IDS];
}

export const can = (role: StaffRoleId, permission: Permission) => (PERMISSIONS[permission] as readonly StaffRoleId[]).includes(role);
export const permissionsFor = (role: StaffRoleId) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));

/**
 * What a role can do, in the words the Team page shows, each tied to the permission that
 * grants it. A role's list is every line whose permission it has; `without` is said when a
 * role has the first permission and not the second (the viewer's "no names").
 */
export const CAPABILITIES: { permission: Permission; text: string }[] = [
  { permission: 'calls:list', text: 'See the call list' },
  { permission: 'calls:read', text: 'Read call transcripts, texts and recordings' },
  { permission: 'schedule:list', text: 'See the schedule' },
  { permission: 'schedule:write', text: 'Book, move and cancel visits' },
  { permission: 'tasks:list', text: 'See requests' },
  { permission: 'tasks:work', text: 'Work requests: claim, call back, close' },
  { permission: 'patients:read', text: 'Find and edit pets and owners' },
  { permission: 'calls:test', text: 'Make test calls from the browser' },
  { permission: 'settings:read', text: 'See the assistant\'s settings and vets' },
  { permission: 'settings:write', text: 'Change settings' },
  { permission: 'tasks:reassign', text: 'Hand requests to someone else' },
  { permission: 'quality:read', text: 'See Quality' },
  { permission: 'members:manage', text: 'Invite and manage the team' },
  { permission: 'audit:read', text: 'Read the audit log' },
  { permission: 'integrations:manage', text: 'Manage API keys and webhooks' },
];

export interface RoleDescription {
  id: StaffRoleId;
  label: string;
  /** One line, for the role picker and the invitation. */
  summary: string;
  /** Generated from PERMISSIONS: what this role can do. */
  can: string[];
  /** What it cannot see, said plainly. */
  limits: string[];
}

const ROLE_TEXT: Record<StaffRoleId, { label: string; summary: string; limits: string[] }> = {
  owner: { label: 'Owner', summary: 'Everything, at every location of the business: billing, locations, the team and other owners.', limits: [] },
  admin: { label: 'Practice manager', summary: 'Runs this location: settings, the team (except owners), the audit log and handing out requests.', limits: ['Not billing or other owners'] },
  staff: { label: 'Front desk', summary: 'Works the front desk at this location: calls, the schedule, pets and owners, and requests.', limits: ['Not settings changes or the team'] },
  viewer: { label: 'Viewer', summary: 'The call list, the schedule and requests at this location, read-only, with no client names or numbers.', limits: ['No client names, phone numbers or request details', 'Nothing can be changed'] },
};

export const ROLES: RoleDescription[] = ROLE_IDS.map((id) => ({
  id, ...ROLE_TEXT[id], can: CAPABILITIES.filter((c) => can(id, c.permission)).map((c) => c.text),
}));

export const ROLE_LABEL: Record<StaffRoleId, string> = Object.fromEntries(ROLES.map((r) => [r.id, r.label])) as Record<StaffRoleId, string>;
export const roleLabel = (role: string) => ROLE_LABEL[role as StaffRoleId] ?? role;

/**
 * The clinic's settings as a viewer gets them: what any page needs to draw itself (hours,
 * vets' names, visit types, languages), without the numbers that are the team's own: vets'
 * private phones and their own details, where transfers go, and the callers put straight
 * through. One function, so every route that hands settings to a viewer strips the same.
 */
export function viewerConfig<T extends { providers: { phone?: string; otherPhones?: string[]; custom?: Record<string, string> }[]; routing?: unknown[]; vipCallers?: unknown[] }>(c: T): T {
  return {
    ...c,
    providers: c.providers.map(({ phone: _phone, otherPhones: _other, custom: _custom, ...p }) => p),
    routing: [],
    vipCallers: undefined,
  };
}
