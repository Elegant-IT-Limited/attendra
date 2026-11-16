// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an API key may do. One list, for the key store, the MCP tools, the API's key routes and the dashboard's contract.
 * qa:read is the daily QA export over HTTPS (GET /api/v1/clinics/:clinicId/qa/export, docs/qa-export.md), not an MCP tool.
 */
export const API_SCOPES = ['schedule:read', 'requests:read', 'requests:write', 'quality:read', 'qa:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
