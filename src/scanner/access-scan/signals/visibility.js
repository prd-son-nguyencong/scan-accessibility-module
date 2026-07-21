import {
  getAncestors, getDescendants, hasAncestor, sameScope,
} from '../runtime/graph-relationships.js';
import { normalizeText, isFocusableControl } from '../evaluators/lib/runtime-context.js';
import {
  COMPOSITE_VISIBILITY_ROLES, EXCLUDED_HIDDEN_TAGS, SCRIPT_ONLY_TAGS,
} from './lib/constants.js';
import { isActiveContent, getScopedChildren } from './lib/dom.js';
import { createDomFact, SIGNAL_FAMILIES } from './types.js';

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function collectStructuralVisibilityMisuse(snapshot, indexes) {
  /** @type {Array<{ element: import('../runtime/types.js').SnapshotElement, reason: string }>} */
  const candidates = [];

  for (const element of snapshot.elements) {
    // Chat/widget shadow trees over-fire opacity/clipped text heuristics.
    if (element.shadowPath.length > 0) continue;
    if (!isActiveContent(element)) continue;

    if (element.tag === 'body' && element.framePath.length === 0 && element.shadowPath.length === 0) {
      candidates.push({ element, reason: 'rendered-document-body' });
      continue;
    }

    if (isDeferredVisualWrapper(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'deferred-visual-scroll-wrapper' });
      continue;
    }

    if (isScrollControlShell(indexes, element)) {
      candidates.push({ element, reason: 'oversized-fragment-scroll-control-shell' });
      continue;
    }

    if (isScriptOnlyZeroHeightContainer(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'script-only-zero-height-container' });
      continue;
    }

    if (isZeroGeometryCustomElement(element)) {
      candidates.push({ element, reason: 'empty-custom-element-host' });
      continue;
    }

    if (isEmptyShadowRootContainer(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'empty-open-shadow-root-container' });
      continue;
    }

    if (isInactiveExclusiveVisualPanel(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'inactive-exclusive-visual-panel' });
      continue;
    }

    if (isCollapsedMaxHeightOpacityPanel(indexes, element)) {
      candidates.push({ element, reason: 'collapsed-max-height-opacity-panel' });
      continue;
    }

    if (isEmptyFrameworkMount(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'empty-framework-component-mount' });
      continue;
    }

    if (isEmptyExposedList(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'empty-exposed-list' });
      continue;
    }

    if (isZeroGeometryJavascriptControl(element)) {
      candidates.push({ element, reason: 'zero-geometry-javascript-control' });
      continue;
    }

    if (isEmptyFilterPanel(indexes, element)) {
      candidates.push({ element, reason: 'empty-filter-panel' });
      continue;
    }

    if (isZeroHeightSpriteHost(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'zero-height-sprite-host' });
      continue;
    }

    if (isEmptyTextBlock(indexes, element)) {
      candidates.push({ element, reason: 'empty-zero-height-text-block' });
      continue;
    }

    if (isSubstantiallyClippedContainer(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'substantially-overflow-clipped-container' });
      continue;
    }

    if (
      element.tag === 'svg'
      && (element.rect.width <= 0 || element.rect.height <= 0)
      && getDescendants(snapshot, indexes, element, (child) => child.tag === 'symbol').length > 0
    ) {
      candidates.push({ element, reason: 'zero-geometry-svg-symbol-sprite' });
      continue;
    }

    if (isCollapsedListItemWithHiddenDisabledControl(indexes, element)) {
      candidates.push({ element, reason: 'collapsed-list-item-hidden-disabled-control' });
      continue;
    }

    if (isEmptyOpacityOverlay(indexes, element)) {
      candidates.push({ element, reason: 'empty-opacity-overlay' });
      continue;
    }

    if (isZeroGeometryExposedText(indexes, element)) {
      candidates.push({ element, reason: 'zero-geometry-exposed-text' });
      continue;
    }

    if (isOpacityHiddenAbsoluteImage(indexes, element)) {
      candidates.push({ element, reason: 'opacity-hidden-absolute-image' });
      continue;
    }

    if (isOpacityHiddenVideo(element)) {
      candidates.push({ element, reason: 'opacity-hidden-video' });
      continue;
    }

    if (isEmptyPresentationDivider(indexes, element)) {
      candidates.push({ element, reason: 'empty-presentation-divider' });
      continue;
    }

    // opacity-hidden-text / overflow-clipped-* over-fire on carousel copy relative
    // to commercial occurrence counts — keep helpers but do not emit by default.

  }

  // display:none absolute flyouts are excluded from isActiveContent but still
  // appear in commercial VisibilityMisuse samples.
  for (const element of snapshot.elements) {
    if (isAbsoluteHiddenDisclosurePanel(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'absolute-hidden-disclosure-panel' });
    }
  }

  for (const element of snapshot.elements) {
    if (isAbsoluteHiddenDisclosureInner(snapshot, indexes, element)) {
      candidates.push({ element, reason: 'absolute-hidden-disclosure-inner' });
    }
  }

  const repeatedPlaceholders = snapshot.elements.filter((element) => (
    isRepeatedEmptyPlaceholderCandidate(snapshot, indexes, element)
  ));
  if (repeatedPlaceholders.length >= 2) {
    for (const element of repeatedPlaceholders) {
      candidates.push({ element, reason: 'repeated-zero-height-empty-placeholder' });
    }
  }

  const seen = new Set();
  return candidates.filter(({ element }) => {
    if (seen.has(element.id)) return false;
    seen.add(element.id);
    return true;
  });
}

