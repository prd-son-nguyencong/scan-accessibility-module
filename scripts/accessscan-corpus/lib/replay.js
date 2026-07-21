import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCorpusRuleId } from '../../../src/reporter/rule-aliases.js';
import { resolveScanProfile } from '../../../src/scanner/access-scan/engine/profiles.js';
import { normalizeSelector } from '../../../src/reporter/fingerprint.js';
import { DEFAULT_PAGE_STATE, validateCapturePageState } from './capture.js';
import { readCorpusCaseFile, readCorpusCaseJson } from './corpus-case-read.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { ingestAccessScanReport, normalizeReportFindings } from './ingest.js';
import { buildSemanticFromSnapshotElement } from './landmark.js';
import { sanitizeSemanticDescriptor } from './sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_TMP_ROOT = path.resolve(__dirname, '../../../.tmp-accessscan-corpus-playwright');
mkdirSync(PLAYWRIGHT_TMP_ROOT, { recursive: true });

/**
 * Ensures Playwright can create artifact temp directories in this environment.
 */
export function ensurePlaywrightTempDir() {
  if (!process.env.TMPDIR) {
    process.env.TMPDIR = PLAYWRIGHT_TMP_ROOT;
    return;
  }
  try {
    mkdirSync(process.env.TMPDIR, { recursive: true });
  } catch {
    process.env.TMPDIR = PLAYWRIGHT_TMP_ROOT;
  }
}

/**
 * @typedef {object} CorpusCaseContext
 * @property {string} caseDir
 * @property {Record<string, unknown>} meta
 * @property {Record<string, unknown>} expected
 * @property {Record<string, unknown>} snapshot
 * @property {string | null} pageHtml
 */

/**
 * @param {string} caseDir
 * @param {string=} corpusRoot
 * @returns {CorpusCaseContext}
 */
export function loadCorpusCaseContext(caseDir, corpusRoot) {
  const resolved = path.resolve(caseDir);
  const resolvedRoot = corpusRoot
    ? path.resolve(corpusRoot)
    : path.dirname(path.dirname(resolved));
  const meta = readCorpusCaseJson(resolved, 'meta.json', resolvedRoot);
  const expected = readCorpusCaseJson(resolved, 'expected.json', resolvedRoot);
  const snapshot = readCorpusCaseJson(resolved, 'snapshot.json', resolvedRoot);
  const pageHtmlPath = path.join(resolved, 'page.html');
  const pageHtml = existsSync(pageHtmlPath)
    ? readCorpusCaseFile(resolved, 'page.html', resolvedRoot)
    : null;

  return {
    caseDir: resolved,
    meta,
    expected,
    snapshot,
    pageHtml,
  };
}

/**
 * @param {Record<string, unknown>[]} violations
 * @param {Record<string, unknown>} expected
 * @returns {Record<string, unknown>[]}
 */
export function filterViolationsForExpectedRules(violations = [], expected = {}) {
  const expectedRuleIds = new Set(
    (Array.isArray(expected.findings) ? expected.findings : [])
      .flatMap((finding) => {
        const canonical = normalizeCorpusRuleId(String(finding.canonicalRuleId || finding.ruleId || ''));
        const raw = String(finding.ruleId || finding.canonicalRuleId || '');
        return [canonical, raw].filter(Boolean);
      }),
  );

  return violations.filter((violation) => {
    const ruleId = normalizeCorpusRuleId(String(violation.ruleId || violation.nativeRuleId || ''));
    const rawRuleId = String(violation.ruleId || violation.nativeRuleId || '');
    const selector = String(violation.element?.selector || '');
    const outerHTML = String(violation.element?.outerHTML || violation.element?.html || '');
    const ruleMatches = expectedRuleIds.has(ruleId) || expectedRuleIds.has(rawRuleId);
    return ruleMatches && selector.length > 0 && outerHTML.length > 0;
  });
}

/**
 * @param {Record<string, unknown>[]} violations
 * @returns {Record<string, unknown>[]}
 */
export function violationsToReportFindings(violations = []) {
  return violations.map((violation) => {
    const element = /** @type {Record<string, unknown>} */ (violation.element || {});
    const evidence = /** @type {Record<string, unknown>} */ (violation.evidence || {});
    return {
      ruleId: violation.ruleId || violation.nativeRuleId,
      violationType: evidence.violationType || violation.violationType || 'confirmed',
      evidence: {
        ...(typeof evidence.checkId === 'string' ? { checkId: evidence.checkId } : {}),
        ...(typeof evidence.check === 'string' ? { checkId: evidence.check } : {}),
        ...(typeof evidence.structuralPattern === 'string'
          ? { structuralPattern: evidence.structuralPattern }
          : {}),
      },
      element: {
        outerHTML: element.outerHTML || element.html || '',
        selector: element.selector || '',
        ...(Array.isArray(element.framePath) && element.framePath.length > 0
          ? { framePath: [...element.framePath] }
          : {}),
        ...(Array.isArray(element.shadowPath) && element.shadowPath.length > 0
          ? { shadowPath: [...element.shadowPath] }
          : {}),
      },
    };
  });
}

/**
 * @param {Record<string, unknown>[]} elements
 * @param {Record<string, unknown>} semantic
 * @returns {Record<string, unknown> | null}
 */
export function findSnapshotElementBySemantic(elements = [], semantic = {}) {
  const target = semantic || {};
  return elements.find((element) => {
    const built = buildSemanticFromSnapshotElement(elements, element);
    return built.tag === target.tag
      && Number(built.ordinal) === Number(target.ordinal)
      && JSON.stringify(built.landmarkPath) === JSON.stringify(target.landmarkPath || []);
  }) || null;
}

/**
 * @param {string} selector
 * @returns {string}
 */
