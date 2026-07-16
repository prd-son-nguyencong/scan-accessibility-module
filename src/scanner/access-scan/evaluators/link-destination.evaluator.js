import {
  getAncestors,
  getDescendants,
  hasNavigationAncestor,
} from '../runtime/graph-relationships.js';
import {
  normalizeText,
  elementFinding,
  getIndexes,
  getScanUrl,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'link-destination',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'link-navigation-ambiguous') {
      /** @type {Map<string, Set<string>>} */
      const textToHrefs = new Map();
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getLinkPurpose(snapshot, indexes, element);
        if (!purpose.text || purpose.text.length < 3) continue;
        const href = element.attributes.href || '';
        if (!textToHrefs.has(purpose.key)) textToHrefs.set(purpose.key, new Set());
        textToHrefs.get(purpose.key).add(href);
      }
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getLinkPurpose(snapshot, indexes, element);
        if (!purpose.text) continue;
        const hrefs = textToHrefs.get(purpose.key);
        if (!hrefs || hrefs.size <= 1) continue;
        findings.push(elementFinding(element, { duplicateText: purpose.text }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'link-navigation-ambiguous-parity') {
      /** @type {Map<string, Set<string>>} */
      const hrefsByPurpose = new Map();
      /** @type {Map<string, number>} */
      const occurrencesByPurpose = new Map();
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getGlobalLinkPurpose(element);
        if (purpose.length < 3 || !isGenericLinkPurpose(purpose)) continue;
        const hrefs = hrefsByPurpose.get(purpose) || new Set();
        hrefs.add(element.attributes.href || '');
        hrefsByPurpose.set(purpose, hrefs);
        occurrencesByPurpose.set(purpose, (occurrencesByPurpose.get(purpose) || 0) + 1);
      }

      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getGlobalLinkPurpose(element);
        if (!isGenericLinkPurpose(purpose)) continue;
        const distinctDestinations = hrefsByPurpose.get(purpose)?.size || 0;
        if (
          distinctDestinations <= 1
          || distinctDestinations !== occurrencesByPurpose.get(purpose)
        ) {
          continue;
        }
        findings.push(elementFinding(element, {
          structuralPattern: 'repeated-link-purpose-with-distinct-destinations',
          duplicateText: purpose,
        }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'link-current-page') {
      const pageUrl = getScanUrl(context);
      if (!pageUrl || pageUrl === 'about:blank' || pageUrl.startsWith('about:')) {
        return { status: 'inapplicable', candidatesScanned: 0, findings: [] };
      }

      let pageOrigin;
      let pagePath;
      try {
        const parsed = new URL(pageUrl);
        pageOrigin = parsed.origin;
        pagePath = normalizePath(parsed.pathname);
      } catch {
        return { status: 'inapplicable', candidatesScanned: 0, findings: [] };
      }

      for (const element of candidates) {
        const href = element.attributes.href || '';
        if (!href || href === '#' || href.startsWith('#')) continue;
        if (element.attributes['aria-current']) continue;
        if (!hasNavigationAncestor(snapshot, indexes, element)) continue;

        const resolved = resolveHref(href, pageUrl);
        if (!resolved) continue;
        if (resolved.origin !== pageOrigin) continue;
        if (resolved.pathname !== pagePath) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported link-destination mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getLinkPurpose(snapshot, indexes, element) {
  const text = normalizeText(
    element.accessibleName
    || element.attributes['aria-label']
    || element.visibleText
    || element.text
    || '',
  );
  const context = findLinkPurposeContext(snapshot, indexes, element);
  if (!context) return { key: text, text };

  return {
    key: `${text}::context-${context.id}`,
    text,
  };
}

/**
 * Link purpose may use the nearest list/card or a compact heading-labelled
 * content block. Page chrome and whole-document containers are not context.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function findLinkPurposeContext(snapshot, indexes, element) {
  return getAncestors(snapshot, indexes, element).find((ancestor) => {
    if (ancestor.tag === 'li' || ancestor.tag === 'article') return true;
    if (['html', 'body', 'main', 'header', 'nav', 'footer'].includes(ancestor.tag)) {
      return false;
    }
    const headings = getDescendants(
      snapshot,
      indexes,
      ancestor,
      (child) => /^h[1-6]$/.test(child.tag),
    );
    return headings.length === 1;
  }) || null;
}

/**
 * Commercial parity compares the authored link purpose globally rather than
 * incorporating card or list-item context.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getGlobalLinkPurpose(element) {
  return normalizeText(
    element.accessibleName
    || element.attributes['aria-label']
    || element.visibleText
    || element.text
    || '',
  );
}

/**
 * Commercial ambiguity findings target context-dependent action phrases, not
 * repeated descriptive names such as job titles or account destinations.
 *
 * @param {string} purpose
 */
function isGenericLinkPurpose(purpose) {
  return /^(?:(?:learn|read|view|see|find out|discover|explore)\s+(?:more|details)|(?:apply|view job|search jobs)(?:\s+now)?|more|details|click here|here)$/.test(
    purpose,
  );
}

/**
 * @param {string} href
 */
function isActionOnlyHref(href) {
  const value = href.trim().toLowerCase();
  return value === '' || value === '#' || value.startsWith('javascript:');
}

/**
 * @param {string} href
 * @param {string} pageUrl
 * @returns {{ origin: string, pathname: string } | null}
 */
function resolveHref(href, pageUrl) {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      origin: url.origin,
      pathname: normalizePath(url.pathname),
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 */
function normalizePath(value) {
  const trimmed = String(value || '').replace(/\/$/, '') || '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
