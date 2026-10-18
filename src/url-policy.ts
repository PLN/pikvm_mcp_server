// Modified 2026-10 by PLN: URL allowlist and SSRF address policy (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: metadata embeddings, Tailscale services, reserved ranges (GPL-3.0; see NOTICE).

/**
 * https allowlist and address checks for pikvm_msd_fetch_url.
 * kvmd downloads the URL itself, so this only rejects names the MCP
 * host can see. Link-local, metadata, and Tailscale service addresses
 * are never allowed. An IPv4 address embedded in ::/96, 64:ff9b::/96,
 * 64:ff9b:1::/48, or 2002::/16 is extracted and checked with the IPv4
 * rules. Tailscale ranges need an explicit CIDR in the allowlist.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const TAILSCALE_V4 = '100.64.0.0';
const TAILSCALE_V4_PREFIX = 10;
const TAILSCALE_V6 = 'fd7a:115c:a1e0::';
const TAILSCALE_V6_PREFIX = 48;
const NAT64 = 0x0064ff9b0000000000000000n;
const NAT64_LOCAL = 0x0064ff9b0001n;

const alwaysDeny = new BlockList();
alwaysDeny.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysDeny.addSubnet('fe80::', 10, 'ipv6');
alwaysDeny.addAddress('fd00:ec2::254', 'ipv6');
alwaysDeny.addAddress('100.100.100.100', 'ipv4');
alwaysDeny.addAddress('100.100.100.200', 'ipv4');
alwaysDeny.addAddress('fd7a:115c:a1e0::53', 'ipv6');

const tailscaleOuter = new BlockList();
tailscaleOuter.addSubnet(TAILSCALE_V4, TAILSCALE_V4_PREFIX, 'ipv4');
tailscaleOuter.addSubnet(TAILSCALE_V6, TAILSCALE_V6_PREFIX, 'ipv6');

const privateRanges = new BlockList();
privateRanges.addSubnet('0.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addSubnet('224.0.0.0', 4, 'ipv4');
privateRanges.addAddress('255.255.255.255', 'ipv4');
privateRanges.addAddress('::', 'ipv6');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
privateRanges.addSubnet('ff00::', 8, 'ipv6');

/** Denied even when PIKVM_MSD_URL_ALLOW_PRIVATE=1. Not Tailscale. */
const reservedRanges = new BlockList();
reservedRanges.addSubnet('192.0.0.0', 24, 'ipv4');
reservedRanges.addSubnet('192.0.2.0', 24, 'ipv4');
reservedRanges.addSubnet('198.18.0.0', 15, 'ipv4');
reservedRanges.addSubnet('198.51.100.0', 24, 'ipv4');
reservedRanges.addSubnet('203.0.113.0', 24, 'ipv4');
reservedRanges.addSubnet('240.0.0.0', 4, 'ipv4');
reservedRanges.addSubnet('fec0::', 10, 'ipv6');
reservedRanges.addSubnet('2001:db8::', 32, 'ipv6');

export interface UrlAllowEntry {
  /** URL.hostname, brackets included for IPv6. */
  host: string;
  port: number;
  /** Path prefix. `/` matches every path on the host. */
  pathPrefix: string;
}

export interface UrlAllowlist {
  entries: UrlAllowEntry[];
  /** CIDRs inside 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
  tailscale: BlockList;
}

/**
 * Drop URL userinfo, cutting at the last `@` before the path, and drop
 * the query string and fragment. kvmd still logs the full URL.
 */
export function redactUrlUserinfo(text: string): string {
  return text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)([^\s]*)/gi,
    (_match, scheme: string, authority: string, rest: string) => {
      const at = authority.lastIndexOf('@');
      const host = at === -1 ? authority : authority.slice(at + 1);
      const path = rest.split(/[?#]/, 1)[0];
      return `${scheme}${host}${path}`;
    },
  );
}

export class MsdUrlPolicyError extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(redactUrlUserinfo(message));
    this.name = type;
    this.type = type;
  }
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/** Drop a trailing DNS dot. IPv6 hostnames keep their brackets. */
function normalizeHost(hostname: string): string {
  if (hostname.startsWith('[')) return hostname;
  let host = hostname;
  while (host.endsWith('.') && host.length > 1) host = host.slice(0, -1);
  return host;
}

