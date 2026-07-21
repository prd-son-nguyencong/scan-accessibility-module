import { normalizeHtml, normalizeSelector } from '../../../src/reporter/fingerprint.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { buildSemanticFromSnapshotElement } from './landmark.js';
import { sanitizeSemanticDescriptor } from './sanitize.js';

const ALIGNMENT_SCORE = {
  EXACT_SELECTOR: 100,
  EXACT_HTML: 100,
  SUFFIX_SELECTOR: 30,
  CONTAINS_SELECTOR: 10,
  HTML_CONTAINS: 15,
  TAG: 5,
};

const MIN_ACCEPT_SCORE = 55;
const MIN_CORROBORATION_FOR_WEAK = 2;
const MIN_HTML_CONTAINS_LENGTH = 8;

const GENERIC_SELECTOR_PARTS = new Set([
  'main', 'ul', 'ol', 'li', 'div', 'span', 'a', 'button', 'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
  'nav', 'header', 'footer', 'form', 'input', 'img', 'body', 'html',
]);

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {boolean}
 */
function pathsEqual(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * @param {string} html
 * @returns {string}
 */
function normalizeAlignmentHtml(html = '') {
  return normalizeHtml(String(html)).replace(
    /<([a-z][a-z0-9-]*)((?:\s[^>]*)?)\s*\/>/gi,
    (_, tag, attrs) => {
      const normalizedAttrs = String(attrs || '').replace(/\s+/g, ' ').trim();
      return normalizedAttrs.length > 0
        ? `<${tag} ${normalizedAttrs}></${tag}>`
        : `<${tag}></${tag}>`;
    },
  );
}

/**
 * @param {string} outerHTML
 * @returns {string}
 */
function extractTag(outerHTML = '') {
  const normalized = normalizeAlignmentHtml(outerHTML);
  const match = normalized.match(/^<\s*([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
function selectorParts(selector = '') {
  return normalizeSelector(selector)
    .split(/\s*(?:>|\+|~)\s*/)
    .map((part) => part.replace(/:(?:nth-[^:]+|first-child|last-child).*$/i, '').trim())
    .filter(Boolean);
}

/**
 * @param {string} selector
 * @returns {string}
 */
function canonicalizeStructuralSelector(selector = '') {
  return normalizeSelector(selector)
    .replace(/:nth-of-type\(\d+\)/gi, '')
    .replace(/:nth-child\(\d+\)/gi, '');
}

/**
 * @param {string} selector
 * @returns {boolean}
 */
function isGenericSelector(selector = '') {
  const normalized = canonicalizeStructuralSelector(selector);
  if (!normalized) return true;
  const parts = selectorParts(normalized);
  if (parts.length === 0) return true;
  if (parts.length > 2) return false;
  return parts.every((part) => GENERIC_SELECTOR_PARTS.has(part.toLowerCase()));
}

/**
 * @param {{
 *   score: number,
 *   exactSelector: boolean,
 *   exactHtml: boolean,
 * }} entry
 * @returns {[number, number, number]}
 */
function alignmentRank(entry) {
  return [
    entry.exactSelector ? 1 : 0,
    entry.exactHtml ? 1 : 0,
    entry.score,
  ];
}

/**
 * @param {{
 *   score: number,
 *   exactSelector: boolean,
 *   exactHtml: boolean,
 * }} left
 * @param {{
 *   score: number,
 *   exactSelector: boolean,
 *   exactHtml: boolean,
 * }} right
 * @returns {boolean}
 */
function ranksEqual(left, right) {
  const leftRank = alignmentRank(left);
  const rightRank = alignmentRank(right);
  return leftRank[0] === rightRank[0]
    && leftRank[1] === rightRank[1]
    && leftRank[2] === rightRank[2];
}

/**
 * @param {Record<string, unknown>} reportElement
 * @param {Record<string, unknown>} snapshotElement
 * @returns {{
 *   acceptable: boolean,
 *   score: number,
 *   exactSelector: boolean,
 *   exactHtml: boolean,
 * }}
 */
function evaluateAlignment(reportElement, snapshotElement) {
  const reportFramePath = Array.isArray(reportElement.framePath) ? reportElement.framePath : [];
  const reportShadowPath = Array.isArray(reportElement.shadowPath) ? reportElement.shadowPath : [];
  const snapshotFramePath = Array.isArray(snapshotElement.framePath) ? snapshotElement.framePath : [];
  const snapshotShadowPath = Array.isArray(snapshotElement.shadowPath) ? snapshotElement.shadowPath : [];

  if (!pathsEqual(reportFramePath, snapshotFramePath) || !pathsEqual(reportShadowPath, snapshotShadowPath)) {
    return {
      acceptable: false,
      score: -1,
      exactSelector: false,
      exactHtml: false,
    };
  }

  let score = 0;
  let corroboration = 0;
  let exactSelector = false;
  let exactHtml = false;

  const reportTag = extractTag(String(reportElement.outerHTML || ''));
  const snapshotTag = String(snapshotElement.tag || 'unknown').toLowerCase();
  const tagMatch = reportTag === snapshotTag;
  if (tagMatch) {
    score += ALIGNMENT_SCORE.TAG;
    corroboration += 1;
  }

  const reportSelector = canonicalizeStructuralSelector(String(reportElement.selector || ''));
  const snapshotSelector = canonicalizeStructuralSelector(
    String(snapshotElement.reportSelector || snapshotElement.selector || ''),
  );
  const genericSelector = isGenericSelector(String(reportElement.selector || ''));

  if (reportSelector && snapshotSelector) {
    if (reportSelector === snapshotSelector) {
      if (!genericSelector) {
        exactSelector = true;
        score += ALIGNMENT_SCORE.EXACT_SELECTOR;
        corroboration += 1;
      } else {
        score += ALIGNMENT_SCORE.TAG;
      }
    } else if (!genericSelector && !isGenericSelector(String(snapshotElement.reportSelector || snapshotElement.selector || ''))) {
      if (snapshotSelector.endsWith(reportSelector) || reportSelector.endsWith(snapshotSelector)) {
        score += ALIGNMENT_SCORE.SUFFIX_SELECTOR;
        corroboration += 1;
      } else if (snapshotSelector.includes(reportSelector) || reportSelector.includes(snapshotSelector)) {
        score += ALIGNMENT_SCORE.CONTAINS_SELECTOR;
        corroboration += 1;
      }
    }
  }

  const reportHtmlRaw = normalizeAlignmentHtml(String(reportElement.outerHTML || ''));
  const reportHtmlTruncated = reportHtmlRaw.endsWith('...');
  const reportHtml = reportHtmlTruncated
    ? reportHtmlRaw.slice(0, -3).trim()
    : reportHtmlRaw;
  const snapshotHtml = normalizeAlignmentHtml(String(snapshotElement.outerHTML || ''));
  const reportSelectorValue = String(reportElement.selector || '').trim();
  if (reportHtml && snapshotHtml) {
    if (reportHtml === snapshotHtml) {
      exactHtml = true;
      score += ALIGNMENT_SCORE.EXACT_HTML;
      corroboration += 1;
    } else if (
      reportHtml.length >= MIN_HTML_CONTAINS_LENGTH
      && (snapshotHtml.includes(reportHtml) || reportHtml.includes(snapshotHtml))
    ) {
      score += ALIGNMENT_SCORE.HTML_CONTAINS;
      corroboration += 1;
      if (!reportSelectorValue && reportHtml.includes(snapshotHtml)) {
        exactHtml = true;
        score += ALIGNMENT_SCORE.EXACT_HTML;
        corroboration += 1;
      }
    } else if (
      reportHtmlTruncated
      && reportHtml.length >= MIN_HTML_CONTAINS_LENGTH
      && snapshotHtml.startsWith(reportHtml)
    ) {
      exactHtml = true;
      score += ALIGNMENT_SCORE.EXACT_HTML;
      corroboration += 1;
    }
  }

  const hasStrongEvidence = exactSelector || exactHtml;
  const acceptable = hasStrongEvidence
    || (
      !genericSelector
      && tagMatch
      && score >= MIN_ACCEPT_SCORE
      && corroboration >= MIN_CORROBORATION_FOR_WEAK
    );

  return {
    acceptable,
    score: acceptable ? score : 0,
    exactSelector,
    exactHtml,
  };
}

/**
 * @param {{
 *   element: Record<string, unknown>,
 *   score: number,
 *   exactSelector: boolean,
 *   exactHtml: boolean,
 * }} left
 * @param {{
 *   element: Record<string, unknown>,
 *   score: number,
 *   exactSelector: boolean,
 *   exactHtml: boolean,
 * }} right
 * @returns {number}
 */
function compareAlignmentCandidates(left, right) {
  if (left.exactSelector !== right.exactSelector) {
    return left.exactSelector ? -1 : 1;
  }
  if (left.exactHtml !== right.exactHtml) {
    return left.exactHtml ? -1 : 1;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return Number(left.element.id) - Number(right.element.id);
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {Record<string, unknown>} reportFinding
 * @returns {Record<string, unknown>}
 */
export function alignFindingToSnapshot(snapshot, reportFinding) {
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const reportElement = /** @type {Record<string, unknown>} */ (
    reportFinding.element && typeof reportFinding.element === 'object'
      ? reportFinding.element
      : {}
  );

  /** @type {{
   *   element: Record<string, unknown>,
   *   score: number,
   *   exactSelector: boolean,
   *   exactHtml: boolean,
   * }[]} */
  const scored = [];
  for (const element of elements) {
    const evaluation = evaluateAlignment(
      reportElement,
      /** @type {Record<string, unknown>} */ (element),
    );
    if (evaluation.acceptable && evaluation.score >= 0) {
      scored.push({
        element: /** @type {Record<string, unknown>} */ (element),
        score: evaluation.score,
        exactSelector: evaluation.exactSelector,
        exactHtml: evaluation.exactHtml,
      });
    }
  }

  if (scored.length === 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.NO_MATCH,
      'No snapshot element matched report finding with sufficient semantic evidence',
      { selector: reportElement.selector || null },
    );
  }

  scored.sort(compareAlignmentCandidates);
  const best = scored[0];
  const ties = scored.filter((entry) => ranksEqual(entry, best));

  if (ties.length > 1) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.AMBIGUOUS_ALIGNMENT,
      'Multiple snapshot elements matched report finding with equal evidence',
      {
        selector: reportElement.selector || null,
        candidateIds: ties.map((entry) => entry.element.id),
      },
    );
  }

  const semantic = sanitizeSemanticDescriptor(
    buildSemanticFromSnapshotElement(elements, best.element),
  );

  return {
    ruleId: reportFinding.ruleId,
    canonicalRuleId: reportFinding.canonicalRuleId,
    violationType: reportFinding.violationType || 'confirmed',
    evidence: reportFinding.evidence || {},
    element: {
      semantic,
    },
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {Record<string, unknown>[]} reportFindings
 * @returns {Record<string, unknown>[]}
 */
export function alignFindingsToSnapshot(snapshot, reportFindings = []) {
  return reportFindings.map((finding) => alignFindingToSnapshot(snapshot, finding));
}

/**
 * Align oracle findings while recording non-fatal alignment gaps for seeding.
 *
 * @param {Record<string, unknown>} snapshot
 * @param {Record<string, unknown>[]} reportFindings
 * @returns {{
 *   aligned: Record<string, unknown>[],
 *   limitations: string[],
 *   skipped: number,
 * }}
 */
export function alignFindingsToSnapshotPartial(snapshot, reportFindings = []) {
  /** @type {Record<string, unknown>[]} */
  const aligned = [];
  /** @type {string[]} */
  const limitations = [];
  let skipped = 0;

  for (const finding of reportFindings) {
    try {
      aligned.push(alignFindingToSnapshot(snapshot, finding));
    } catch (error) {
      if (
        error instanceof CorpusToolingError
        && (
          error.errorCode === CORPUS_TOOLING_ERROR_CODES.NO_MATCH
          || error.errorCode === CORPUS_TOOLING_ERROR_CODES.AMBIGUOUS_ALIGNMENT
        )
      ) {
        skipped += 1;
        const ruleId = String(finding.ruleId || finding.canonicalRuleId || 'unknown-rule');
        limitations.push(`${ruleId}: ${error.message}`);
        continue;
      }
      throw error;
    }
  }

  if (aligned.length === 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.NO_MATCH,
      'No oracle findings aligned to the stable runtime snapshot',
      { skipped, limitations },
    );
  }

  return { aligned, limitations, skipped };
}
