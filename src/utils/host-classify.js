import { BlockList, isIP } from 'node:net';

// Single host classifier. Everything that asks "is this local / private / safe to egress to?" goes through here.

const RANGES = [
  ['loopback', '127.0.0.0', 8, 'ipv4'],
  ['loopback', '0.0.0.0', 32, 'ipv4'],
  ['reserved', '0.0.0.0', 8, 'ipv4'],
  ['private', '10.0.0.0', 8, 'ipv4'],
  ['private', '172.16.0.0', 12, 'ipv4'],
  ['private', '192.168.0.0', 16, 'ipv4'],
  ['private', '100.64.0.0', 10, 'ipv4'], // CGNAT
  ['link-local', '169.254.0.0', 16, 'ipv4'],
  ['reserved', '192.0.0.0', 24, 'ipv4'],
  ['reserved', '192.0.2.0', 24, 'ipv4'], // TEST-NET-1
  ['reserved', '198.51.100.0', 24, 'ipv4'], // TEST-NET-2
  ['reserved', '203.0.113.0', 24, 'ipv4'], // TEST-NET-3
  ['reserved', '198.18.0.0', 15, 'ipv4'],
  ['reserved', '224.0.0.0', 4, 'ipv4'], // multicast
  ['reserved', '240.0.0.0', 4, 'ipv4'], // incl. broadcast
  ['loopback', '::1', 128, 'ipv6'],
  ['reserved', '::', 128, 'ipv6'],
  ['private', 'fc00::', 7, 'ipv6'],
  ['link-local', 'fe80::', 10, 'ipv6'], // fe80-febf
  ['reserved', 'fec0::', 10, 'ipv6'], // deprecated site-local
  ['reserved', 'ff00::', 8, 'ipv6'],
  ['reserved', '2001:db8::', 32, 'ipv6'],
  ['reserved', '100::', 64, 'ipv6'],
];

const LISTS = new Map();
for (const [kind, addr, prefix, family] of RANGES) {
  if (!LISTS.has(kind)) LISTS.set(kind, { list: new BlockList(), kind });
  LISTS.get(kind).list.addSubnet(addr, prefix, family);
}
// loopback must win over the wider reserved 0.0.0.0/8
const ORDER = ['loopback', 'private', 'link-local', 'reserved'];

function classifyIp(ip, family) {
  for (const kind of ORDER) {
    if (LISTS.get(kind).list.check(ip, family)) return kind;
  }
  return 'public';
}

function embeddedIpv4(hostname) {
  // URL normalizes IPv6 to hex groups, so only the hex forms need handling.
  const groups = expandIpv6(hostname);
  const hex = (g) => groups[g];
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (groups.slice(0, 5).every((g) => g === 0) && hex(5) === 0xffff) return v4(hex(6), hex(7)); // ::ffff:0:0/96
  if (hex(0) === 0x64 && hex(1) === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return v4(hex(6), hex(7)); // 64:ff9b::/96
  if (groups.slice(0, 6).every((g) => g === 0) && (hex(6) || hex(7) > 1)) return v4(hex(6), hex(7)); // ::/96 IPv4-compatible
  if (groups.slice(0, 4).every((g) => g === 0) && hex(4) === 0xffff && hex(5) === 0) return v4(hex(6), hex(7)); // ::ffff:0:0:0/96 SIIT
  if (hex(0) === 0x2002) return v4(hex(1), hex(2)); // 6to4
  return null;
}

function expandIpv6(addr) {
  let a = addr;
  const dotted = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    a = a.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/**
 * @param {string} urlOrHost URL, host, or bare IP literal.
 * @returns {{ kind: 'loopback'|'private'|'link-local'|'reserved'|'public'|'invalid', reason: string }}
 */
export function classifyHost(urlOrHost) {
  const invalid = (reason) => ({ kind: 'invalid', reason });
  if (typeof urlOrHost !== 'string' || !urlOrHost.trim()) return invalid('empty input');
  let input = urlOrHost.trim();
  if (isIP(input) === 6) input = `[${input}]`;
  let parsed;
  try {
    parsed = new URL(input.includes('://') ? input : `http://${input}`);
  } catch {
    return invalid('unparseable host');
  }
  // WHATWG URL already resolved userinfo and integer/hex/octal IPv4 into dotted decimal.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!host) return invalid('empty host');

  const family = isIP(host);
  if (family === 4) {
    const kind = classifyIp(host, 'ipv4');
    return { kind, reason: `ipv4 ${host}` };
  }
  if (family === 6) {
    const embedded = embeddedIpv4(host);
    if (embedded) {
      const inner = classifyIp(embedded, 'ipv4');
      // Tunnelled/mapped forms are never treated as public (fail closed).
      return { kind: inner === 'public' ? 'reserved' : inner, reason: `ipv6 ${host} embeds ${embedded}` };
    }
    return { kind: classifyIp(host, 'ipv6'), reason: `ipv6 ${host}` };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return { kind: 'loopback', reason: 'localhost name' };
  if (host.endsWith('.local')) return { kind: 'private', reason: 'mDNS .local name' };
  return { kind: 'public', reason: 'hostname' };
}

export function isLoopbackUrl(urlOrHost) {
  return classifyHost(urlOrHost).kind === 'loopback';
}
