import {
  getAncestors,
  getDescendants,
  hasAncestor,
  sameScope,
} from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSemanticSubtreeText,
  getSnapshot,
  normalizeText,
  queryCandidates,
} from './lib/runtime-context.js';

const FOOTER_HINT_PATTERNS = [
  /\bcopyright\b/i,
  /©/,
  /\ball rights\b/i,
  /\bprivacy(?: policy)?\b/i,
  /\bterms of (?:use|service)\b/i,
  /\bcookie (?:policy|settings)\b/i,
  /\blegal notice\b/i,
  /\bsitemap\b/i,
  /\bcontact us\b/i,
];
const STRONG_FOOTER_MARKER_PATTERNS = [/\bcopyright\b/i, /©/, /\ball rights\b/i];

const EXCLUDED_BODY_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'noscript', 'template',
]);

const EXCLUDED_CHROME_TAGS = new Set(['header', 'footer', 'nav']);
const EXCLUDED_CHROME_ROLES = new Set(['banner', 'contentinfo', 'navigation']);

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isMainLandmark(element) {
  return element.tag === 'main' || element.attributes.role === 'main';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isFooterLandmark(element) {
  return element.tag === 'footer' || element.attributes.role === 'contentinfo';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isExcludedChrome(element) {
  return EXCLUDED_CHROME_TAGS.has(element.tag)
    || EXCLUDED_CHROME_ROLES.has(element.attributes.role || '');
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isSubstantialRegion(snapshot, indexes, element) {
  if (element.attributes['aria-hidden'] === 'true' || element.hiddenFromAT) return false;
  if (EXCLUDED_BODY_TAGS.has(element.tag)) return false;
  if (isExcludedChrome(element)) return false;
  return getSemanticSubtreeText(snapshot, indexes, element).length > 50;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function containsOnlyChromeContent(snapshot, indexes, element) {
  const chrome = getDescendants(snapshot, indexes, element, isExcludedChrome);
  if (chrome.length === 0) return false;

  const textOutsideChrome = getDescendants(snapshot, indexes, element, (child) => {
    if (EXCLUDED_BODY_TAGS.has(child.tag)) return false;
    if (!normalizeText(child.text || child.visibleText || '')) return false;
    return !hasAncestor(snapshot, indexes, child, (ancestor) => (
      ancestor.id !== element.id && isExcludedChrome(ancestor)
    ));
  });
  return textOutsideChrome.length === 0;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isInsideMainLandmark(snapshot, indexes, element) {
  return hasAncestor(snapshot, indexes, element, isMainLandmark);
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} body
 */
function getDirectBodyChildren(snapshot, indexes, body) {
  return snapshot.elements.filter((element) => (
    element.parentId === body.id && sameScope(element, body)
  ));
}

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'landmark-graph',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'navigation-misuse') {
      for (const element of candidates) {
        const links = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'a' && Boolean(child.attributes.href)
        ));
        if (!element.rendered && links.length > 0) continue;
        if (links.length === 0) {
          findings.push(elementFinding(element, { issue: 'no-links' }));
          continue;
        }
        const unlistedLinks = links.filter((link) => (
          !getAncestors(snapshot, indexes, link)
            .some((ancestor) => (
              ancestor.id !== element.id
              && (ancestor.tag === 'ul' || ancestor.tag === 'ol')
            ))
        ));
        if (unlistedLinks.length > 0) {
          findings.push(elementFinding(element, {
            issue: 'links-outside-list-structure',
            unlistedLinkCount: unlistedLinks.length,
          }));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'search-form-mismatch') {
      for (const element of candidates) {
        if (element.tag === 'search' || element.attributes.role === 'search') continue;
        const searchInput = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'input'
          && (child.attributes.type === 'search' || child.attributes.role === 'searchbox')
        ));
        if (searchInput.length === 0) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'region-footer-misuse') {
      for (const element of candidates) {
        const text = getSemanticSubtreeText(snapshot, indexes, element);
        const links = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'a' && Boolean(child.attributes.href)
        ));
        if (containsFooterHint(text) || links.length >= 2) continue;
        findings.push(elementFinding(element, { issue: 'contentinfo-without-global-information' }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'region-footer-single') {
      const footers = snapshot.elements.filter(isFooterLandmark);
      for (let index = 1; index < footers.length; index += 1) {
        findings.push(elementFinding(footers[index], { duplicateCount: footers.length }));
      }
      return { status: 'complete', candidatesScanned: footers.length, findings };
    }

    if (mode === 'region-footer-mismatch') {
      let scanned = 0;
      for (const body of candidates) {
        const outsideGlobalInformation = getDescendants(snapshot, indexes, body, (element) => {
          scanned += 1;
          if (!element.rendered || element.hiddenFromAT || isFooterLandmark(element)) return false;
          if (hasAncestor(snapshot, indexes, element, isFooterLandmark)) return false;
          return containsStrongFooterMarker(element.text || element.visibleText || '');
        });
        for (const element of outsideGlobalInformation) {
          findings.push(elementFinding(element, {
            issue: 'global-information-outside-contentinfo',
          }));
        }
      }
      return { status: 'complete', candidatesScanned: scanned, findings };
    }

    if (mode === 'article-misuse') {
      for (const element of candidates) {
        const hasHeading = getDescendants(snapshot, indexes, element, (child) => (
          /^h[1-6]$/.test(child.tag)
        )).length > 0;
        const textLength = getSemanticSubtreeText(snapshot, indexes, element).length;
        if (hasHeading || textLength >= 50) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'breadcrumbs-mismatch') {
      for (const element of candidates) {
        const hasBreadcrumbStructure = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'ol'
        )).length > 0;
        const label = element.attributes['aria-label'] || element.attributes['aria-labelledby'];
        if (!hasBreadcrumbStructure) continue;
        if (label?.trim()) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'region-main-single') {
      const mains = snapshot.elements.filter(isMainLandmark);
      for (let index = 1; index < mains.length; index += 1) {
        findings.push(elementFinding(mains[index], { duplicateCount: mains.length }));
      }
      return { status: 'complete', candidatesScanned: mains.length, findings };
    }

    if (mode === 'region-main-misuse') {
      for (const element of candidates) {
        const nestedInMain = hasAncestor(snapshot, indexes, element, isMainLandmark);
        const hasHeading = getDescendants(snapshot, indexes, element, (child) => (
          /^h[1-6]$/.test(child.tag)
        )).length > 0;
        const textLength = getSemanticSubtreeText(snapshot, indexes, element).length;
        if (nestedInMain || (textLength < 50 && !hasHeading)) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'region-main-mismatch') {
      const bodies = snapshot.elements.filter((element) => element.tag === 'body');
      let scanned = 0;
      for (const body of bodies) {
        const scopedMains = snapshot.elements.filter((element) => (
          isMainLandmark(element) && sameScope(element, body)
        ));
        const children = getDirectBodyChildren(snapshot, indexes, body);
        scanned += children.length;
        for (const element of children) {
          if (isMainLandmark(element)) continue;
          if (scopedMains.some((main) => (
            main.id === element.id || hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.id === main.id)
          ))) continue;
          if (containsOnlyChromeContent(snapshot, indexes, element)) continue;
          if (!isSubstantialRegion(snapshot, indexes, element)) continue;
          if (scopedMains.length > 0 && isInsideMainLandmark(snapshot, indexes, element)) continue;
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: scanned, findings };
    }

    throw Object.assign(new Error(`unsupported landmark-graph mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {string} value
 */
function containsFooterHint(value) {
  return FOOTER_HINT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * @param {string} value
 */
function containsStrongFooterMarker(value) {
  return STRONG_FOOTER_MARKER_PATTERNS.some((pattern) => pattern.test(value));
}
