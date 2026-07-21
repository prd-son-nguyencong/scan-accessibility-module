import { sameScope } from '../../runtime/graph-relationships.js';
import { normalizeText, parseStylePx, isFocusableControl } from '../../evaluators/lib/runtime-context.js';

function isActiveContent(element) {
  return element.rendered && !element.hiddenFromAT;
}

/**
 * Top-anchored headers additionally require nonzero geometry for visual relevance.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isVisuallyAnchoredHeader(element) {
  return isActiveContent(element) && element.rect.width > 0 && element.rect.height > 0;
}

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

function isBanner(element) {
  return element.tag === 'header' || element.attributes.role === 'banner';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isNavLandmark(element) {
  return element.tag === 'nav' || element.attributes.role === 'navigation';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isSearchLandmark(element) {
  return element.tag === 'search' || element.attributes.role === 'search';
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function hasEquivalentRect(left, right) {
  return (
    Math.abs(left.rect.x - right.rect.x) <= 2
    && Math.abs(left.rect.y - right.rect.y) <= 2
    && Math.abs(left.rect.width - right.rect.width) <= 2
    && Math.abs(left.rect.height - right.rect.height) <= 2
  );
}

/**
 * @param {string} value
 */

function isTransparentColor(value) {
  return (
    !value
    || value === 'transparent'
    || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(value)
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {import('../runtime/types.js').SnapshotElement} scopeElement
 */

function findScopedBody(snapshot, scopeElement) {
  return snapshot.elements.find((element) => (
    element.tag === 'body'
    && element.framePath.length === scopeElement.framePath.length
    && element.framePath.every((segment, index) => segment === scopeElement.framePath[index])
    && element.shadowPath.length === 0
  )) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {import('../runtime/types.js').SnapshotElement} scopeElement
 */

function findScopedTitle(snapshot, scopeElement) {
  return snapshot.elements.find((element) => (
    element.tag === 'title'
    && element.framePath.length === scopeElement.framePath.length
    && element.framePath.every((segment, index) => segment === scopeElement.framePath[index])
    && element.shadowPath.length === 0
  )) || null;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function getScopedChildren(indexes, parent, scopeElement) {
  return (indexes.childrenByParentId.get(parent.id) || [])
    .filter((child) => sameScope(child, scopeElement));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} button
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function dedupeElements(elements) {
  const seen = new Set();
  return elements.filter((element) => {
    if (seen.has(element.id)) return false;
    seen.add(element.id);
    return true;
  });
}

/**
 * @param {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[] }>} groups
 */

function dedupeGroups(groups) {
  const accepted = [];
  const acceptedTriggerIds = [];
  for (const group of groups) {
    const triggerIds = new Set(group.triggers.map((trigger) => trigger.id));
    const overlaps = acceptedTriggerIds.some((ids) => [...triggerIds].some((id) => ids.has(id)));
    if (overlaps) continue;
    accepted.push(group);
    acceptedTriggerIds.push(triggerIds);
  }
  return accepted;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} nav
 * @param {import('../runtime/types.js').SnapshotElement[]} links
 */

function buttonAccessibleText(button) {
  return normalizeText(
    button.accessibleName
    || button.attributes['aria-label']
    || button.attributes.title
    || button.visibleText
    || button.text
    || '',
  );
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} row
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} rowIndexes
 */

function hasCurrentClass(element) {
  const classAttr = element.attributes.class || '';
  return classAttr.split(/\s+/).some((token) => token.toLowerCase() === 'current');
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function getLinkLabel(link) {
  return normalizeText(link.accessibleName || link.visibleText || link.text);
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 * @param {string | null} scanUrl
 */

function buildNavLandmarkSignature(nav, links) {
  const label = normalizeText(nav.accessibleName || nav.attributes['aria-label'] || '');
  const linkSignatures = links.map((link) => buildLinkSemanticSignature(link)).sort().join('|');
  return `${label}::${linkSignatures}`;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 */

function buildLinkSemanticSignature(link) {
  const href = normalizeText(link.attributes.href || '');
  const text = normalizeText(link.visibleText || link.text || link.accessibleName || '');
  return `${href}::${text}`;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 * @param {import('../runtime/types.js').SnapshotElement} button
 */

function buildSubmenuRowSignature(link, button) {
  return `${buildLinkSemanticSignature(link)}::${buttonAccessibleText(button)}`;
}

function hasAuthoredTransform(element) {
  const style = element.attributes.style || '';
  return /(?:^|;)\s*transform\s*:\s*(?!none(?:\s*!important)?(?:;|$))/i.test(style);
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {string | null} scanUrl
 */

export {
  isActiveContent,
  isVisuallyAnchoredHeader,
  isMainLandmark,
  isFooterLandmark,
  isBanner,
  isNavLandmark,
  isSearchLandmark,
  hasEquivalentRect,
  isTransparentColor,
  findScopedBody,
  findScopedTitle,
  getScopedChildren,
  dedupeElements,
  dedupeGroups,
  buttonAccessibleText,
  hasCurrentClass,
  getLinkLabel,
  buildNavLandmarkSignature,
  buildLinkSemanticSignature,
  buildSubmenuRowSignature,
  hasAuthoredTransform,
};
