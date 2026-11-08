import { isIP } from 'node:net';

import { classifyHost } from '../../../src/utils/host-classify.js';
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
  dnsCache.clear(); // a stale answer for the same host would hide the new resolver
}

export function resetDnsPolicyCacheForTests() {
  dnsCache.clear();
  dnsResolverOverride = null;
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateOrReservedIpAddress(address = '') {
  const normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized) === 0) return true;
  return classifyHost(normalized).kind !== 'public';
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
