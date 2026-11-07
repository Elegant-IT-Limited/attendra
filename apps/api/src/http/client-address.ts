// SPDX-License-Identifier: AGPL-3.0-only
import { BlockList, isIP } from 'node:net';
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from './cloudflare-ips';

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_IPV4) { const [net, bits] = range.split('/') as [string, string]; cloudflare.addSubnet(net, Number(bits), 'ipv4'); }
for (const range of CLOUDFLARE_IPV6) { const [net, bits] = range.split('/') as [string, string]; cloudflare.addSubnet(net, Number(bits), 'ipv6'); }

/** "::ffff:203.0.113.9", as a dual-stack socket reports an IPv4 client, is 203.0.113.9. */
const plain = (address: string) => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address) ? address.slice(7) : address);

/** True when the address is one Cloudflare's proxies connect from (cloudflare-ips.ts). */
export function isCloudflare(address: string): boolean {
  const a = plain(address);
  const family = isIP(a);
  return family === 4 ? cloudflare.check(a, 'ipv4') : family === 6 ? cloudflare.check(a, 'ipv6') : false;
}

/**
 * The client's address. `req.ip` is what Fastify found after the trusted hops (TRUST_PROXY):
 * the address that connected to our edge proxy. With `trustCloudflare`, and only when that
 * address is Cloudflare's, the client is the one Cloudflare names in CF-Connecting-IP. From
 * anywhere else the header is ignored: a client that reaches the server directly cannot
 * choose its own address, and so cannot buy itself a fresh rate limit.
 */
export function clientAddress(req: { ip: string; headers: Record<string, string | string[] | undefined> }, trustCloudflare: boolean): string {
  if (!trustCloudflare || !isCloudflare(req.ip)) return req.ip;
  const named = req.headers['cf-connecting-ip'];
  const value = typeof named === 'string' ? named.trim() : '';
  return isIP(value) ? plain(value) : req.ip;
}
