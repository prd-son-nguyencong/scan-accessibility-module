import { isIP } from 'node:net';

import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { resolvePublicHostAddresses } from './dns-policy.js';

export const CASE_ID_PATTERN = /^[a-z0-9-]+$/;

export const REVIEWED_SOURCE_HOST_SUFFIXES = Object.freeze([
  '.preview.sites.stg.paradox.ai',
  '.sites.stg.paradox.ai',
  '.preview.sites.stg.mchire.com',
]);

const ALLOWED_HTTPS_PORT = 443;
const FORBIDDEN_SCHEMES = new Set(['file:', 'data:', 'javascript:', 'ftp:']);

/**
 * @param {string} host
 * @returns {boolean}
 */
function isForbiddenHost(host = '') {
  const normalized = String(host).toLowerCase().replace(/\.$/, '');
  if (!normalized) return true;
  if (normalized === 'localhost') return true;
  if (normalized.endsWith('.localhost')) return true;
  if (normalized.endsWith('.local')) return true;
  if (normalized === 'metadata.google.internal') return true;
  return false;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isSyntacticIpLiteral(host = '') {
  return isIP(String(host).replace(/^\[|\]$/g, '')) !== 0;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function hostMatchesReviewedSuffix(host = '') {
  const normalized = String(host).toLowerCase();
  return REVIEWED_SOURCE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * @param {URL} parsed
 * @param {'navigation' | 'subresource'} urlKind
 */
function assertHttpsPublicUrlShape(parsed, urlKind) {
  if (FORBIDDEN_SCHEMES.has(parsed.protocol)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL scheme is forbidden',
      { urlKind, scheme: parsed.protocol },
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL must use HTTPS',
      { urlKind, scheme: parsed.protocol },
    );
  }

  if (parsed.username || parsed.password) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL must not include credentials',
      { urlKind },
    );
  }

  const host = parsed.hostname;
  if (isForbiddenHost(host) || isSyntacticIpLiteral(host)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL host is forbidden',
      { urlKind },
    );
  }

  if (parsed.port && Number(parsed.port) !== ALLOWED_HTTPS_PORT) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL must use the default HTTPS port',
      { urlKind, port: parsed.port },
    );
  }
}

/**
 * @param {string | URL} rawUrl
 * @param {'navigation' | 'subresource'} urlKind
 * @param {{ resolver?: (hostname: string) => Promise<string[]> }=} options
 */
export async function assertSafeCorpusUrl(rawUrl, urlKind, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL is malformed',
      { urlKind },
    );
  }

  assertHttpsPublicUrlShape(parsed, urlKind);

  if (urlKind === 'navigation' && !hostMatchesReviewedSuffix(parsed.hostname)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'Navigation host is not on the reviewed allowlist',
      { urlKind },
    );
  }

  await resolvePublicHostAddresses(parsed.hostname, options);
}

/**
 * @param {string | URL} rawUrl
 * @param {{ resolver?: (hostname: string) => Promise<string[]> }=} options
 */
export async function assertSafeSourceNavigationUrl(rawUrl, options = {}) {
  await assertSafeCorpusUrl(rawUrl, 'navigation', options);
}

/**
 * @param {string | URL} rawUrl
 * @param {{ resolver?: (hostname: string) => Promise<string[]> }=} options
 */
export async function assertSafeSubresourceUrl(rawUrl, options = {}) {
  await assertSafeCorpusUrl(rawUrl, 'subresource', options);
}

/**
 * Synchronous shape validation for manifest schema checks (no DNS).
 *
 * @param {string | URL} rawUrl
 * @returns {string}
 */
export function validateSourceManifestUrlShape(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'URL is malformed',
      { urlKind: 'navigation' },
    );
  }

  assertHttpsPublicUrlShape(parsed, 'navigation');

  if (!hostMatchesReviewedSuffix(parsed.hostname)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
      'Navigation host is not on the reviewed allowlist',
      { urlKind: 'navigation' },
    );
  }

  return String(rawUrl);
}

/**
 * @param {string} rawUrl
 * @param {{ resolver?: (hostname: string) => Promise<string[]> }=} options
 */
export async function validateSourceManifestUrl(rawUrl, options = {}) {
  await assertSafeSourceNavigationUrl(rawUrl, options);
  return String(rawUrl);
}

/** @deprecated Use assertSafeSubresourceUrl */
export const assertSafeCorpusNetworkUrl = assertSafeSubresourceUrl;

/**
 * @param {string} caseId
 */
export function validateManifestCaseId(caseId) {
  const normalized = String(caseId || '').trim();
  if (!CASE_ID_PATTERN.test(normalized)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      'Manifest caseId must match ^[a-z0-9-]+$',
      { caseId: normalized },
    );
  }
  return normalized;
}

/**
 * @typedef {object} CorpusNetworkGuardOptions
 * @property {(hostname: string) => Promise<string[]>=} resolver
 */

/**
 * @param {import('playwright').Route} route
 * @param {CorpusNetworkGuardOptions=} options
 */
async function handleGuardedRoute(route, options = {}) {
  const request = route.request();
  const resourceType = request.resourceType();
  const urlKind = resourceType === 'document' ? 'navigation' : 'subresource';
  try {
    await assertSafeCorpusUrl(request.url(), urlKind, options);
    await route.continue();
  } catch {
    await route.abort('blockedbyclient');
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {CorpusNetworkGuardOptions=} options
 */
export async function installCorpusNetworkGuard(page, options = {}) {
  await page.route('**/*', async (route) => handleGuardedRoute(route, options));
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {CorpusNetworkGuardOptions=} options
 */
export async function installCorpusContextNetworkGuard(context, options = {}) {
  await context.route('**/*', async (route) => handleGuardedRoute(route, options));
}

/**
 * @param {import('playwright').Page} page
 * @param {string} sourceUrl
 * @param {CorpusNetworkGuardOptions=} options
 */
export async function navigateToReviewedSource(page, sourceUrl, options = {}) {
  await assertSafeSourceNavigationUrl(sourceUrl, options);
  const response = await page.goto(sourceUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  const finalUrl = page.url();
  await assertSafeSourceNavigationUrl(finalUrl, options);
  if (response) {
    const headers = response.headers();
    const location = headers.location || headers.Location;
    if (location) {
      await assertSafeSourceNavigationUrl(new URL(location, finalUrl).toString(), options);
    }
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext | null | undefined} context
 * @param {CorpusNetworkGuardOptions=} options
 */
export async function installCorpusPageAndContextGuards(page, context, options = {}) {
  if (context) {
    await installCorpusContextNetworkGuard(context, options);
  }
  await installCorpusNetworkGuard(page, options);
}
