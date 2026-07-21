import { queryGraph, validateGraphSelector } from '../../runtime/graph-query.js';
import { filterByEligibility } from '../../runtime/eligibility.js';
import {
  buildSnapshotIndexes,
  getDescendants,
} from '../../runtime/graph-relationships.js';

/**
 * @typedef {import('../../runtime/types.js').Snapshot} Snapshot
 * @typedef {import('../../runtime/types.js').SnapshotElement} SnapshotElement
 * @typedef {import('../../engine/schema.js').RuleCheckDescriptor} RuleCheckDescriptor
 */

/**
 * @param {SnapshotElement[]} elements
 * @param {string[]=} roots
 */
export function filterByRoots(elements, roots) {
  if (!roots?.length || roots.includes('all')) {
    return elements;
  }
  return elements.filter((element) => {
    for (const root of roots) {
      if (root === 'document' && element.framePath.length === 0 && element.shadowPath.length === 0) {
        return true;
      }
      if (root === 'shadow' && element.shadowPath.length > 0) {
        return true;
      }
      if (root === 'frame' && element.framePath.length > 0) {
        return true;
      }
    }
    return false;
  });
}

/**
 * @param {unknown} context
 * @returns {Snapshot}
 */
export function getSnapshot(context) {
  if (
    !context
    || typeof context !== 'object'
    || !('snapshot' in context)
    || !/** @type {{ snapshot?: Snapshot }} */ (context).snapshot
  ) {
    throw Object.assign(new Error('Evaluator requires context.snapshot'), {
      errorCode: 'evaluator_failure',
    });
  }
  return /** @type {{ snapshot: Snapshot }} */ (context).snapshot;
}

/**
 * @param {unknown} context
 * @returns {ReturnType<typeof buildSnapshotIndexes>}
 */
export function getIndexes(context) {
  const snapshot = getSnapshot(context);
  const existing = /** @type {{
    indexes?: ReturnType<typeof buildSnapshotIndexes>,
    indexesSnapshot?: Snapshot,
  }} */ (context);
  if (existing.indexes && existing.indexesSnapshot === snapshot) {
    return existing.indexes;
  }
  const indexes = buildSnapshotIndexes(snapshot);
  if (context && typeof context === 'object') {
    existing.indexes = indexes;
    existing.indexesSnapshot = snapshot;
  }
  return indexes;
}

/**
 * @param {unknown} context
 * @param {RuleCheckDescriptor} check
 * @returns {SnapshotElement[]}
 */
export function queryCandidates(context, check) {
  const snapshot = getSnapshot(context);
  const selector = check.target?.selector || '*';
  const allowPluginFallback = Boolean(check.target?.allowPluginFallback);

  if (selector !== '*' && !allowPluginFallback) {
    const validation = validateGraphSelector(selector);
    if (!validation.valid) {
      throw Object.assign(new Error(validation.diagnostic.message), {
        errorCode: 'selector_unsupported',
      });
    }
  }

  /** @type {import('../../runtime/graph-query.js').SelectorDiagnostic[]} */
  const diagnostics = [];
  const queryResult = queryGraph(snapshot, selector, { diagnostics });
  const matches = Array.isArray(queryResult) ? queryResult : queryResult.matches;

  if (!allowPluginFallback && diagnostics.length > 0) {
    throw Object.assign(new Error(diagnostics[0].message), {
      errorCode: 'selector_unsupported',
    });
  }

  const rooted = filterByRoots(matches, check.target?.roots);
  const visibility = check.eligibility?.visibility || 'active-content';
  return filterByEligibility(rooted, { visibility });
}

/**
 * @param {SnapshotElement} element
 * @param {Record<string, unknown>=} evidence
 */
export function elementFinding(element, evidence = {}) {
  return {
    element: {
      outerHTML: element.outerHTML,
      selector: element.selector,
      framePath: [...element.framePath],
      shadowPath: [...element.shadowPath],
    },
    evidence,
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * @param {SnapshotElement} element
 * @returns {boolean}
 */
export function hasAccessibleName(element) {
  return Boolean(element.accessibleName && element.accessibleName.trim());
}

/**
 * @param {unknown} context
 * @returns {Record<string, unknown>}
 */
export function getEvaluatorCache(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const bag = /** @type {{ evaluatorCache?: Record<string, unknown> }} */ (context);
  if (!bag.evaluatorCache) {
    bag.evaluatorCache = {};
  }
  return bag.evaluatorCache;
}

/**
 * @param {unknown} context
 * @returns {import('../../runtime/session.js').createScanSession extends (...args: never) => Promise<infer S> ? S : never}
 */
export function getSession(context) {
  if (!context || typeof context !== 'object' || !('session' in context)) {
    throw Object.assign(new Error('Behavioral evaluator requires context.session'), {
      errorCode: 'evaluator_failure',
    });
  }
  return /** @type {{ session: ReturnType<typeof getSession> }} */ (context).session;
}

/**
 * @param {unknown} context
 * @returns {string | null}
 */
export function getScanUrl(context) {
  if (context && typeof context === 'object' && 'session' in context) {
    const session = /** @type {{ session?: { url?: string } }} */ (context).session;
    if (session?.url) return session.url;
  }
  if (context && typeof context === 'object' && 'url' in context) {
    const url = /** @type {{ url?: string }} */ (context).url;
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

/**
 * Accessible subtree text for landmark and semantic intent checks.
 * Prefers accessibleName, then direct text and AT-exposed descendant text.
 *
 * @param {Snapshot} snapshot
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {SnapshotElement} element
 */
export function getSemanticSubtreeText(snapshot, indexes, element) {
  if (element.accessibleName?.trim()) {
    return element.accessibleName.trim();
  }

  /** @type {string[]} */
  const parts = [];
  if (element.text?.trim()) {
    parts.push(element.text.trim());
  }

  for (const child of getDescendants(snapshot, indexes, element, (candidate) => (
    candidate.attributes['aria-hidden'] !== 'true' && !candidate.hiddenFromAT
  ))) {
    if (child.accessibleName?.trim()) {
      parts.push(child.accessibleName.trim());
      continue;
    }
    if (child.text?.trim()) {
      parts.push(child.text.trim());
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 * @returns {number}
 */
export function parseStylePx(value) {
  const parsed = Number.parseFloat(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function isBoldStyle(element) {
  const weight = element.computedStyle.fontWeight || '';
  if (weight === 'bold' || weight === 'bolder') return true;
  const numeric = Number.parseInt(weight, 10);
  return Number.isFinite(numeric) && numeric >= 700;
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function isItalicStyle(element) {
  return (element.computedStyle.fontStyle || '') === 'italic';
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function hasLineThroughDecoration(element) {
  const decoration = element.computedStyle.textDecoration || '';
  return decoration.includes('line-through');
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function isFocusableControl(element) {
  if (!element.focusable || element.hiddenFromAT) return false;
  const tag = element.tag;
  const role = element.attributes.role;
  return (
    tag === 'a'
    || tag === 'button'
    || tag === 'input'
    || tag === 'select'
    || tag === 'textarea'
    || tag === 'summary'
    || role === 'button'
    || role === 'link'
    || role === 'tab'
    || role === 'menuitem'
  );
}
