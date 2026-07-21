import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CORPUS_SCHEMA_VERSION } from '../../../src/scanner/access-scan/corpus/constants.js';
import { resolveScanProfile } from '../../../src/scanner/access-scan/engine/profiles.js';
import { normalizeCorpusRuleId } from '../../../src/reporter/rule-aliases.js';
import { alignFindingsToSnapshotPartial } from './align.js';
import {
  captureLiveSnapshot,
  captureStableSnapshot,
  normalizeCapturedSnapshot,
} from './capture.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { ingestAccessScanReport, normalizeReportFindings } from './ingest.js';
import { buildOracleEvidenceDigest } from './oracle-digest.js';
import { buildCorpusReportFromOracle } from './oracle-report.js';
import {
  buildReplayFindingsFromSelectorBindings,
  ensurePlaywrightTempDir,
  filterViolationsForExpectedRules,
  findSnapshotElementBySemantic,
  violationsToReportFindings,
} from './replay.js';
import { resolveAllowedRuleIds } from './rule-ids.js';
import {
  assertNoRedactionLeaks,
  findSnapshotAttributeViolations,
  sanitizeSemanticDescriptor,
  sanitizeSnapshot,
} from './sanitize.js';
import { sanitizeOracleSnippetHtml } from './oracle-snippet-sanitize.js';
import {
  stripNonAllowlistedAttributesFromHtml,
} from '../../../src/scanner/access-scan/corpus/attribute-allowlist.js';
import {
  containsNonNeutralCommittedText,
  containsNonNeutralExpected,
  containsNonNeutralSnapshot,
  containsPartialRedactionMarker,
  pseudonymizeHtmlTextContent,
} from './text-pseudonymization.js';
import { buildLandmarkPath, buildSemanticFromSnapshotElement } from './landmark.js';
import { buildSnapshotIdentity } from './snapshot-identity.js';

const TRUNCATED_SNIPPET_PATTERN = /\.\.\.$/;
const GENERATED_ATTR_PATTERN = /\s(?:id|class|style|data-testid|data-test|data-cy|data-qa|data-guid|data-react-component|data-react-prop-[^=]*|data-mfp-src|data-disable-at|data-variant|data-lang)=["'][^"']*["']/gi;
const ABSOLUTE_URL_ATTR_PATTERN = /\s(?:href|src|xlink:href)=["']https?:\/\/[^"']+["']/gi;
const RELATIVE_ASSET_ATTR_PATTERN = /\s(?:href|src|xlink:href)=["'][^"']*["']/gi;
const SKIP_SNIPPET_TAG_PATTERN = /^<(body|html|head)\b/i;
const HEAD_INJECT_RULE_IDS = new Set([
  'PageTitle',
  'PageTitleValid',
  'PageMetaViewportValid',
]);

/**
 * @param {string} html
 * @returns {boolean}
 */
export function isTruncatedOracleSnippet(html = '') {
  return TRUNCATED_SNIPPET_PATTERN.test(String(html).trim());
}

/**
 * @param {string} html
 * @returns {string}
 */
