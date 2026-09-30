// SPDX-License-Identifier: AGPL-3.0-only

/** What an API key may do. One list, for the key store, the MCP tools and the dashboard's contract. */
export const API_SCOPES = ['schedule:read', 'requests:read', 'requests:write', 'quality:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
