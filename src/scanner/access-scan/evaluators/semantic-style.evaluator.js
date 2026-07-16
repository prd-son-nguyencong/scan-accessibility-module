import { getDescendants, hasAncestor, getAncestors } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSemanticSubtreeText,
  getSnapshot,
  hasAccessibleName,
  hasLineThroughDecoration,
  isBoldStyle,
  isFocusableControl,
  isItalicStyle,
  parseStylePx,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'semantic-style',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'strong-mismatch') {
      for (const element of candidates) {
        if (element.tag !== 'span' || element.attributes.role) continue;
        if (!(element.text.trim() || element.visibleText.trim()) || !isBoldStyle(element)) continue;
        if (hasAncestor(snapshot, indexes, element, (ancestor) => /^h[1-6]$/.test(ancestor.tag))) continue;
        if (hasAncestor(snapshot, indexes, element, isInteractiveAncestor)) continue;
        if (hasHeadingStyleToken(element)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'emphasis-mismatch') {
      for (const element of candidates) {
        if (element.tag !== 'span' || element.attributes.role) continue;
        if (!(element.text.trim() || element.visibleText.trim()) || !isItalicStyle(element)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'visibility-misuse') {
      /** @type {Map<number, {
       *   element: import('../runtime/types.js').SnapshotElement,
       *   visibilityReason: string,
       * }>} */
      const qualifyingById = new Map();
      for (const element of candidates) {
        if (element.hiddenFromAT || element.attributes['aria-hidden'] === 'true') continue;
        if (element.attributes.hidden !== undefined) continue;
        const style = element.computedStyle;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const visibilityReason = getAuthorVisibilityHidingReason(element);
        if (!visibilityReason) continue;
        const owner = getVisibilityHidingOwner(snapshot, indexes, element, visibilityReason);
        const text = getSemanticSubtreeText(snapshot, indexes, owner);
        if (!text || text.length < 3) continue;
        qualifyingById.set(owner.id, { element: owner, visibilityReason });
      }

      const qualifying = [...qualifyingById.values()];
      for (const { element, visibilityReason } of qualifying) {
        if (hasAncestor(snapshot, indexes, element, (ancestor) => (
          qualifyingById.has(ancestor.id)
        ))) {
          continue;
        }
        findings.push(elementFinding(element, {
          visibilityReason,
        }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'visibility-mismatch') {
      for (const element of candidates) {
        if (element.attributes['aria-hidden'] !== 'true') continue;
        if (!element.rendered || element.rect.width <= 0 || element.rect.height <= 0) continue;
        if (hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.attributes['aria-hidden'] === 'true')) {
          continue;
        }
        if (getAncestorsWithAccessibleName(snapshot, indexes, element)) continue;
        if (isDecorativeAriaHiddenContainer(snapshot, indexes, element)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'breadcrumbs-nav') {
      for (const element of candidates) {
        const label = (element.attributes['aria-label'] || '').toLowerCase();
        if (!label.includes('breadcrumb')) continue;
        const hasOrderedList = getDescendants(snapshot, indexes, element, (child) => child.tag === 'ol').length > 0;
        if (hasOrderedList) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'sale-price-discernible') {
      for (const element of candidates) {
        if (!(element.text.trim() || element.visibleText.trim())) continue;
        const tagged = element.tag === 'del' || element.tag === 's' || element.tag === 'strike';
        const styled = hasLineThroughDecoration(element);
        if (!tagged && !styled) continue;
        if (element.attributes['aria-label']?.trim()) continue;
        if (hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.attributes['aria-label']?.trim())) {
          continue;
        }
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'link-anchor-ambiguous') {
      for (const element of candidates) {
        const href = element.attributes.href ?? '';
        const isAmbiguousHref = href === '' || href === '#';
        if (!isAmbiguousHref || element.attributes.role) continue;
        if (element.attributes['aria-hidden'] === 'true') continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported semantic-style mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isInteractiveAncestor(element) {
  return (
    element.tag === 'a'
    || element.tag === 'button'
    || ['button', 'link', 'tab'].includes(element.attributes.role || '')
  );
}

/**
 * Visual heading utility tokens indicate heading semantics rather than strong
 * emphasis. This checks portable token shapes, not site-specific class names.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function hasHeadingStyleToken(element) {
  const className = element.attributes.class || '';
  return /(?:^|\s)(?:h[1-6]|heading(?:[-_][1-6])?)(?:\s|$)/i.test(className);
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 * @returns {string | null}
 */
function getAuthorVisibilityHidingReason(element) {
  const style = element.computedStyle;
  const effectiveOpacity = Number.isFinite(element.effectiveOpacity)
    ? element.effectiveOpacity
    : Number.parseFloat(style.opacity || '1');

  if (effectiveOpacity <= 0.1) {
    return 'opacity';
  }

  const clip = style.clip || '';
  const clipPath = style.clipPath || '';
  if (
    (clip && clip !== 'auto' && clip !== 'none')
    || isCollapsingClipPath(clipPath)
  ) {
    return 'clip';
  }

  const position = style.position || '';
  if (['absolute', 'fixed', 'sticky'].includes(position)) {
    const left = parseStylePx(style.left);
    const top = parseStylePx(style.top);
    const right = parseStylePx(style.right);
    const bottom = parseStylePx(style.bottom);
    if (left <= -5000 || top <= -5000 || right <= -5000 || bottom <= -5000) {
      return 'offscreen-positioned';
    }
  }

  if (element.rect.width <= 0 || element.rect.height <= 0) {
    return 'zero-geometry';
  }

  return null;
}

/**
 * Effective opacity includes ancestors. Report the element that applies the
 * opacity instead of duplicating the same hidden subtree on each descendant.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 * @param {string} visibilityReason
 */
function getVisibilityHidingOwner(snapshot, indexes, element, visibilityReason) {
  if (visibilityReason !== 'opacity') return element;
  const ownOpacity = Number.parseFloat(element.computedStyle.opacity || '1');
  if (ownOpacity <= 0.1) return element;
  return getAncestors(snapshot, indexes, element).find((ancestor) => {
    const opacity = Number.parseFloat(ancestor.computedStyle.opacity || '1');
    return Number.isFinite(opacity) && opacity < 1;
  }) || element;
}

/**
 * A clip path can crop decoration without hiding the element. Treat only
 * commonly collapsed shapes as visually hidden; arbitrary non-empty polygons
 * require manual visual review rather than a visibility finding.
 *
 * @param {string} value
 */
function isCollapsingClipPath(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'none') return false;
  if (/^(?:circle|ellipse)\(\s*0(?:px|%|em|rem)?(?:\s|at|\))/.test(normalized)) {
    return true;
  }
  if (/^inset\(\s*(?:50|100)%(?:\s+(?:50|100)%){0,3}\s*\)/.test(normalized)) {
    return true;
  }
  if (normalized.startsWith('polygon(')) {
    const points = normalized
      .slice('polygon('.length, -1)
      .split(',')
      .map((point) => point.trim())
      .filter(Boolean);
    return points.length >= 3 && new Set(points).size === 1;
  }
  return false;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getAncestorsWithAccessibleName(snapshot, indexes, element) {
  return getAncestors(snapshot, indexes, element).find(
    (parent) => (
      (parent.tag === 'a' || parent.tag === 'button' || parent.attributes.role === 'button')
      && hasAccessibleName(parent)
    ),
  ) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isDecorativeAriaHiddenContainer(snapshot, indexes, element) {
  if (hasMeaningfulVisibleText(snapshot, indexes, element)) {
    return false;
  }
  if (getDescendants(snapshot, indexes, element, (child) => isFocusableControl(child)).length > 0) {
    return false;
  }
  if (getDescendants(snapshot, indexes, element, (child) => hasInformativeGraphic(child)).length > 0) {
    return false;
  }
  if (hasInformativeGraphic(element)) {
    return false;
  }
  if (hasAccessibleName(element)) {
    return false;
  }
  return true;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function hasMeaningfulVisibleText(snapshot, indexes, element) {
  const ownText = (element.visibleText || element.text || '').trim();
  if (ownText.length >= 3) {
    return true;
  }
  return getDescendants(snapshot, indexes, element, (child) => {
    if (!child.rendered) return false;
    const text = (child.visibleText || child.text || '').trim();
    return text.length >= 3;
  }).length > 0;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function hasInformativeGraphic(element) {
  if (element.tag === 'img') {
    const alt = element.attributes.alt ?? '';
    if (alt.trim().length > 0 && alt.trim().toLowerCase() !== 'image') {
      return true;
    }
    return false;
  }
  if (element.attributes.role === 'img' && hasAccessibleName(element)) {
    return true;
  }
  if (element.tag === 'svg' && element.attributes.role === 'img' && hasAccessibleName(element)) {
    return true;
  }
  return false;
}