function extractSnippetTag(html = '') {
  const match = String(html).match(/^<\s*([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

/**
 * @param {Record<string, string>} caseFiles
 */
export function assertCommittedEvidenceNeutral(caseFiles = {}) {
  /** @type {string[]} */
  const violations = [];

  for (const [name, content] of Object.entries(caseFiles)) {
    if (typeof content !== 'string') continue;
    if (containsPartialRedactionMarker(content)) {
      violations.push(`${name} contains partial redaction marker`);
    }

    if (name.endsWith('.html')) {
      if (containsNonNeutralCommittedText(content)) {
        violations.push(`${name} contains non-neutral human-readable evidence`);
      }
      continue;
    }

    if (name === 'snapshot.json') {
      const snapshot = JSON.parse(content);
      if (containsNonNeutralSnapshot(snapshot)) {
        violations.push(`${name} contains non-neutral human-readable evidence`);
      }
      violations.push(...findSnapshotAttributeViolations(snapshot));
      continue;
    }

    if (name === 'expected.json') {
      if (containsNonNeutralExpected(JSON.parse(content))) {
        violations.push(`${name} contains non-neutral human-readable evidence`);
      }
    }
  }

  assertNoRedactionLeaks(caseFiles);

  if (violations.length > 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.REDACTION_LEAK,
      violations[0],
      { violations },
    );
  }
}

/**
 * @param {string} pageHtml
 * @returns {string}
 */
export function repseudonymizeEvidenceSlicePageHtml(pageHtml = '') {
  const sectionPattern = /(<section\s+aria-label="slice-\d+">\s*)([\s\S]*?)(\s*<\/section>)/g;
  let output = String(pageHtml).replace(sectionPattern, (match, open, inner, close) => {
    const sanitized = sanitizeOracleSnippetHtml(inner.trim());
    return `${open}${sanitized}${close}`;
  });

  output = output.replace(
    /<meta\s+name=["']viewport["']\s+content=["'][^"']*["']\s*\/?>/gi,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  output = output.replace(/<head>[\s\S]*?<\/head>/i, (head) => {
    const normalizedHead = head.replace(
      /<meta\s+name=["']viewport["']\s+content=["'][^"']*["']\s*\/?>/gi,
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    return pseudonymizeHtmlTextContent(normalizedHead);
  });

  return stripNonAllowlistedAttributesFromHtml(output);
}

/**
 * @param {string} ruleId
 * @param {string} html
 * @returns {'head' | 'body' | 'skip'}
 */
export function classifyOracleSnippetPlacement(ruleId = '', html = '') {
  const canonicalRuleId = normalizeCorpusRuleId(ruleId);
  if (HEAD_INJECT_RULE_IDS.has(canonicalRuleId) || /^<title\b/i.test(html) || /^<meta\b/i.test(html)) {
    return 'skip';
  }
  if (SKIP_SNIPPET_TAG_PATTERN.test(html)) {
    return 'skip';
  }
  return 'body';
}

/**
 * @param {Record<string, unknown>[]} findings
 * @returns {{
 *   slices: Array<{ ruleId: string, html: string, sliceKey: string, placement: 'head' | 'body', sliceIndex: number }>,
 *   limitations: string[],
 * }}
 */
export function buildUniqueAlignableSlices(findings = []) {
  /** @type {Array<{ ruleId: string, html: string, sliceKey: string, placement: 'head' | 'body', sliceIndex: number }>} */
  const slices = [];
  /** @type {string[]} */
  const limitations = [];
  const seen = new Map();
  let bodyIndex = 0;
  let headIndex = 0;

  for (const [index, finding] of findings.entries()) {
    const ruleId = String(finding.ruleId || finding.canonicalRuleId || 'unknown-rule');
    const element = /** @type {{ outerHTML?: string, html?: string }} */ (finding.element || {});
    const rawHtml = String(element.outerHTML || element.html || '');
    if (!rawHtml) {
      limitations.push(`${ruleId}: empty oracle html snippet at index ${index}`);
      continue;
    }
    if (isTruncatedOracleSnippet(rawHtml)) {
      limitations.push(`${ruleId}: truncated oracle html snippet skipped at index ${index}`);
      continue;
    }

    const placement = classifyOracleSnippetPlacement(ruleId, rawHtml);
    if (placement === 'skip') {
      limitations.push(`${ruleId}: non-replayable document-level snippet skipped at index ${index}`);
      continue;
    }

    const html = sanitizeOracleSnippetHtml(rawHtml);
    if (!html || html.length < 3) {
      limitations.push(`${ruleId}: sanitized oracle html snippet empty at index ${index}`);
      continue;
    }

    const canonicalRuleId = normalizeCorpusRuleId(ruleId);
    const dedupeKey = `${placement}|${canonicalRuleId}|${html}`;
    const occurrence = seen.get(dedupeKey) || 0;
    seen.set(dedupeKey, occurrence + 1);
    const sliceIndex = placement === 'head' ? headIndex++ : bodyIndex++;
    slices.push({
      ruleId,
      html,
      sliceKey: `${canonicalRuleId}-${occurrence}`,
      placement,
      sliceIndex,
    });
  }

  if (slices.length === 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'No uniquely alignable oracle evidence snippets remain after sanitization',
      { limitations },
    );
  }

  return { slices, limitations };
}

/**
 * @param {Array<{ ruleId: string, html: string, placement: 'head' | 'body', sliceIndex: number }>} slices
 * @returns {string}
 */
export function buildEvidenceSlicePageHtml(slices = []) {
  const headSlices = slices.filter((slice) => slice.placement === 'head');
  const bodySlices = slices.filter((slice) => slice.placement === 'body');

  const headInjections = headSlices.map((slice) => `  ${slice.html}`).join('\n');
  const sections = bodySlices.map((slice) => (
    `    <section aria-label="slice-${slice.sliceIndex}">\n      ${slice.html}\n    </section>`
  )).join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    headInjections || '  <title>Neutral evidence slice</title>',
    '</head>',
    '<body>',
    '  <header aria-label="Neutral header">',
    '    <nav aria-label="Neutral navigation"><ul><li><a href="/">Home</a></li></ul></nav>',
    '  </header>',
    '  <main id="page-main-content">',
    sections,
    '  </main>',
    '  <footer aria-label="Neutral footer"><p>Neutral footer</p></footer>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {Array<{ ruleId: string, html: string, placement: 'head' | 'body', sliceIndex: number }>} slices
 * @returns {{
 *   bindings: Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>,
 *   limitations: string[],
 * }}
 */
export function bindSlicesToSnapshotElements(snapshot = {}, slices = []) {
  const elements = Array.isArray(snapshot.elements)
    ? /** @type {Record<string, unknown>[]} */ (snapshot.elements)
    : [];
  /** @type {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} */
  const bindings = [];
  /** @type {string[]} */
  const limitations = [];

  for (const slice of slices) {
    const tag = extractSnippetTag(slice.html);
    let candidates = [];

    if (slice.placement === 'head') {
      candidates = elements.filter((element) => (
        String(element.tag || '').toLowerCase() === tag
        && buildLandmarkPath(elements, element).length === 0
      ));
    } else {
      const sliceLandmark = `section[slice-${slice.sliceIndex}]`;
      candidates = elements.filter((element) => {
        const landmarkPath = buildLandmarkPath(elements, element);
        return String(element.tag || '').toLowerCase() === tag
          && landmarkPath.includes(sliceLandmark);
      });
    }

    if (candidates.length === 0) {
      limitations.push(`${slice.ruleId}: no snapshot element bound for slice-${slice.sliceIndex}`);
      continue;
    }

    if (candidates.length > 1) {
      limitations.push(`${slice.ruleId}: ambiguous snapshot binding for slice-${slice.sliceIndex}`);
    }

    bindings.push({
      slice,
      element: candidates[0],
    });
  }

  return { bindings, limitations };
}

/**
 * @param {Record<string, unknown>[]} replayFindings
 * @param {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} bindings
 * @param {Record<string, unknown>[]} elements
 * @returns {{
 *   findings: Record<string, unknown>[],
 *   limitations: string[],
 * }}
 */
export function matchReplayFindingsToOracleBindings(replayFindings = [], bindings = [], elements = []) {
  /** @type {Record<string, unknown>[]} */
  const findings = [];
  /** @type {string[]} */
  const limitations = [];

  for (const binding of bindings) {
    const slice = /** @type {{ ruleId: string, sliceIndex?: number, placement?: string }} */ (binding.slice);
    const targetSemantic = buildSemanticFromSnapshotElement(elements, binding.element);
    const canonicalRule = normalizeCorpusRuleId(slice.ruleId);
    const sliceLandmark = slice.placement === 'body'
      ? `section[slice-${slice.sliceIndex}]`
      : null;

    const match = replayFindings.find((finding) => {
      const findingRule = normalizeCorpusRuleId(String(
        finding.canonicalRuleId || finding.ruleId || '',
      ));
      const semantic = /** @type {{ semantic?: Record<string, unknown> }} */ (
        finding.element || {}
      ).semantic || {};
      const landmarkPath = Array.isArray(semantic.landmarkPath)
        ? semantic.landmarkPath.map(String)
        : [];

      const ruleMatches = findingRule === canonicalRule;
      const landmarkMatches = sliceLandmark
        ? landmarkPath.includes(sliceLandmark)
        : landmarkPath.length === 0;
      const tagMatches = String(semantic.tag || '') === String(targetSemantic.tag || '');
      const ordinalMatches = Number(semantic.ordinal || 0) === Number(targetSemantic.ordinal || 0);

      return ruleMatches && landmarkMatches && tagMatches && ordinalMatches;
    });

    if (!match) {
      limitations.push(`${slice.ruleId}: oracle snippet bound but not replay-confirmed`);
      continue;
    }
    findings.push(match);
  }

  return { findings, limitations };
}

/**
 * @param {Record<string, unknown>[]} violations
 * @param {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} bindings
 * @param {Record<string, unknown>[]} elements
 * @param {Set<string>} allowedRuleIds
 * @returns {Promise<{
 *   findings: Record<string, unknown>[],
 *   limitations: string[],
 * }>}
 */
export async function buildReplayConfirmedExpectedFromViolations(
  violations = [],
  bindings = [],
  elements = [],
  allowedRuleIds,
) {
  /** @type {Record<string, unknown>[]} */
  const findings = [];
  /** @type {string[]} */
  const limitations = [];
  const usedViolationIndexes = new Set();

  for (const binding of bindings) {
    const slice = /** @type {{ ruleId: string, sliceIndex?: number }} */ (binding.slice);
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
      return selectors.has(violationSelector);
    });

    if (violationIndex < 0) {
      limitations.push(`${slice.ruleId}: oracle snippet bound but not replay-confirmed`);
      continue;
    }

    usedViolationIndexes.add(violationIndex);
    const violation = violations[violationIndex];
    const report = ingestAccessScanReport({
      profile: 'commercial-parity',
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

  return { findings, limitations };
}

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} snapshot
 * @param {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} bindings
 * @param {Record<string, unknown>} reportContext
 * @returns {Promise<{
 *   findings: Record<string, unknown>[],
 *   limitations: string[],
 * }>}
 */
export async function buildReplayConfirmedExpectedFromBindings(page, snapshot, bindings, reportContext) {
  const { scanWithAccessScan } = await import('../../../src/scanner/access-scan/index.js');
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const expectedRuleFindings = bindings.map(({ slice }) => ({
    ruleId: slice.ruleId,
    canonicalRuleId: normalizeCorpusRuleId(String(slice.ruleId)),
  }));

  const profile = resolveScanProfile({ profile: reportContext.profile });
  const violations = await scanWithAccessScan(page, 'http://127.0.0.1/', {
    skipNavigation: true,
    profile,
    activateContent: false,
  });

  const relevantViolations = filterViolationsForExpectedRules(violations, {
    findings: expectedRuleFindings,
  });

  const catalogRuleIds = await resolveAllowedRuleIds();
  const oracleRuleIds = bindings.map(({ slice }) => String(slice.ruleId));
  const allowedRuleIds = new Set([...catalogRuleIds, ...oracleRuleIds]);

  const findings = await buildReplayFindingsFromSelectorBindings(
    relevantViolations,
    bindings,
    elements,
    allowedRuleIds,
    profile,
  );

  /** @type {string[]} */
  const limitations = [];
  for (const binding of bindings) {
    const slice = /** @type {{ ruleId: string }} */ (binding.slice);
    const selectors = new Set(
      [binding.element.selector, binding.element.reportSelector]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    const confirmed = findings.some((finding) => {
      const semantic = /** @type {{ semantic?: Record<string, unknown> }} */ (
        finding.element || {}
      ).semantic || {};
      const element = findSnapshotElementBySemantic(elements, semantic);
      if (!element) return false;
      const elementSelectors = new Set(
        [element.selector, element.reportSelector]
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      );
      return [...selectors].some((selector) => elementSelectors.has(selector));
    });
    if (!confirmed) {
      limitations.push(`${slice.ruleId}: oracle snippet bound but not replay-confirmed`);
    }
  }

  return { findings, limitations };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} pageHtml
 * @param {{ width: number, height: number }} viewport
 * @returns {Promise<Record<string, unknown>>}
 */
export async function captureStableSnapshotFromPageHtml(page, pageHtml, viewport) {
  const { installRuntimeHooks } = await import('../../../src/scanner/access-scan/runtime/index.js');
  await page.setViewportSize(viewport);
  await installRuntimeHooks(page);

  return captureStableSnapshot({
    captureState: 'initial',
    viewport,
    captureAdapter: async () => {
      await page.setContent(pageHtml, { waitUntil: 'domcontentloaded' });
      return captureLiveSnapshot(page, {
        viewport,
        captureState: 'initial',
        stabilityQuietMs: 500,
        stabilityTimeoutMs: 10000,
        stabilityMinObserveMs: 500,
      });
    },
  });
}

/**
 * @param {unknown} payload
 * @param {{
 *   profile?: string,
 *   route?: string,
 *   pageState?: string,
 *   viewport?: { width: number, height: number },
 * }=} options
 */
export async function buildEvidenceSliceCaseFromOracle(payload, options = {}) {
  const oracle = buildCorpusReportFromOracle(payload, options);
  const { slices, limitations: sliceLimitations } = buildUniqueAlignableSlices(oracle.report.findings);
  const pageHtml = buildEvidenceSlicePageHtml(slices);
  assertCommittedEvidenceNeutral({ 'page.html': pageHtml });

  const viewport = /** @type {{ width: number, height: number }} */ (oracle.report.viewport);
  ensurePlaywrightTempDir();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  /** @type {import('playwright').Page | null} */
  let page = null;

  try {
    page = await browser.newPage();
    const rawSnapshot = await captureStableSnapshotFromPageHtml(page, pageHtml, viewport);
    const normalizedSnapshot = normalizeCapturedSnapshot(rawSnapshot);
    const sanitizedSnapshot = sanitizeSnapshot(normalizedSnapshot);
    const stableHash = buildSnapshotIdentity(sanitizedSnapshot);

    const { bindings, limitations: bindingLimitations } = bindSlicesToSnapshotElements(
      sanitizedSnapshot,
      slices,
    );

    if (bindings.length === 0) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.NO_MATCH,
        'No oracle evidence snippets bound to replay slice snapshot elements',
        { limitations: [...sliceLimitations, ...bindingLimitations] },
      );
    }

    const sliceReport = {
      profile: oracle.report.profile,
      route: oracle.report.route,
      pageState: oracle.report.pageState,
      viewport: oracle.report.viewport,
      findings: bindings.map(({ slice, element }) => ({
        ruleId: slice.ruleId,
        violationType: 'confirmed',
        element: {
          outerHTML: String(element.outerHTML || ''),
          selector: String(element.selector || element.reportSelector || ''),
        },
      })),
    };

    const replayConfirmed = await buildReplayConfirmedExpectedFromBindings(
      page,
      sanitizedSnapshot,
      bindings,
      sliceReport,
    );

    if (replayConfirmed.findings.length === 0) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.NO_MATCH,
        'No oracle evidence snippets were replay-confirmed on the evidence slice',
        {
          limitations: [
            ...sliceLimitations,
            ...bindingLimitations,
            ...replayConfirmed.limitations,
          ],
        },
      );
    }

    const oracleDigest = buildOracleEvidenceDigest(oracle.report);

    return {
      pageHtml,
      snapshot: sanitizedSnapshot,
      expected: {
        schemaVersion: CORPUS_SCHEMA_VERSION,
        profile: sliceReport.profile,
        findings: replayConfirmed.findings,
      },
      captureHashes: [stableHash, stableHash],
      oracleDigest,
      limitations: [
        ...oracle.limitations,
        ...sliceLimitations,
        ...bindingLimitations,
        ...replayConfirmed.limitations,
      ],
      sliceCount: slices.length,
      alignedCount: replayConfirmed.findings.length,
      skippedAlignments: bindings.length - replayConfirmed.findings.length,
      viewport,
      profile: sliceReport.profile,
      route: sliceReport.route,
      pageState: sliceReport.pageState,
    };
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/**
 * @param {string} caseDir
 * @param {Record<string, unknown>} meta
 * @param {Record<string, unknown>} priorExpected
 * @returns {Promise<{
 *   pageHtml: string,
 *   snapshot: Record<string, unknown>,
 *   expected: Record<string, unknown>,
 *   captureHashes: string[],
 *   limitations: string[],
 *   alignedCount: number,
 * }>}
 */
export async function reprocessCommittedEvidenceSliceCase(caseDir, meta, priorExpected) {
  const pageHtmlPath = path.join(caseDir, 'page.html');
  const rawPageHtml = readFileSync(pageHtmlPath, 'utf8');
  const pageHtml = repseudonymizeEvidenceSlicePageHtml(rawPageHtml);
  const viewport = /** @type {{ width: number, height: number }} */ (meta.viewport);

  ensurePlaywrightTempDir();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  /** @type {import('playwright').Page | null} */
  let page = null;

  try {
    page = await browser.newPage();
    const rawSnapshot = await captureStableSnapshotFromPageHtml(page, pageHtml, viewport);
    const sanitizedSnapshot = sanitizeSnapshot(normalizeCapturedSnapshot(rawSnapshot));
    const stableHash = buildSnapshotIdentity(sanitizedSnapshot);

    const elements = Array.isArray(sanitizedSnapshot.elements) ? sanitizedSnapshot.elements : [];
    /** @type {Array<{ slice: Record<string, unknown>, element: Record<string, unknown> }>} */
    const bindings = [];

    for (const finding of Array.isArray(priorExpected.findings) ? priorExpected.findings : []) {
      const semantic = /** @type {Record<string, unknown> | undefined} */ (
        finding.element?.semantic
      );
      if (!semantic) continue;
      const element = elements.find((candidate) => {
        const built = buildSemanticFromSnapshotElement(elements, candidate);
        return built.tag === semantic.tag
          && Number(built.ordinal) === Number(semantic.ordinal)
          && JSON.stringify(built.landmarkPath) === JSON.stringify(semantic.landmarkPath || []);
      });
      if (!element) continue;
      bindings.push({
        slice: { ruleId: finding.ruleId || finding.canonicalRuleId },
        element,
      });
    }

    const sliceReport = {
      profile: priorExpected.profile,
      route: meta.route,
      pageState: meta.captureState,
      viewport,
    };

    const replayConfirmed = await buildReplayConfirmedExpectedFromBindings(
      page,
      sanitizedSnapshot,
      bindings,
      sliceReport,
    );

    if (replayConfirmed.findings.length === 0) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.NO_MATCH,
        'Reprocessed evidence slice lost replay-confirmed findings',
        { caseDir, limitations: replayConfirmed.limitations },
      );
    }

    return {
      pageHtml,
      snapshot: sanitizedSnapshot,
      expected: {
        schemaVersion: CORPUS_SCHEMA_VERSION,
        profile: priorExpected.profile,
        findings: replayConfirmed.findings,
      },
      captureHashes: [stableHash, stableHash],
      limitations: replayConfirmed.limitations,
      alignedCount: replayConfirmed.findings.length,
    };
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
