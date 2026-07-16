import { hasNavigationAncestor } from '../runtime/graph-relationships.js';
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
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'link-navigation-ambiguous') {
      /** @type {Map<string, Set<string>>} */
      const textToHrefs = new Map();
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const text = getLinkPurposeText(element);
        if (!text || text.length < 3) continue;
        const href = element.attributes.href || '';
        if (!textToHrefs.has(text)) textToHrefs.set(text, new Set());
        textToHrefs.get(text).add(href);
      }
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const text = getLinkPurposeText(element);
        if (!text) continue;
        const hrefs = textToHrefs.get(text);
        if (!hrefs || hrefs.size <= 1) continue;
        findings.push(elementFinding(element, { duplicateText: text }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'link-current-page') {
      const indexes = getIndexes(context);
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
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getLinkPurposeText(element) {
  return normalizeText(
    element.accessibleName
    || element.attributes['aria-label']
    || element.visibleText
    || element.text
    || '',
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
