// SPDX-License-Identifier: AGPL-3.0-only
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Where a webhook may go: a public HTTPS address, never this machine, a private
 * network, or a cloud metadata service. Checked when the endpoint is saved and again
 * at every delivery, after DNS resolution, and the delivery then connects to the
 * address that was checked, so a name that changes its answer in between (DNS
 * rebinding) cannot reach an internal address.
 */
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  // IPv4 mapped into IPv6 (::ffff:0:0/96, 64:ff9b::/96) is judged as the IPv4 inside it, below:
  // a BlockList rule for those ranges would also match every plain IPv4 address
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

const BLOCKED_NAMES = /^(localhost|metadata\.google\.internal|metadata)$|\.(localhost|local|internal|intranet|lan|home\.arpa)$/i;

export type UrlProblem = 'invalid_url' | 'https_only' | 'credentials_in_url' | 'private_address' | 'unresolvable';

export interface GuardOptions {
  /** Development only (the local demo and the e2e suite): plain HTTP to this machine is allowed. Never set in a deployment. */
  allowLoopback?: boolean;
}

/** An IPv6 address in its one short form, however it was written (0:0:0:0:0:ffff:7f00:1 is ::ffff:7f00:1). */
const canonical6 = (address: string) => new URL(`http://[${address}]`).hostname.slice(1, -1);

/** An IPv4 address hidden in an IPv6 one (::ffff:10.0.0.1, 64:ff9b::a00:1) is judged as that IPv4 address. */
function embeddedIPv4(raw: string): string | null {
  const address = canonical6(raw);
  const dotted = address.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1]!;
  const hex = address.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (!v) return false;
  if (v === 4) return !blocked.check(address, 'ipv4');
  const inner = embeddedIPv4(address);
  if (inner) return !blocked.check(inner, 'ipv4');
  const six = canonical6(address);
  // any other IPv4-compatible or mapped form that slipped past is refused rather than guessed at
  if (/^::(ffff:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(six) || /^64:ff9b::/i.test(six)) return false;
  return !blocked.check(six, 'ipv6');
}

const isLoopback = (address: string) => (isIP(address) === 4 ? address.startsWith('127.') : address === '::1');

/** The checks that need no network: scheme, credentials, and a name or address that is plainly internal. */
export function checkUrlShape(raw: string, opts: GuardOptions = {}): { ok: true; url: URL } | { ok: false; problem: UrlProblem } {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, problem: 'invalid_url' }; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopbackAllowed = opts.allowLoopback && (host === 'localhost' || isLoopback(host));
  if (url.protocol !== 'https:' && !(loopbackAllowed && url.protocol === 'http:')) return { ok: false, problem: 'https_only' };
  if (url.username || url.password) return { ok: false, problem: 'credentials_in_url' };
  if (loopbackAllowed) return { ok: true, url };
  if (BLOCKED_NAMES.test(host)) return { ok: false, problem: 'private_address' };
  if (isIP(host) && !isPublicAddress(host)) return { ok: false, problem: 'private_address' };
  return { ok: true, url };
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Resolves the endpoint's host and returns the address to connect to, or why not.
 * Every address the name resolves to must be public: one private answer is enough to
 * refuse, since a resolver could hand out either.
 */
export async function resolveEndpoint(raw: string, opts: GuardOptions & { resolve?: Resolver } = {}): Promise<{ ok: true; url: URL; address: string; family: 4 | 6 } | { ok: false; problem: UrlProblem }> {
  const shape = checkUrlShape(raw, opts);
  if (!shape.ok) return shape;
  const host = shape.url.hostname.replace(/^\[|\]$/g, '');
  let answers: { address: string; family: number }[];
  if (isIP(host)) answers = [{ address: host, family: isIP(host) }];
  else {
    try { answers = await (opts.resolve ?? systemResolver)(host); } catch { return { ok: false, problem: 'unresolvable' }; }
  }
  if (!answers.length) return { ok: false, problem: 'unresolvable' };
  const allowed = (a: string) => isPublicAddress(a) || (!!opts.allowLoopback && isLoopback(a));
  if (!answers.every((a) => allowed(a.address))) return { ok: false, problem: 'private_address' };
  return { ok: true, url: shape.url, address: answers[0]!.address, family: answers[0]!.family === 6 ? 6 : 4 };
}
