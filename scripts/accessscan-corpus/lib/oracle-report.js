import { readFileSync } from 'node:fs';

import { CORPUS_PROFILES } from '../../../src/scanner/access-scan/corpus/constants.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';

const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const DEFAULT_ROUTE = '/';
const DEFAULT_PAGE_STATE = 'initial';
const DEFAULT_PROFILE = 'commercial-parity';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} encoded
 * @returns {string}
 */
function decodeOracleHtml(encoded = '') {
  try {
    return decodeURIComponent(String(encoded));
  } catch {
    return String(encoded);
  }
}

/**
 * Normalize accessScan API payloads from network-request or details-response shapes.
 *
 * @param {unknown} payload
 * @returns {{ reports: Record<string, unknown>, website: string | null, token: string | null }}
 */
export function parseAccessScanOraclePayload(payload) {
  if (!isObject(payload)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'Oracle payload must be an object',
    );
  }

  if (isObject(payload.result) && isObject(payload.result.reports)) {
    return {
      reports: /** @type {Record<string, unknown>} */ (payload.result.reports),
      website: typeof payload.result.website === 'string' ? payload.result.website : null,
      token: typeof payload.result.token === 'string' ? payload.result.token : null,
    };
  }

  if (typeof payload.reports === 'string') {
    const parsed = JSON.parse(payload.reports);
    if (!isObject(parsed) || !isObject(parsed.reports)) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
        'Oracle reports string is missing reports object',
      );
    }
    return {
      reports: /** @type {Record<string, unknown>} */ (parsed.reports),
      website: typeof parsed.website === 'string' ? parsed.website : null,
      token: typeof payload.token === 'string' ? payload.token : null,
    };
  }

  if (isObject(payload.reports)) {
    return {
      reports: /** @type {Record<string, unknown>} */ (payload.reports),
      website: typeof payload.website === 'string' ? payload.website : null,
      token: typeof payload.token === 'string' ? payload.token : null,
    };
  }

  throw new CorpusToolingError(
    CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
    'Oracle payload is missing reports',
  );
}

/**
 * @param {Record<string, unknown>} reports
 * @returns {{
 *   findings: Record<string, unknown>[],
 *   limitations: string[],
 *   ruleFailureTotals: Record<string, number>,
 *   htmlBackedTotals: Record<string, number>,
 * }}
 */
export function extractOracleFindings(reports = {}) {
  /** @type {Record<string, unknown>[]} */
  const findings = [];
  /** @type {string[]} */
  const limitations = [];
  /** @type {Record<string, number>} */
  const ruleFailureTotals = {};
  /** @type {Record<string, number>} */
  const htmlBackedTotals = {};

  for (const category of Object.values(reports)) {
    if (!isObject(category)) continue;
    for (const [ruleId, ruleData] of Object.entries(category)) {
      if (!isObject(ruleData) || !('failures' in ruleData)) continue;
      const failures = Number(ruleData.failures || 0);
      if (failures <= 0) continue;

      const htmlSnippets = Array.isArray(ruleData.failuresHtml)
        ? ruleData.failuresHtml
        : [];
      ruleFailureTotals[ruleId] = (ruleFailureTotals[ruleId] || 0) + failures;
      htmlBackedTotals[ruleId] = (htmlBackedTotals[ruleId] || 0) + htmlSnippets.length;

      if (htmlSnippets.length < failures) {
        limitations.push(
          `${ruleId}: oracle reports ${failures} failures but only ${htmlSnippets.length} failuresHtml snippets were captured`,
        );
      }

      for (const encodedHtml of htmlSnippets) {
        const outerHTML = decodeOracleHtml(String(encodedHtml));
        if (!outerHTML) continue;
        findings.push({
          ruleId,
          violationType: 'confirmed',
          element: {
            outerHTML,
            selector: '',
          },
        });
      }
    }
  }

  if (findings.length === 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'Oracle payload has no html-backed failure evidence',
    );
  }

  return {
    findings,
    limitations,
    ruleFailureTotals,
    htmlBackedTotals,
  };
}

/**
 * @param {unknown} payload
 * @param {{
 *   profile?: string,
 *   route?: string,
 *   pageState?: string,
 *   viewport?: { width: number, height: number },
 * }=} options
 * @returns {{
 *   report: Record<string, unknown>,
 *   limitations: string[],
 *   website: string | null,
 *   token: string | null,
 *   ruleFailureTotals: Record<string, number>,
 *   htmlBackedTotals: Record<string, number>,
 * }}
 */
export function buildCorpusReportFromOracle(payload, options = {}) {
  const profile = options.profile || DEFAULT_PROFILE;
  if (!CORPUS_PROFILES.includes(profile)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      `Unsupported corpus profile: ${profile}`,
    );
  }

  const parsed = parseAccessScanOraclePayload(payload);
  const extracted = extractOracleFindings(parsed.reports);

  return {
    report: {
      profile,
      route: options.route || DEFAULT_ROUTE,
      pageState: options.pageState || DEFAULT_PAGE_STATE,
      viewport: options.viewport || DEFAULT_VIEWPORT,
      findings: extracted.findings,
    },
    limitations: extracted.limitations,
    website: parsed.website,
    token: parsed.token,
    ruleFailureTotals: extracted.ruleFailureTotals,
    htmlBackedTotals: extracted.htmlBackedTotals,
  };
}

/**
 * @param {string} filePath
 * @param {{
 *   profile?: string,
 *   route?: string,
 *   pageState?: string,
 *   viewport?: { width: number, height: number },
 * }=} options
 */
export function buildCorpusReportFromOracleFile(filePath, options = {}) {
  const payload = JSON.parse(readFileSync(filePath, 'utf8'));
  return buildCorpusReportFromOracle(payload, options);
}