function normalizeReplaySelector(selector = '') {
  return normalizeSelector(String(selector))
    .replace(/^html > body(?:\[[^\]]+\])? > /i, '')
    .replace(/:nth-of-type\(\d+\)/g, '')
    .replace(/:nth-child\(\d+\)/g, '')
    .trim();
}

/**
 * @param {Set<string>} bindingSelectors
 * @param {string} violationSelector
 * @returns {boolean}
 */
function selectorEvidenceMatches(bindingSelectors, violationSelector = '') {
  const normalizedViolation = normalizeReplaySelector(violationSelector);
  if (!normalizedViolation) return false;

  for (const selector of bindingSelectors) {
    const normalizedBinding = normalizeReplaySelector(selector);
    if (!normalizedBinding) continue;
    if (normalizedBinding === normalizedViolation) return true;
    if (normalizedViolation.endsWith(normalizedBinding) || normalizedBinding.endsWith(normalizedViolation)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown>[]} violations
 * @param {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} bindings
 * @param {Record<string, unknown>[]} elements
 * @param {Set<string>} allowedRuleIds
 * @param {string} profile
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function buildReplayFindingsFromSelectorBindings(
  violations = [],
  bindings = [],
  elements = [],
  allowedRuleIds = new Set(),
  profile,
) {
  /** @type {Record<string, unknown>[]} */
  const findings = [];
  const usedViolationIndexes = new Set();

  for (const binding of bindings) {
    const slice = /** @type {{ ruleId: string }} */ (binding.slice);
    const canonicalRule = normalizeCorpusRuleId(slice.ruleId);
    const element = binding.element;
    const selectors = new Set(
      [element.selector, element.reportSelector]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );

    const violationIndex = violations.findIndex((violation, index) => {
      if (usedViolationIndexes.has(index)) return false;
      const violationRule = normalizeCorpusRuleId(String(
        violation.ruleId || violation.nativeRuleId || '',
      ));
      if (violationRule !== canonicalRule) return false;
      const violationSelector = String(violation.element?.selector || '').trim();
      return selectorEvidenceMatches(selectors, violationSelector);
    });

    if (violationIndex < 0) continue;

    usedViolationIndexes.add(violationIndex);
    const violation = violations[violationIndex];
    const report = ingestAccessScanReport({
      profile,
      route: '/',
      pageState: 'initial',
      viewport: { width: 1280, height: 900 },
      findings: violationsToReportFindings([violation]),
    });
    const [normalized] = await normalizeReportFindings(report, { allowedRuleIds });
    const semantic = buildSemanticFromSnapshotElement(elements, element);
    findings.push({
      ...normalized,
      element: {
        semantic: sanitizeSemanticDescriptor(semantic),
      },
    });
  }

  return findings;
}

/**
 * @param {Record<string, unknown>} expected
 * @param {Record<string, unknown>[]} violations
 * @param {Record<string, unknown>} snapshot
 * @param {{ profile: string }} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function buildReplayFindingsFromExpected(expected, violations, snapshot, options) {
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  /** @type {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} */
  const bindings = [];

  for (const finding of Array.isArray(expected.findings) ? expected.findings : []) {
    const semantic = /** @type {Record<string, unknown> | undefined} */ (
      finding.element?.semantic
    );
    if (!semantic) continue;
    const element = findSnapshotElementBySemantic(elements, semantic);
    if (!element) continue;
    bindings.push({
      slice: {
        ruleId: finding.ruleId || finding.canonicalRuleId,
      },
      element,
    });
  }

  const allowedRuleIds = new Set(
    bindings.map(({ slice }) => String(slice.ruleId)).filter(Boolean),
  );

  return buildReplayFindingsFromSelectorBindings(
    violations,
    bindings,
    elements,
    allowedRuleIds,
    options.profile,
  );
}

/**
 * @param {CorpusCaseContext} context
 * @param {{
 *   stateAdapter?: (page: import('playwright').Page, replayContext: Record<string, unknown>) => Promise<void>,
 * }=} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function replayCorpusCaseWithPlaywright(context, options = {}) {
  const { meta, expected, snapshot, pageHtml } = context;
  if (!pageHtml) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.REPLAY_IMPOSSIBLE,
      'Case replay requires page.html',
      { caseId: meta.id },
    );
  }

  const captureState = String(meta.captureState || DEFAULT_PAGE_STATE);
  validateCapturePageState(captureState, options.stateAdapter);
  ensurePlaywrightTempDir();

  const viewport = /** @type {{ width: number, height: number }} */ (meta.viewport);
  const { chromium } = await import('playwright');
  const { installRuntimeHooks } = await import('../../../src/scanner/access-scan/runtime/index.js');
  const { scanWithAccessScan } = await import('../../../src/scanner/access-scan/index.js');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize(viewport);
    await installRuntimeHooks(page);
    await page.setContent(pageHtml, { waitUntil: 'domcontentloaded' });

    if (typeof options.stateAdapter === 'function') {
      await options.stateAdapter(page, {
        captureState,
        viewport,
        meta,
        expected,
      });
    }

    const profile = resolveScanProfile({ profile: meta.profile ?? expected.profile });
    const violations = await scanWithAccessScan(page, 'http://127.0.0.1/', {
      skipNavigation: true,
      profile,
      activateContent: false,
    });
    const relevantViolations = filterViolationsForExpectedRules(violations, expected);
    return buildReplayFindingsFromExpected(expected, relevantViolations, snapshot, { profile });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {CorpusCaseContext} context
 * @param {{
 *   stateAdapter?: (page: import('playwright').Page, replayContext: Record<string, unknown>) => Promise<void>,
 * }=} options
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function defaultReplayScanCase(context, options = {}) {
  return replayCorpusCaseWithPlaywright(context, options);
}
