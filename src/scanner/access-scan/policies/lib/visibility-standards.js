import {
  getDescendants, getAncestors, sameScope, hasAncestor,
} from '../../runtime/graph-relationships.js';
import {
  hasAccessibleName, isFocusableControl, normalizeText,
} from '../../evaluators/lib/runtime-context.js';

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
export function getAncestorsWithAccessibleName(snapshot, indexes, element) {
  return getAncestors(snapshot, indexes, element).find(
    (parent) => (
      (parent.tag === 'a' || parent.tag === 'button' || parent.attributes.role === 'button')
      && hasAccessibleName(parent)
    ),
  ) || null;
}

/**
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
export function hasEquivalentExposedGraphic(indexes, element) {
  if (element.tag !== 'img' || element.parentId == null) return false;
  const alt = normalizeText(element.attributes.alt || '');
  if (!alt) return false;

  return (indexes.childrenByParentId.get(element.parentId) || []).some((sibling) => (
    sibling.id !== element.id
    && sibling.tag === 'img'
    && sameScope(sibling, element)
    && sibling.attributes['aria-hidden'] !== 'true'
    && !sibling.hiddenFromAT
    && normalizeText(sibling.attributes.alt || '') === alt
  ));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
export function hasInformativeGraphic(element) {
  if (element.tag === 'img') {
    const alt = element.attributes.alt ?? '';
    if (alt.trim().length > 0 && alt.trim().toLowerCase() !== 'image') {
      return true;
    }
    return false;
  }
  if (element.tag === 'svg') {
    return element.rendered && element.rect.width > 0 && element.rect.height > 0;
  }
  return false;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
export function hasMeaningfulVisibleText(snapshot, indexes, element) {
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
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
export function isDecorativeAriaHiddenContainer(snapshot, indexes, element) {
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
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
export function qualifiesVisibilityMismatch(snapshot, indexes, element) {
  if (element.attributes['aria-hidden'] !== 'true') return false;
  if (!element.rendered || element.rect.width <= 0 || element.rect.height <= 0) return false;
  if (element.effectiveOpacity <= 0.1) return false;
  if (hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.attributes['aria-hidden'] === 'true')) {
    return false;
  }
  if (hasEquivalentExposedGraphic(indexes, element)) return false;
  if (getAncestorsWithAccessibleName(snapshot, indexes, element)) return false;
  if (isDecorativeAriaHiddenContainer(snapshot, indexes, element)) return false;
  return true;
}
