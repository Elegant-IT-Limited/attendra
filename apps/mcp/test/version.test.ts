import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createMcpServer, type McpDeps } from '../src/server';

// a version no release has had: what a client sees must come from the package
vi.mock('../package.json', () => ({ default: { version: '9.8.7' } }));

it('tells a client the version in package.json, not a copy that goes stale at release', async () => {
  const caller = { keyId: 'k', clinicId: 'c', scopes: [], createdByUserId: 'u' };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([createMcpServer(caller, {} as McpDeps).connect(a), client.connect(b)]);
  expect(client.getServerVersion()).toMatchObject({ name: 'attendra', version: '9.8.7' });
  await client.close();
});
