import { normalizeHtml, normalizeSelector } from '../../../src/reporter/fingerprint.js';
import {
  isKnownExternalCommercialRuleId,
  normalizeCorpusRuleId,
  resolveNativeRuleId,
} from '../../../src/reporter/rule-aliases.js';
import { CORPUS_PROFILES } from '../../../src/scanner/access-scan/corpus/constants.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { resolveAllowedRuleIds } from './rule-ids.js';

/**
 * @typedef {object} NormalizedAccessScanReport
 * @property {string} profile
 * @property {string} route
 * @property {string} pageState
 * @property {{ width: number, height: number }} viewport
 * @property {Record<string, unknown>[]} findings
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} ruleId
 * @param {{ profile?: string }=} options
 * @returns {Promise<{ nativeRuleId: string, canonicalRuleId: string }>}
 */
export async function canonicalizeExternalRuleAlias(ruleId, options = {}) {
  const normalized = String(ruleId || '').trim();
  if (!normalized) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'Finding ruleId is required',
    );
  }

  if (isKnownExternalCommercialRuleId(normalized)) {
    try {
      const nativeRuleId = resolveNativeRuleId(normalized);
      return {
        nativeRuleId,
        canonicalRuleId: normalizeCorpusRuleId(normalized),
      };
    } catch {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.UNKNOWN_ALIAS,
        `Unknown external commercial rule id: ${normalized}`,
        { ruleId: normalized, profile: options.profile || null },
      );
    }
  }

  const allowedRuleIds = options.allowedRuleIds ?? await resolveAllowedRuleIds(options);
  if (allowedRuleIds.has(normalized)) {
    return {
      nativeRuleId: normalized,
      canonicalRuleId: normalizeCorpusRuleId(normalized),
    };
  }

  throw new CorpusToolingError(
    CORPUS_TOOLING_ERROR_CODES.UNKNOWN_ALIAS,
    `Unknown rule id: ${normalized}`,
    { ruleId: normalized, profile: options.profile || null },
  );
}

/**
 * @param {Record<string, unknown>} report
 * @returns {NormalizedAccessScanReport}
 */
export function ingestAccessScanReport(report = {}) {
  if (!isObject(report)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'Report payload must be an object',
    );
  }

  const profile = typeof report.profile === 'string' ? report.profile : null;
  const route = typeof report.route === 'string' ? report.route : null;
  const pageState = typeof report.pageState === 'string' ? report.pageState : null;
  const viewport = isObject(report.viewport) ? report.viewport : null;
  const findings = Array.isArray(report.findings) ? report.findings : null;

  /** @type {string[]} */
  const missing = [];
  if (!profile || !CORPUS_PROFILES.includes(profile)) missing.push('profile');
  if (!route) missing.push('route');
  if (!pageState) missing.push('pageState');
  if (!viewport
    || !Number.isInteger(viewport.width)
    || !Number.isInteger(viewport.height)
    || viewport.width <= 0
    || viewport.height <= 0) {
    missing.push('viewport');
  }
  if (!findings || findings.length === 0) missing.push('findings');

  if (missing.length > 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      `Report payload is incomplete: missing ${missing.join(', ')}`,
      { missing },
    );
  }

  return {
    profile,
    route,
    pageState,
    viewport: {
      width: viewport.width,
      height: viewport.height,
    },
    findings,
  };
}

/**
 * @param {Record<string, unknown>} finding
 * @param {{ profile?: string }=} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function normalizeReportFinding(finding = {}, options = {}) {
  const ruleId = finding.nativeRuleId
    || finding.ruleId
    || finding.canonicalRuleId
    || null;
  if (!ruleId) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'Finding is missing ruleId',
    );
  }

  const aliases = await canonicalizeExternalRuleAlias(String(ruleId), options);
  const element = isObject(finding.element) ? finding.element : {};
  const outerHTML = normalizeHtml(String(element.outerHTML || element.html || ''));
  const selector = normalizeSelector(String(element.selector || ''));
  const evidence = isObject(finding.evidence) ? finding.evidence : {};

  return {
    ruleId: aliases.nativeRuleId,
    canonicalRuleId: aliases.canonicalRuleId,
    violationType: finding.violationType || 'confirmed',
    evidence: {
      ...(typeof evidence.checkId === 'string' ? { checkId: evidence.checkId } : {}),
      ...(typeof evidence.check === 'string' ? { checkId: evidence.check } : {}),
      ...(typeof evidence.structuralPattern === 'string'
        ? { structuralPattern: evidence.structuralPattern }
        : {}),
    },
    element: {
      outerHTML,
      selector,
      ...(Array.isArray(element.framePath) && element.framePath.length > 0
        ? { framePath: [...element.framePath] }
        : {}),
      ...(Array.isArray(element.shadowPath) && element.shadowPath.length > 0
        ? { shadowPath: [...element.shadowPath] }
        : {}),
    },
  };
}

/**
 * @param {NormalizedAccessScanReport} report
 * @param {{ allowedRuleIds?: Set<string> }=} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function normalizeReportFindings(report, options = {}) {
  const findingOptions = {
    profile: report.profile,
    allowedRuleIds: options.allowedRuleIds,
  };
  /** @type {Record<string, unknown>[]} */
  const findings = [];
  for (const finding of report.findings) {
    findings.push(await normalizeReportFinding(
      /** @type {Record<string, unknown>} */ (finding),
      findingOptions,
    ));
  }
  return findings;
}
