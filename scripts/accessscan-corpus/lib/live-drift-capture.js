import {
  compareCorpusFindings,
  buildCorpusMultiset,
} from '../../../src/scanner/access-scan/corpus/diff.js';
import { resolveScanProfile } from '../../../src/scanner/access-scan/engine/profiles.js';
import { createScanSession, installRuntimeHooks } from '../../../src/scanner/access-scan/runtime/index.js';
import { DEFAULT_PAGE_STATE, normalizeCapturedSnapshot } from './capture.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import {
  buildReplayFindingsFromExpected,
  filterViolationsForExpectedRules,
} from './replay.js';
import { buildSnapshotIdentity, snapshotsSemanticallyEqual } from './snapshot-identity.js';
import { sanitizeSnapshot } from './sanitize.js';
import {
  installCorpusPageAndContextGuards,
  navigateToReviewedSource,
} from './source-url-policy.js';

const REQUIRED_ATOMIC_PASS_COUNT = 2;

/**
 * @typedef {object} AtomicLivePass
 * @property {number} pass
 * @property {string} snapshotIdentity
 * @property {string} findingsIdentity
 * @property {Record<string, unknown>} snapshot
 * @property {Record<string, unknown>[]} findings
 */

/**
 * @param {Record<string, unknown>[]} findings
 * @returns {string}
 */
export function buildFindingsIdentity(findings = []) {
  return buildCorpusMultiset(findings).sort().join('\n');
}

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   sourceUrl: string,
 *   profile: string,
 *   context: ReturnType<import('./replay.js').loadCorpusCaseContext>,
 *   configureForkedPage?: (request: {
 *     page: import('playwright').Page,
 *     context: import('playwright').BrowserContext | null,
 *   }) => Promise<void>,
 * }} options
 * @returns {Promise<{ snapshot: Record<string, unknown>, findings: Record<string, unknown>[] }>}
 */
export async function captureAtomicScannerPass(page, options) {
  const { sourceUrl, profile, context } = options;
  const { scanWithAccessScan } = await import('../../../src/scanner/access-scan/index.js');
  const session = await createScanSession(page, {
    stabilityQuietMs: 250,
    stabilityTimeoutMs: 30000,
    stabilityMinObserveMs: 200,
    configureForkedPage: options.configureForkedPage,
  });

  const violations = await scanWithAccessScan(page, sourceUrl, {
    skipNavigation: true,
    activateContent: false,
    profile,
    session,
  });
  const relevantViolations = filterViolationsForExpectedRules(violations, context.expected);
  const snapshot = normalizeCapturedSnapshot(session.snapshot);
  const findings = await buildReplayFindingsFromExpected(
    context.expected,
    relevantViolations,
    snapshot,
    { profile },
  );

  return { snapshot, findings };
}

/**
 * @param {{
 *   sourceUrl: string,
 *   context: ReturnType<import('./replay.js').loadCorpusCaseContext>,
 *   atomicPass?: typeof captureAtomicScannerPass,
 *   navigate?: typeof navigateToReviewedSource,
 *   resolver?: (hostname: string) => Promise<string[]>,
 * }} request
 * @returns {Promise<{
 *   snapshot: Record<string, unknown>,
 *   findings: Record<string, unknown>[],
 *   passes: AtomicLivePass[],
 *   driftBasis: 'scanner-vs-frozen-oracle',
 * }>}
 */
export async function captureLiveStableDriftCandidate(request) {
  const { chromium } = await import('playwright');
  const atomicPass = request.atomicPass || captureAtomicScannerPass;
  const navigate = request.navigate || navigateToReviewedSource;
  const networkOptions = request.resolver ? { resolver: request.resolver } : {};
  const viewport = /** @type {{ width: number, height: number }} */ (request.context.meta.viewport);
  const captureState = String(request.context.meta.captureState || DEFAULT_PAGE_STATE);
  if (captureState !== DEFAULT_PAGE_STATE) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.UNSUPPORTED_PAGE_STATE,
      `Live drift supports only captureState "${DEFAULT_PAGE_STATE}"`,
      { captureState },
    );
  }

  const profile = resolveScanProfile({
    profile: request.context.meta.profile ?? request.context.expected.profile,
  });

  const configureForkedPage = async ({ page, context }) => {
    await installCorpusPageAndContextGuards(page, context, networkOptions);
  };

  const browser = await chromium.launch({ headless: true });
  /** @type {AtomicLivePass[]} */
  const passes = [];

  try {
    const page = await browser.newPage();
    const context = page.context();
    await page.setViewportSize(viewport);
    await installRuntimeHooks(page);
    await installCorpusPageAndContextGuards(page, context, networkOptions);

    for (let pass = 1; pass <= REQUIRED_ATOMIC_PASS_COUNT; pass += 1) {
      await navigate(page, request.sourceUrl, networkOptions);
      const outcome = await atomicPass(page, {
        sourceUrl: request.sourceUrl,
        profile,
        context: request.context,
        configureForkedPage,
      });

      const snapshot = sanitizeSnapshot(outcome.snapshot);
      passes.push({
        pass,
        snapshotIdentity: buildSnapshotIdentity(snapshot),
        findingsIdentity: buildFindingsIdentity(outcome.findings),
        snapshot,
        findings: outcome.findings,
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (!snapshotsSemanticallyEqual(passes[0].snapshot, passes[1].snapshot)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.UNSTABLE_CAPTURE,
      'Atomic scanner passes produced unstable snapshot identity',
      { passCount: passes.length },
    );
  }

  const findingsDiff = compareCorpusFindings(passes[0].findings, passes[1].findings);
  if (!findingsDiff.equivalent) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.UNSTABLE_CAPTURE,
      'Atomic scanner passes produced unstable finding identity',
      { passCount: passes.length },
    );
  }

  return {
    snapshot: passes[0].snapshot,
    findings: passes[0].findings,
    passes,
    driftBasis: 'scanner-vs-frozen-oracle',
  };
}
