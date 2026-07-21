import { isIP } from 'node:net';

import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';

/** @type {Map<string, string[]>} */
const dnsCache = new Map();

/** @type {((hostname: string) => Promise<string[]>) | null} */
let dnsResolverOverride = null;

/**
 * @param {((hostname: string) => Promise<string[]>) | null} resolver
 */
export function setDnsResolverForTests(resolver) {
  dnsResolverOverride = resolver;
}

export function resetDnsPolicyCacheForTests() {
  dnsCache.clear();
  dnsResolverOverride = null;
}

/**
 * @param {string} normalizedIpv6
 * @returns {string | null}
 */
export function extractIpv4FromMappedIpv6(normalizedIpv6 = '') {
  const lower = String(normalizedIpv6).toLowerCase();

  const dotted = lower.match(/(?:^|:)ffff:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    return dotted[1];
  }

  const hex = lower.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

/**
 * @param {string} normalizedIpv4
 * @returns {boolean}
 */
function isPrivateOrReservedIpv4(normalizedIpv4 = '') {
  const parts = normalizedIpv4.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateOrReservedIpAddress(address = '') {
  const normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(normalized);
  if (version === 0) {
    return true;
  }

  if (version === 6) {
    const embeddedIpv4 = extractIpv4FromMappedIpv6(normalized);
    if (embeddedIpv4 !== null) {
      // Reuse IPv4 private/reserved classification on the embedded address.
      // Policy: deny all IPv4-mapped forms, including public embeddings.
      return isPrivateOrReservedIpv4(embeddedIpv4) || true;
    }

    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('ff')) return true;
    if (normalized.startsWith('2001:db8:')) return true;
    return false;
  }

  return isPrivateOrReservedIpv4(normalized);
}

/**
 * @param {string} hostname
 */
async function defaultDnsResolver(hostname) {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * @param {string} hostname
 * @param {{ resolver?: (hostname: string) => Promise<string[]> }=} options
 * @returns {Promise<string[]>}
 */
export async function resolvePublicHostAddresses(hostname, options = {}) {
  const normalizedHost = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!normalizedHost || isIP(normalizedHost) !== 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'Hostname DNS resolution requires a non-literal host',
    );
  }

  if (dnsCache.has(normalizedHost)) {
    return dnsCache.get(normalizedHost);
  }

  const resolver = options.resolver || dnsResolverOverride || defaultDnsResolver;
  let addresses = [];
  try {
    addresses = await resolver(normalizedHost);
  } catch {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'Hostname DNS resolution failed',
      { hostname: normalizedHost },
    );
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'Hostname DNS resolution returned no addresses',
      { hostname: normalizedHost },
    );
  }

  for (const address of addresses) {
    if (isPrivateOrReservedIpAddress(address)) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
        'Hostname DNS resolution returned a private or reserved address',
        { hostname: normalizedHost },
      );
    }
  }

  dnsCache.set(normalizedHost, addresses);
  return addresses;
}
