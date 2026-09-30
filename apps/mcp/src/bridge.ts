// SPDX-License-Identifier: AGPL-3.0-only
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface Remote extends Transport { setProtocolVersion?(version: string): void }

const idOf = (m: JSONRPCMessage) => ('id' in m && 'method' in m ? m.id : undefined);

/**
 * Relays every message between a local MCP client (a desktop MCP client on stdio)
 * and the clinic's HTTP /mcp server, unchanged. The bridge holds only the server's
 * address and the API key: no database, no data key, no decision of its own. The
 * server checks the key on every request, so a revoked key fails on the next call,
 * and the failure goes back to the client as that request's error.
 */
export async function bridge(local: Transport, remote: Remote, onError: (err: Error) => void = () => {}): Promise<void> {
  const initialising = new Set<string | number>();
  local.onmessage = (m) => {
    const id = idOf(m);
    if (id !== undefined && 'method' in m && m.method === 'initialize') initialising.add(id);
    remote.send(m).catch((err: Error) => {
      onError(err);
      if (id !== undefined) void local.send({ jsonrpc: '2.0', id, error: { code: -32001, message: refusal(err) } });
    });
  };
  remote.onmessage = (m) => {
    // tell the HTTP transport the version agreed, so later requests carry it
    if ('id' in m && 'result' in m && initialising.delete(m.id) && typeof m.result.protocolVersion === 'string') remote.setProtocolVersion?.(m.result.protocolVersion);
    void local.send(m).catch(onError);
  };
  remote.onerror = onError;
  local.onerror = onError;
  // either side closing closes the other, once: each close fires the other's onclose
  let closed = false;
  const closeBoth = () => { if (closed) return; closed = true; void remote.close(); void local.close(); };
  local.onclose = closeBoth;
  remote.onclose = closeBoth;
  await remote.start();
  await local.start();
}

function refusal(err: Error): string {
  const code = (err as { code?: number }).code;
  if (code === 401) return 'The Attendra API key is missing, revoked or expired. Ask the clinic\'s owner or practice manager for a new one.';
  if (code === 429) return 'Too many requests to Attendra. Wait a minute and try again.';
  return 'Attendra did not answer. Check ATTENDRA_MCP_URL, and that the server is running.';
}
