// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What each role may do: the one table lives in @attendra/core (roles.ts), with the role
 * names and descriptions generated from it. The API guard checks it on every route; the
 * web app reads the same table, through /me, only to hide buttons.
 */
export { can, type Permission, PERMISSIONS, permissionsFor, ROLE_LABEL, ROLES } from '@attendra/core';