function familyOf(address: string): 'ipv4' | 'ipv6' {
  const kind = isIP(address);
  if (kind === 4) return 'ipv4';
  if (kind === 6) return 'ipv6';
  throw new MsdUrlPolicyError('MsdUrlAddressError', 'resolved address is not an IP address');
}

function ipv4ToBig(address: string): bigint {
  const parts = address.split('.');
  if (parts.length !== 4) throw new Error('bad ipv4');
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) throw new Error('bad ipv4');
    const octet = Number(part);
    if (octet > 255) throw new Error('bad ipv4');
    value = (value << 8n) + BigInt(octet);
  }
  return value;
}

function bigToIpv4(value: bigint): string {
  return [24, 16, 8, 0].map((shift) => String((value >> BigInt(shift)) & 255n)).join('.');
}

function ipv6ToBig(address: string): bigint {
  let text = address.toLowerCase();
  if (text.includes('%')) throw new Error('bad ipv6');
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = ipv4ToBig(dotted[2]);
    text = `${dotted[1]}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) throw new Error('bad ipv6');
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (halves.length === 1 && head.length !== 8) throw new Error('bad ipv6');
  const missing = 8 - head.length - tail.length;
  if (missing < 0) throw new Error('bad ipv6');
  const groups = halves.length === 2
    ? [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
    : head;
  if (groups.length !== 8) throw new Error('bad ipv6');
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error('bad ipv6');
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function bigToIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i -= 1) {
    groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  return groups.join(':');
}

function cidrEnds(address: string, prefix: number, family: 'ipv4' | 'ipv6'): [string, string] {
  const bits = family === 'ipv4' ? 32 : 128;
  const value = family === 'ipv4' ? ipv4ToBig(address) : ipv6ToBig(address);
  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  const end = start + (1n << hostBits) - 1n;
  if (family === 'ipv4') return [bigToIpv4(start), bigToIpv4(end)];
  return [bigToIpv6(start), bigToIpv6(end)];
}

type EmbeddedIpv4 = { kind: 'ipv4'; address: string } | { kind: 'invalid' };

/**
 * IPv4 carried in ::/96, 64:ff9b::/96, 64:ff9b:1::/48 (RFC 6052), or
 * 2002::/16. The caller runs the IPv4 policy on the extracted address.
 * A local NAT64 address whose u byte is not zero is invalid.
 */
function embeddedIpv4(bare: string): EmbeddedIpv4 | undefined {
  if (isIP(bare) !== 6) return undefined;
  let value: bigint;
  try {
    value = ipv6ToBig(bare);
  } catch {
    return undefined;
  }
  const high96 = value >> 32n;
  if (high96 === 0n || high96 === NAT64) {
    return { kind: 'ipv4', address: bigToIpv4(value & 0xffffffffn) };
  }
  if ((value >> 112n) === 0x2002n) {
    return { kind: 'ipv4', address: bigToIpv4((value >> 80n) & 0xffffffffn) };
  }
  if ((value >> 80n) === NAT64_LOCAL) {
    const high = (value >> 64n) & 0xffffn;
    const marker = (value >> 56n) & 0xffn;
    const low = (value >> 40n) & 0xffffn;
    if (marker !== 0n) return { kind: 'invalid' };
    return { kind: 'ipv4', address: bigToIpv4((high << 16n) | low) };
  }
  return undefined;
}

const CIDR_ERROR = 'PIKVM_MSD_URL_ALLOWLIST tailscale opt-in must be a CIDR inside 100.64.0.0/10 or fd7a:115c:a1e0::/48';

function addTailscaleCidr(list: BlockList, token: string): void {
  const slash = token.lastIndexOf('/');
  const address = token.slice(0, slash).trim();
  const prefixText = token.slice(slash + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) throw new Error(CIDR_ERROR);
  const prefix = Number(prefixText);
  const kind = isIP(address);
  if (kind === 0 || !Number.isInteger(prefix)) throw new Error(CIDR_ERROR);
  const family = kind === 4 ? 'ipv4' : 'ipv6';
  const bits = family === 'ipv4' ? 32 : 128;
  const outerPrefix = family === 'ipv4' ? TAILSCALE_V4_PREFIX : TAILSCALE_V6_PREFIX;
  if (prefix < outerPrefix || prefix > bits) throw new Error(CIDR_ERROR);
  let start: string;
  let end: string;
  try {
    const value = family === 'ipv4' ? ipv4ToBig(address) : ipv6ToBig(address);
    const hostBits = BigInt(bits - prefix);
    if (((value >> hostBits) << hostBits) !== value) throw new Error('host bits');
    [start, end] = cidrEnds(address, prefix, family);
  } catch {
    throw new Error(CIDR_ERROR);
  }
  if (!tailscaleOuter.check(start, family) || !tailscaleOuter.check(end, family)) {
    throw new Error(CIDR_ERROR);
  }
  list.addSubnet(address, prefix, family);
}

/** True for a literal that stays denied with private and Tailscale opted in. */
function isAlwaysDeniedAddress(address: string): boolean {
  const bare = stripBrackets(address.trim());
  const kind = isIP(bare);
  if (kind !== 4 && kind !== 6) return false;
  const family = kind === 4 ? 'ipv4' : 'ipv6';
  if (alwaysDeny.check(bare, family) || reservedRanges.check(bare, family)) return true;
  const embedded = embeddedIpv4(bare);
  if (!embedded) return false;
  if (embedded.kind === 'invalid') return true;
  return isAlwaysDeniedAddress(embedded.address);
}

function parseHttpsEntry(item: string): UrlAllowEntry {
  let url: URL;
  try {
    url = new URL(item);
  } catch {
    throw new Error('PIKVM_MSD_URL_ALLOWLIST entry must be https://host[:port]/path-prefix or a tailscale CIDR');
  }
  if (url.protocol !== 'https:') {
    throw new Error('PIKVM_MSD_URL_ALLOWLIST entry must use https');
  }
  if (url.username || url.password) {
    throw new Error('PIKVM_MSD_URL_ALLOWLIST entry must not contain userinfo');
  }
  if (url.search || url.hash) {
    throw new Error('PIKVM_MSD_URL_ALLOWLIST entry must not contain a query or hash');
  }
  const host = normalizeHost(url.hostname);
  const bare = stripBrackets(host);
  if (isIP(bare) && isAlwaysDeniedAddress(bare)) {
    throw new Error('PIKVM_MSD_URL_ALLOWLIST host is always denied');
  }
  const port = url.port === '' ? 443 : Number(url.port);
  let pathPrefix = url.pathname;
  if (pathPrefix.length > 1 && pathPrefix.endsWith('/')) pathPrefix = pathPrefix.slice(0, -1);
  if (pathPrefix === '') pathPrefix = '/';
  return { host, port, pathPrefix };
}

/** Comma-separated https prefixes and Tailscale CIDR opt-ins. Empty hides the tool. */
export function parseUrlAllowlist(raw: string | undefined): UrlAllowlist {
  const entries: UrlAllowEntry[] = [];
  const tailscale = new BlockList();
  if (raw === undefined || raw.trim() === '') return { entries, tailscale };
  for (const token of raw.split(',')) {
    const item = token.trim();
    if (item === '') continue;
    if (item.includes('://')) entries.push(parseHttpsEntry(item));
    else if (item.includes('/')) addTailscaleCidr(tailscale, item);
    else {
      throw new Error('PIKVM_MSD_URL_ALLOWLIST entry must be https://host[:port]/path-prefix or a tailscale CIDR');
    }
  }
  return { entries, tailscale };
}

export function matchAllowEntry(allow: UrlAllowlist, url: URL): boolean {
  const port = url.port === '' ? 443 : Number(url.port);
  const path = url.pathname;
  const host = normalizeHost(url.hostname);
  return allow.entries.some((entry) => {
    if (entry.host !== host || entry.port !== port) return false;
    if (entry.pathPrefix === '/') return true;
    return path === entry.pathPrefix || path.startsWith(`${entry.pathPrefix}/`);
  });
}

export interface InspectedUrl {
  /** URL sent to kvmd, with the fragment removed. Userinfo is already rejected. */
  href: string;
  /** Host without brackets or a trailing dot, for DNS or a literal address check. */
  hostname: string;
  imageFromPath: string;
}

export function inspectFetchUrl(raw: string, allow: UrlAllowlist): InspectedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MsdUrlPolicyError('MsdUrlSyntaxError', 'url is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new MsdUrlPolicyError('MsdUrlSchemeError', 'url must be https');
  if (url.username || url.password) {
    throw new MsdUrlPolicyError('MsdUrlUserinfoError', 'url must not contain userinfo');
  }
  if (!matchAllowEntry(allow, url)) {
    throw new MsdUrlPolicyError('MsdUrlAllowlistError', 'url is not allowlisted');
  }
  url.hash = '';
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  let imageFromPath = '';
  try {
    imageFromPath = decodeURIComponent(last);
  } catch {
    imageFromPath = '';
  }
  return {
    href: url.href,
    hostname: stripBrackets(normalizeHost(url.hostname)),
    imageFromPath,
  };
}

/**
 * Empty string when the address may be used. Otherwise a denial message.
 * Always-deny is checked before Tailscale and private ranges.
 * Embedded IPv4 uses the same IPv4 policy, including that order.
 */
export function addressDenial(address: string, allow: UrlAllowlist, allowPrivate: boolean): string | undefined {
  const bare = stripBrackets(address.trim());
  const family = familyOf(bare);
  if (alwaysDeny.check(bare, family)) {
    return `resolved address ${bare} is link-local or metadata and is always denied`;
  }
  const embedded = embeddedIpv4(bare);
  if (embedded?.kind === 'invalid') {
    return `resolved address ${bare} is an invalid IPv4 embedding and is always denied`;
  }
  if (embedded?.kind === 'ipv4') {
    const inner = addressDenial(embedded.address, allow, allowPrivate);
    if (inner) return `resolved address ${bare} is denied: ${inner}`;
    return undefined;
  }
  if (tailscaleOuter.check(bare, family)) {
    if (!allow.tailscale.check(bare, family)) {
      return `resolved address ${bare} is a tailscale address without an allowlist opt-in`;
    }
    return undefined;
  }
  if (privateRanges.check(bare, family)) {
    if (!allowPrivate) return `resolved address ${bare} is a private address`;
    return undefined;
  }
  if (reservedRanges.check(bare, family)) {
    return `resolved address ${bare} is a reserved or documentation address`;
  }
  return undefined;
}

export function assertResolvedAddresses(
  addresses: readonly string[],
  allow: UrlAllowlist,
  allowPrivate: boolean,
): void {
  if (addresses.length === 0) {
    throw new MsdUrlPolicyError('MsdUrlResolveError', 'url host did not resolve');
  }
  for (const address of addresses) {
    const denial = addressDenial(address, allow, allowPrivate);
    if (denial) throw new MsdUrlPolicyError('MsdUrlAddressError', denial);
  }
}

export async function defaultResolveUrl(hostname: string): Promise<string[]> {
  const bare = stripBrackets(hostname);
  if (isIP(bare)) return [bare];
  const rows = await lookup(bare, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

export async function resolveFetchHost(
  hostname: string,
  resolveUrl?: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  const bare = stripBrackets(hostname);
  if (isIP(bare)) return [bare];
  const resolve = resolveUrl ?? defaultResolveUrl;
  try {
    const found = await resolve(bare);
    return found.map((item) => stripBrackets(String(item).trim())).filter((item) => item.length > 0);
  } catch (err) {
    if (err instanceof MsdUrlPolicyError) throw err;
    throw new MsdUrlPolicyError('MsdUrlResolveError', 'url host did not resolve');
  }
}