/**
 * Empty absolutely/fixed positioned overlays kept at opacity 0 remain in the
 * accessibility tree. Flag only the empty root — never opacity-0 descendants
 * that still carry text or interactive content.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isEmptyOpacityOverlay(indexes, element) {
  const isPresentationIcon = (
    element.tag === 'i'
    && element.attributes.role === 'presentation'
  );
  if (
    (element.tag !== 'div' && !isPresentationIcon)
    || !isActiveContent(element)
    || element.effectiveOpacity > 0.1
    || !['absolute', 'fixed'].includes(element.computedStyle.position || '')
    || element.rect.width <= 0
    || element.rect.height <= 0
    || normalizeText(element.text || element.visibleText || element.accessibleName || '')
  ) {
    return false;
  }

  if (getScopedChildren(indexes, element, element).length !== 0) return false;

  // Commercial samples empty overlays that sit on top of sibling media (card
  // hover scrims). Bare absolute opacity-0 shells elsewhere over-fire.
  const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
  if (!parent) return false;
  return getScopedChildren(indexes, parent, element).some((sibling) => (
    sibling.id !== element.id
    && (sibling.tag === 'img' || sibling.tag === 'video' || sibling.tag === 'picture')
  ));
}

/**
 * Collapsed text (zero height / video fallback copy) stays in the AT tree.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isZeroGeometryExposedText(indexes, element) {
  if (
    element.tag !== 'p'
    || !isActiveContent(element)
    || element.rect.height > 0
    || !normalizeText(element.text || element.visibleText || '')
  ) {
    return false;
  }

  // Fully collapsed 0×0 nodes: only video fallback copy (or text inside <video>).
  if (element.rect.width <= 0) {
    return isVideoFallbackCopy(element) || hasVideoAncestor(indexes, element);
  }

  // Positive width + zero height: hover-expand / max-height collapsed copy.
  return getScopedChildren(indexes, element, element).every((child) => (
    !isFocusableControl(child)
  ));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isVideoFallbackCopy(element) {
  return /browser does not support/i.test(
    normalizeText(element.text || element.visibleText || ''),
  );
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function hasVideoAncestor(indexes, element) {
  let parentId = element.parentId;
  while (parentId != null) {
    const parent = indexes.byElementId.get(parentId);
    if (!parent) return false;
    if (parent.tag === 'video') return true;
    parentId = parent.parentId;
  }
  return false;
}

/**
 * Dual-state brand marks stack absolute empty-alt <img> twins. Flag any twin
 * that is opacity-hidden, and also the visible twin when a hidden sibling exists
 * (commercial engines list both layers).
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOpacityHiddenAbsoluteImage(indexes, element) {
  if (
    element.tag !== 'img'
    || !isActiveContent(element)
    || !['absolute', 'fixed'].includes(element.computedStyle.position || '')
    || element.rect.width <= 0
    || element.rect.height <= 0
    || (element.attributes.alt !== '' && element.attributes.alt != null)
  ) {
    return false;
  }

  if (element.effectiveOpacity <= 0.1) return true;

  const parent = element.parentId != null
    ? indexes.byElementId.get(element.parentId)
    : null;
  if (!parent) return false;

  return getScopedChildren(indexes, parent, element).some((sibling) => (
    sibling.id !== element.id
    && sibling.tag === 'img'
    && isActiveContent(sibling)
    && sibling.effectiveOpacity <= 0.1
    && ['absolute', 'fixed'].includes(sibling.computedStyle.position || '')
    && (sibling.attributes.alt === '' || sibling.attributes.alt == null)
  ));
}

/**
 * Inactive / decorative <video> layers kept at opacity 0 remain AT-exposed.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOpacityHiddenVideo(element) {
  return (
    element.tag === 'video'
    && isActiveContent(element)
    && element.effectiveOpacity <= 0.1
    && element.rect.width > 0
    && element.rect.height > 0
  );
}

/**
 * Thin empty role=presentation rules/dividers remain AT-exposed visual chrome.
 * Broad presentation hosts (full-bleed backgrounds) are excluded.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isEmptyPresentationDivider(indexes, element) {
  if (
    element.tag !== 'div'
    || element.attributes.role !== 'presentation'
    || !isActiveContent(element)
    || element.rect.width <= 0
    || element.rect.height <= 0
    || normalizeText(element.text || element.visibleText || element.accessibleName || '')
    || getScopedChildren(indexes, element, element).length > 0
  ) {
    return false;
  }

  const thinEdge = Math.min(element.rect.width, element.rect.height);
  const longEdge = Math.max(element.rect.width, element.rect.height);
  return thinEdge <= 8 && longEdge >= 48;
}

/**
 * Collapsed absolute flyout/disclosure panels (display:none) still carry link
 * subtrees in the DOM. Commercial scanners flag the panel root. Fixed-position
 * chrome menus are excluded — they over-fire on sites that already match VisMisuse.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isAbsoluteHiddenDisclosurePanel(snapshot, indexes, element) {
  if (
    element.tag !== 'div'
    || element.computedStyle.display !== 'none'
    || (element.computedStyle.position || '') !== 'absolute'
  ) {
    return false;
  }

  // Explicit aria-hidden removals are not commercial VisMisuse. display:none
  // alone still sets hiddenFromAT in our snapshot, but commercial samples those
  // absolute disclosure roots — do not treat that flag as a skip.
  if (element.attributes['aria-hidden'] === 'true') {
    return false;
  }

  if (hasAncestor(
    snapshot,
    indexes,
    element,
    (ancestor) => ancestor.computedStyle.display === 'none',
  )) {
    return false;
  }

  const links = getDescendants(snapshot, indexes, element, (child) => (
    child.tag === 'a' && Boolean(child.attributes.href)
  ));
  return links.length >= 2;
}

/**
 * Commercial samples often include the inner link column inside a collapsed
 * absolute disclosure panel, not only the panel root.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isAbsoluteHiddenDisclosureInner(snapshot, indexes, element) {
  if (element.tag !== 'div') return false;
  const parent = element.parentId != null
    ? indexes.byElementId.get(element.parentId)
    : null;
  if (!parent || !isAbsoluteHiddenDisclosurePanel(snapshot, indexes, parent)) {
    return false;
  }

  const links = getDescendants(snapshot, indexes, element, (child) => (
    child.tag === 'a' && Boolean(child.attributes.href)
  ));
  return links.length >= 2;
}

/**
 * Opacity-0 headings/labels remain in the AT tree (widget chrome, dual-state UI).
 * Outermost match only — avoid counting every nested span under an opaque-0 root.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOpacityHiddenText(indexes, element) {
  if (
    !/^(?:h[1-6]|span)$/.test(element.tag)
    || element.shadowPath.length > 0
    || !isActiveContent(element)
    || element.effectiveOpacity > 0.1
    || element.rect.width <= 0
    || element.rect.height <= 0
    || normalizeText(element.visibleText || element.text || '').length < 8
  ) {
    return false;
  }

  let parentId = element.parentId;
  while (parentId != null) {
    const ancestor = indexes.byElementId.get(parentId);
    if (!ancestor) break;
    // Only collapse under another opacity-0 text candidate, not a silent wrapper.
    if (
      /^(?:h[1-6]|span)$/.test(ancestor.tag)
      && ancestor.effectiveOpacity <= 0.1
      && normalizeText(ancestor.visibleText || ancestor.text || '').length >= 8
    ) {
      return false;
    }
    parentId = ancestor.parentId;
  }
  return true;
}

/**
 * Long copy whose horizontal center sits outside an overflow:hidden ancestor
 * (carousel / slide peeks) stays AT-exposed while visually clipped.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOverflowClippedText(snapshot, indexes, element) {
  if (
    element.tag !== 'p'
    || element.shadowPath.length > 0
    || !isActiveContent(element)
    || element.rect.width <= 0
    || element.rect.height <= 0
    || normalizeText(element.visibleText || element.text || '').length < 40
  ) {
    return false;
  }

  const centerX = element.rect.x + (element.rect.width / 2);
  return getAncestors(snapshot, indexes, element).some((ancestor) => (
    ancestor.computedStyle.overflow === 'hidden'
    && ancestor.rect.width > 0
    && ancestor.rect.height > 0
    && (centerX < ancestor.rect.x || centerX > ancestor.rect.x + ancestor.rect.width)
  ));
}

/**
 * Opacity-0 links that still expose authored visible text (widget chrome).
 * Accessible-name-only hosts (icon + nested label) are excluded.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOpacityHiddenTextLink(element) {
  return (
    element.tag === 'a'
    && isActiveContent(element)
    && Boolean(element.attributes.href)
    && element.effectiveOpacity <= 0.1
    && ['absolute', 'fixed'].includes(element.computedStyle.position || '')
    && element.rect.width > 0
    && element.rect.height > 0
    && normalizeText(element.visibleText || element.text || '').length >= 4
  );
}

/**
 * Off-viewport video carousel slides remain AT-exposed inside overflow:hidden tracks.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOverflowClippedVideoSlide(snapshot, indexes, element) {
  if (
    !isActiveContent(element)
    || !/swiper-slide/.test(element.attributes.class || '')
    || !/\bvideo\b/.test(element.attributes.class || '')
    || element.rect.width < 100
    || element.rect.height < 80
    || normalizeText(element.visibleText || element.text || '').length < 20
  ) {
    return false;
  }

  const centerX = element.rect.x + (element.rect.width / 2);
  return getAncestors(snapshot, indexes, element).some((ancestor) => (
    ancestor.computedStyle.overflow === 'hidden'
    && ancestor.rect.width > 0
    && (
      centerX < ancestor.rect.x
      || centerX > ancestor.rect.x + ancestor.rect.width
      || element.rect.x + element.rect.width <= ancestor.rect.x
      || element.rect.x >= ancestor.rect.x + ancestor.rect.width
    )
  ));
}

/**
 * Disabled pagination/control shells often hide the interactive child with
 * display:none while leaving the wrapping list item AT-exposed.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isCollapsedListItemWithHiddenDisabledControl(indexes, element) {
  if (
    element.tag !== 'li'
    || !isActiveContent(element)
    || element.attributes['aria-hidden'] === 'true'
  ) {
    return false;
  }

  const children = getScopedChildren(indexes, element, element);
  if (children.length === 0) return false;

  const controls = children.filter((child) => (
    child.tag === 'a'
    || child.tag === 'button'
    || ['link', 'button'].includes(child.attributes.role || '')
  ));
  if (controls.length === 0 || controls.length !== children.length) return false;

  return controls.every((control) => {
    const visuallyHidden = (
      !control.rendered
      || control.computedStyle.display === 'none'
      || control.computedStyle.visibility === 'hidden'
    );
    const disabled = (
      control.attributes['aria-disabled'] === 'true'
      || Object.hasOwn(control.attributes, 'disabled')
    );
    return (
      visuallyHidden
      && disabled
      && control.attributes['aria-hidden'] !== 'true'
    );
  });
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isDeferredVisualWrapper(snapshot, indexes, element) {
  if (
    element.tag !== 'div'
    || !isActiveContent(element)
    || !Object.hasOwn(element.attributes, 'data-scroll')
    || Object.hasOwn(element.attributes, 'data-scroll-class')
    || (
      Object.hasOwn(element.attributes, 'data-scroll-speed')
      && !Object.hasOwn(element.attributes, 'data-scroll-position')
    )
  ) {
    return false;
  }

  return getDescendants(snapshot, indexes, element, (child) => {
    const deferredSource = (
      child.attributes['data-src']
      || child.attributes['data-lazy-src']
      || child.attributes['data-srcset']
    );
    if (!deferredSource) return false;
    return (
      child.tag === 'img'
      || child.attributes.role === 'img'
      || child.computedStyle.backgroundImage?.includes('url(')
    );
  }).length > 0;
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isScrollControlShell(indexes, element) {
  if (
    element.tag !== 'div'
    || !isActiveContent(element)
    || element.rect.width <= 0
    || element.rect.height <= 0
  ) {
    return false;
  }

  return getScopedChildren(indexes, element, element).some((child) => (
    (child.tag === 'a' || child.tag === 'button')
    && Object.hasOwn(child.attributes, 'data-scroll-to')
    && element.rect.height > child.rect.height
  ));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isScriptOnlyZeroHeightContainer(snapshot, indexes, element) {
  if (
    element.tag !== 'div'
    || !isActiveContent(element)
    || element.rect.height > 0
    || element.shadowPath.length > 0
  ) {
    return false;
  }

  const children = getScopedChildren(indexes, element, element);
  if (children.length === 0 || !children.some((child) => SCRIPT_ONLY_TAGS.has(child.tag))) {
    return false;
  }
  if (children.some((child) => !SCRIPT_ONLY_TAGS.has(child.tag))) return false;

  return !getDescendants(snapshot, indexes, element, (child) => (
    isActiveContent(child)
    && child.rect.width > 0
    && child.rect.height > 0
    && !SCRIPT_ONLY_TAGS.has(child.tag)
  )).length;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isZeroGeometryCustomElement(element) {
  return (
    element.tag.includes('-')
    && (element.rect.width <= 0 || element.rect.height <= 0)
    && !normalizeText(element.text || element.visibleText || element.accessibleName || '')
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isEmptyShadowRootContainer(snapshot, indexes, element) {
  const parent = element.parentId != null
    ? indexes.byElementId.get(element.parentId)
    : null;
  const isShadowScopeRoot = !parent || !sameScope(parent, element);
  return (
    element.shadowPath.length > 0
    && isShadowScopeRoot
    && isActiveContent(element)
    && (element.rect.width <= 0 || element.rect.height <= 0)
    && !normalizeText(element.text || element.visibleText || element.accessibleName || '')
    && !hasMeaningfulDescendant(snapshot, indexes, element)
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isInactiveExclusiveVisualPanel(snapshot, indexes, element) {
  if (
    element.tag !== 'div'
    || element.effectiveOpacity > 0.1
    || element.computedStyle.pointerEvents !== 'none'
    || element.rect.width <= 0
    || element.rect.height <= 0
    || !hasMeaningfulDescendant(snapshot, indexes, element)
  ) {
    return false;
  }

  const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
  if (!parent) return false;
  return getScopedChildren(indexes, parent, element).some((sibling) => (
    sibling.id !== element.id
    && sibling.tag === element.tag
    && sibling.effectiveOpacity > 0.1
    && sibling.computedStyle.pointerEvents !== 'none'
    && Math.abs(sibling.rect.width - element.rect.width) <= 2
    && Math.abs(sibling.rect.height - element.rect.height) <= 2
  ));
}

/**
 * Large media hosts parked inside an inactive exclusive carousel panel.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isInactiveExclusiveMediaSlide(snapshot, indexes, element) {
  if (element.tag !== 'div' || element.shadowPath.length > 0) return false;
  if (!isActiveContent(element)) return false;
  if (element.rect.width <= 0 || element.rect.height < 240) return false;
  const hasDirectMedia = getScopedChildren(indexes, element, element).some((child) => (
    child.tag === 'img' || child.tag === 'video' || child.tag === 'picture'
  ));
  if (!hasDirectMedia) return false;

  const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
  if (!parent) return false;
  if (isInactiveExclusiveVisualPanel(snapshot, indexes, parent)) return true;

  // One wrapper between the inactive panel and the media host (size-full shells).
  const grandparent = parent.parentId != null ? indexes.byElementId.get(parent.parentId) : null;
  return Boolean(
    grandparent
    && isInactiveExclusiveVisualPanel(snapshot, indexes, grandparent)
  );
}

/**
 * Timeline / accordion copy shells that collapse via max-height + opacity utilities
 * while keeping text in the accessibility tree.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isCollapsedMaxHeightOpacityPanel(indexes, element) {
  if (element.tag !== 'div' || element.shadowPath.length > 0) return false;
  if (!isActiveContent(element)) return false;
  if (element.effectiveOpacity > 0.1) return false;
  if (element.rect.height > 0) return false;
  const ownText = normalizeText(element.visibleText || element.text || '');
  const childText = getScopedChildren(indexes, element, element)
    .map((child) => normalizeText(child.visibleText || child.text || ''))
    .join(' ');
  const text = ownText || childText;
  if (text.length < 20) return false;
  const maxHeight = element.computedStyle.maxHeight || '';
  const overflow = element.computedStyle.overflow || '';
  const className = element.attributes.class || '';
  const looksCollapsed = (
    maxHeight === '0px'
    || /(?:^|\s)max-h-0(?:\s|$)/.test(className)
  );
  const clips = /hidden|clip/.test(overflow) || /overflow-hidden/.test(className);
  if (!looksCollapsed || !clips) return false;
  // Prefer outermost collapsed shell — skip nested text wrappers.
  const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
  if (
    parent
    && parent.tag === 'div'
    && parent.effectiveOpacity <= 0.1
    && parent.rect.height <= 0
    && (
      (parent.computedStyle.maxHeight || '') === '0px'
      || /(?:^|\s)max-h-0(?:\s|$)/.test(parent.attributes.class || '')
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Empty filter/tag lists remain in the accessibility tree as list containers
 * with no items — commercial VisibilityMisuse samples these when the surrounding
 * framework mount still has visible chrome (nonzero height). When the parent
 * mount itself collapses to zero height, the mount signal already covers it.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isEmptyExposedList(snapshot, indexes, element) {
  if (element.tag !== 'ul' && element.tag !== 'ol') return false;
  if (!isActiveContent(element)) return false;
  if (element.rect.height > 0) return false;
  if (element.attributes.role === 'presentation' || element.attributes.role === 'none') {
    return false;
  }
  if (getScopedChildren(indexes, element, element).some((child) => child.tag === 'li')) {
    return false;
  }
  if (hasAncestor(snapshot, indexes, element, (ancestor) => (
    ancestor.tag === 'div'
    && ancestor.rect.height <= 0
    && Object.keys(ancestor.attributes).some((name) => /^data-(?:[a-z0-9]+-)?component$/i.test(name))
  ))) {
    return false;
  }
  return true;
}

/**
 * Mobile chrome toggles often keep a zero-box `javascript:void(0)` host in the
 * tree while the visible icon is painted elsewhere — commercial VisMisuse.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isZeroGeometryJavascriptControl(element) {
  if (!isActiveContent(element)) return false;
  if (element.rect.width > 0 || element.rect.height > 0) return false;
  const href = (element.attributes.href || '').trim().toLowerCase();
  const isJsHost = href.startsWith('javascript:');
  const isButtonish = (
    element.tag === 'button'
    || element.attributes.role === 'button'
    || (element.tag === 'a' && isJsHost)
  );
  return isButtonish && (isJsHost || element.attributes.role === 'button');
}

/**
 * Collapsed advanced-filter shells that expose a heading but no controls.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isEmptyFilterPanel(indexes, element) {
  if (element.tag !== 'div' || !isActiveContent(element)) return false;
  const className = element.attributes.class || '';
  if (!/(?:^|\s)(?:filter-group|advanced-search)(?:\s|$)/i.test(className)) return false;
  const children = getScopedChildren(indexes, element, element);
  const hasControl = children.some((child) => (
    isFocusableControl(child)
    || ['input', 'select', 'textarea', 'ul', 'ol'].includes(child.tag)
  ));
  if (hasControl) return false;
  // Heading-only / empty advanced filter chrome.
  return children.length <= 2;
}

/**
 * Bottom HTML mounts that only host a zero-geometry SVG sprite sheet.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isZeroHeightSpriteHost(snapshot, indexes, element) {
  if (element.tag !== 'div' || !isActiveContent(element)) return false;
  if (element.rect.width <= 0 || element.rect.height > 0) return false;
  const children = getScopedChildren(indexes, element, element);
  if (children.length === 0) return false;
  return children.every((child) => (
    child.tag === 'svg'
    && (child.rect.width <= 0 || child.rect.height <= 0)
    && getDescendants(snapshot, indexes, child, (descendant) => descendant.tag === 'symbol').length > 0
  ));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isEmptyFrameworkMount(snapshot, indexes, element) {
  if (
    element.tag !== 'div'
    || !isActiveContent(element)
    || isOptionalPaginationMount(element)
    || (element.rect.width > 0 && element.rect.height > 0)
    || !Object.keys(element.attributes).some((name) => /^data-(?:[a-z0-9]+-)?component$/i.test(name))
  ) {
    return false;
  }

  const controls = getDescendants(snapshot, indexes, element, (child) => (
    isFocusableControl(child)
    || ['input', 'select', 'textarea'].includes(child.tag)
  ));
  if (controls.length > 0) return false;

  const text = normalizeText(element.visibleText || element.text || element.accessibleName || '');
  if (!text && !hasMeaningfulDescendant(snapshot, indexes, element)) return true;

  const lists = getDescendants(snapshot, indexes, element, (child) => (
    child.tag === 'ul' || child.tag === 'ol'
  ));
  return lists.length > 0 && lists.every((list) => (
    getDescendants(snapshot, indexes, list, (child) => child.tag === 'li').length === 0
  ));
}

/**
 * Empty pagination mounts are an expected inapplicable state when all results
 * fit on one page, unlike missing status/location output regions.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isOptionalPaginationMount(element) {
  return Object.entries(element.attributes).some(([name, value]) => (
    /^data-(?:[a-z0-9]+-)?component$/i.test(name)
    && /(?:^|[-_\s])(?:pagination|pager)(?:$|[-_\s])/i.test(value)
  ));
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isEmptyTextBlock(indexes, element) {
  return (
    element.tag === 'p'
    && isActiveContent(element)
    && element.rect.width > 0
    && element.rect.height <= 0
    && !normalizeText(element.visibleText || element.text || element.accessibleName || '')
    && getScopedChildren(indexes, element, element).length === 0
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isSubstantiallyClippedContainer(snapshot, indexes, element) {
  if (element.tag !== 'div' || element.rect.width <= 0 || element.rect.height <= 0) {
    return false;
  }
  if (participatesInCompositeVisibilityWidget(snapshot, indexes, element)) return false;
  const hasDirectMedia = getScopedChildren(indexes, element, element).some((child) => (
    child.tag === 'img' || child.tag === 'video' || child.tag === 'picture'
  ));
  if (hasDirectMedia) {
    // Media hosts parked outside a carousel overflow track.
    if (element.rect.height < 200) return false;
    if (!/(?:^|\s)shrink-0(?:\s|$)/.test(element.attributes.class || '')) return false;
    return getAncestors(snapshot, indexes, element).some((ancestor) => {
      if (
        !sameScope(ancestor, element)
        || ancestor.computedStyle.overflow !== 'hidden'
        || ancestor.rect.width <= 0
        || ancestor.rect.height <= 0
        || !/carousel/i.test(ancestor.attributes.class || '')
      ) {
        return false;
      }
      const centerX = element.rect.x + (element.rect.width / 2);
      // Inclusive on the left edge: half-offscreen media hosts often land with
      // centerX === clip.x (e.g. x=-320,w=640 → cx=0). Keep strict `>` on the
      // right so a host whose center sits exactly on clip.right stays unflagged.
      return (
        centerX <= ancestor.rect.x
        || centerX > ancestor.rect.x + ancestor.rect.width
      );
    });
  }

  // Non-media shells: prefer outermost only to avoid carousel wrapper explosions.
  if (getAncestors(snapshot, indexes, element).some((ancestor) => (
    ancestor.tag === 'div'
    && isSubstantiallyClippedAgainstAncestors(snapshot, indexes, ancestor)
  ))) {
    return false;
  }

  return isSubstantiallyClippedAgainstAncestors(snapshot, indexes, element);
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isSubstantiallyClippedAgainstAncestors(snapshot, indexes, element) {
  return getAncestors(snapshot, indexes, element).some((ancestor) => {
    if (
      !sameScope(ancestor, element)
      || !/(?:hidden|clip)/.test(ancestor.computedStyle.overflow || '')
      || ancestor.rect.width <= 0
      || ancestor.rect.height <= 0
    ) {
      return false;
    }

    const elementRight = element.rect.x + element.rect.width;
    const elementBottom = element.rect.y + element.rect.height;
    const ancestorRight = ancestor.rect.x + ancestor.rect.width;
    const ancestorBottom = ancestor.rect.y + ancestor.rect.height;
    const horizontalGap = Math.max(
      element.rect.x - ancestorRight,
      ancestor.rect.x - elementRight,
      0,
    );
    const verticalGap = Math.max(
      element.rect.y - ancestorBottom,
      ancestor.rect.y - elementBottom,
      0,
    );
    return (
      horizontalGap > ancestor.rect.width * 0.5
      || verticalGap > ancestor.rect.height * 0.5
    );
  });
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function participatesInCompositeVisibilityWidget(snapshot, indexes, element) {
  const related = [element, ...getAncestors(snapshot, indexes, element)];
  if (related.some((candidate) => (
    COMPOSITE_VISIBILITY_ROLES.has(candidate.attributes.role || '')
    || Object.hasOwn(candidate.attributes, 'aria-live')
  ))) {
    return true;
  }

  return getDescendants(snapshot, indexes, element, (child) => (
    COMPOSITE_VISIBILITY_ROLES.has(child.attributes.role || '')
    || Object.hasOwn(child.attributes, 'aria-live')
  )).length > 0;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function hasMeaningfulDescendant(snapshot, indexes, element) {
  return getDescendants(snapshot, indexes, element).some((child) => (
    Boolean(normalizeText(child.visibleText || child.text || child.accessibleName || ''))
  ));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isRepeatedEmptyPlaceholderCandidate(snapshot, indexes, element) {
  if (
    element.tag !== 'div'
    || !isActiveContent(element)
    || element.rect.width <= 0
    || element.rect.height > 0
    || element.computedStyle.overflow !== 'visible'
    || element.computedStyle.pointerEvents === 'none'
    || normalizeText(element.visibleText || element.text || element.accessibleName || '')
  ) {
    return false;
  }

  const children = getScopedChildren(indexes, element, element);
  return (
    children.length === 1
    && children[0].tag === 'span'
    && !normalizeText(
      children[0].visibleText || children[0].text || children[0].accessibleName || '',
    )
    && !hasMeaningfulDescendant(snapshot, indexes, children[0])
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @returns {import('./types.js').DomFact[]}
 */
function collectVisibilityFacts(snapshot, indexes) {
  /** @type {import('./types.js').DomFact[]} */
  const facts = [];

  for (const element of snapshot.elements) {
    if (element.attributes['aria-hidden'] !== 'true') continue;
    if (!element.rendered || element.rect.width <= 0 || element.rect.height <= 0) continue;
    if (hasAncestor(
      snapshot,
      indexes,
      element,
      (ancestor) => ancestor.attributes['aria-hidden'] === 'true',
    )) {
      continue;
    }

    facts.push(createDomFact(
      SIGNAL_FAMILIES.VISIBILITY,
      'visibility.aria-hidden-exposed',
      element,
      {
        rendered: true,
        width: element.rect.width,
        height: element.rect.height,
        effectiveOpacity: element.effectiveOpacity,
      },
    ));
  }

  for (const candidate of collectStructuralVisibilityMisuse(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.VISIBILITY,
      'visibility.structural-misuse',
      candidate.element,
      { reason: candidate.reason },
    ));
  }

  return facts;
}

export {
  collectStructuralVisibilityMisuse,
  collectVisibilityFacts,
  isDeferredVisualWrapper,
  isScrollControlShell,
  isScriptOnlyZeroHeightContainer,
  isZeroGeometryCustomElement,
  isEmptyShadowRootContainer,
  isInactiveExclusiveVisualPanel,
  isInactiveExclusiveMediaSlide,
  isCollapsedMaxHeightOpacityPanel,
  isEmptyFrameworkMount,
  isEmptyExposedList,
  isZeroGeometryJavascriptControl,
  isEmptyFilterPanel,
  isZeroHeightSpriteHost,
  isOptionalPaginationMount,
  isEmptyTextBlock,
  isSubstantiallyClippedContainer,
  participatesInCompositeVisibilityWidget,
  hasMeaningfulDescendant,
  isRepeatedEmptyPlaceholderCandidate,
  isEmptyOpacityOverlay,
  isZeroGeometryExposedText,
  isOpacityHiddenAbsoluteImage,
  isOpacityHiddenVideo,
  isEmptyPresentationDivider,
  isAbsoluteHiddenDisclosurePanel,
  isAbsoluteHiddenDisclosureInner,
  isOpacityHiddenText,
  isOverflowClippedText,
  isOpacityHiddenTextLink,
  isOverflowClippedVideoSlide,
};
