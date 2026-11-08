import {
  getDescendants,
  hasAncestor,
  getAncestors,
  sameScope,
  scopeKey,
} from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSemanticSubtreeText,
  getSnapshot,
  hasLineThroughDecoration,
  isBoldStyle,
  isItalicStyle,
  parseStylePx,
  queryCandidates,
} from './lib/runtime-context.js';
import { withDeadline } from '../engine/deadline.js';
import { qualifiesVisibilityMismatch } from '../policies/lib/visibility-standards.js';

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
      for (const element of withDeadline(candidates)) {
        if (element.tag !== 'span' || element.attributes.role) continue;
        if (!(element.text.trim() || element.visibleText.trim()) || !isBoldStyle(element)) continue;
        if (hasAncestor(snapshot, indexes, element, (ancestor) => /^h[1-6]$/.test(ancestor.tag))) continue;
        if (hasAncestor(snapshot, indexes, element, isInteractiveAncestor)) continue;
        if (isReferencedAsControlLabel(snapshot, element)) continue;
        if (isListSectionLabel(indexes, element)) continue;
        if (hasHeadingStyleToken(element)) continue;
        if (!isBoldInRunningText(snapshot, indexes, element)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'emphasis-mismatch') {
      const nativeItalicOnly = Boolean(check.options?.nativeItalicOnly);
      for (const element of withDeadline(candidates)) {
        if (nativeItalicOnly) {
          if (element.tag !== 'i' || element.attributes.role) continue;
        } else if (!['i', 'span'].includes(element.tag) || element.attributes.role) {
          continue;
        }
        if (!(element.text.trim() || element.visibleText.trim()) || !isItalicStyle(element)) continue;
        if (isTypographicFootnote(element)) continue;
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
      for (const element of withDeadline(candidates)) {
        if (element.hiddenFromAT || element.attributes['aria-hidden'] === 'true') continue;
        if (element.attributes.hidden !== undefined) continue;
        const style = element.computedStyle;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const visibilityReason = getAuthorVisibilityHidingReason(element);
        if (!visibilityReason) continue;
        if (isFocusableFragmentLink(element)) continue;
        // A visually hidden heading (sr-only clip pattern) is the standard way to give a page its h1; it is meant for assistive technology.
        if (visibilityReason === 'clip' && /^h[1-6]$/.test(element.tag)) continue;
        // The node that actually hides the text (itself, or the ancestor whose opacity hides it) is what a focus rule or
        // an ARIA relation has to cover.
        const owner = getVisibilityHidingOwner(snapshot, indexes, element, visibilityReason);
        if (isRevealedOnFocus(snapshot, indexes, owner)) continue;
        if (isReferencedByAriaRelation(snapshot, indexes, owner)) continue;
        if (isNameOfVisibleControl(snapshot, indexes, element)) continue;
        if (
          visibilityReason === 'zero-geometry'
          && hasRenderedVisualDescendant(snapshot, indexes, element)
        ) {
          continue;
        }
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
      for (const element of withDeadline(candidates)) {
        if (qualifiesVisibilityMismatch(snapshot, indexes, element)) findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'breadcrumbs-nav') {
      for (const element of withDeadline(candidates)) {
        const label = (element.attributes['aria-label'] || '').toLowerCase();
        if (!label.includes('breadcrumb')) continue;
        const hasOrderedList = getDescendants(snapshot, indexes, element, (child) => child.tag === 'ol').length > 0;
        if (hasOrderedList) continue;
        // ol/li is the recommended markup, not a WCAG requirement: a labelled breadcrumb nav that marks the current page is a convention deviation.
        const current = getDescendants(snapshot, indexes, element, (child) => child.attributes['aria-current']).length > 0;
        if (current) {
          findings.push({
            ...elementFinding(element, { conventionOnly: 'breadcrumb nav is labelled and marks the current page; <ol>/<li> is recommended markup' }),
            violationType: 'manual-review',
            impact: 'minor',
          });
          continue;
        }
        findings.push(elementFinding(element, { proof: { type: 'measured-fact', fact: `${element.outerHTML.match(/^\s*<[^>]*>/)?.[0].slice(0, 200)} has no <ol> and no descendant with aria-current: the current page is not indicated` } }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'sale-price-discernible') {
      for (const element of withDeadline(candidates)) {
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
      for (const element of withDeadline(candidates)) {
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
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isReferencedAsControlLabel(snapshot, element) {
  const domId = element.attributes.id?.trim();
  if (!domId) return false;

  return snapshot.elements.some((candidate) => {
    if (!sameScope(candidate, element) || !isFormControl(candidate)) return false;
    const labelIds = (candidate.attributes['aria-labelledby'] || '').split(/\s+/);
    return labelIds.includes(domId);
  });
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isFormControl(element) {
  return (
    ['button', 'input', 'select', 'textarea'].includes(element.tag)
    || ['button', 'checkbox', 'combobox', 'listbox', 'radio', 'searchbox', 'slider', 'spinbutton', 'textbox'].includes(
      element.attributes.role || '',
    )
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
 * Bold counts as emphasis only inside running text: the parent carries other text besides this
 * element, and the element is not a block-level box or a numeric-only badge. A lone, short or
 * block-styled bold label gets its weight from typography, not from stress.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isBoldInRunningText(snapshot, indexes, element) {
  const own = renderedSubtreeText(snapshot, indexes, element);
  if (/^[\d\s.,:+%#/()-]+$/.test(own)) return false;
  if (/^(?:block|flex|grid|list-item|table|inline-flex|inline-grid)/.test(element.computedStyle.display || '')) return false;
  const parent = indexes.byElementId.get(element.parentId);
  if (!parent) return false;
  // Full parent text (own text nodes plus every rendered descendant), not parent.visibleText: the snapshot fills that only for controls.
  return renderedSubtreeText(snapshot, indexes, parent).length > own.length;
}

/** Whitespace-collapsed text of the element and its rendered descendants (every element's `text` holds only its own text nodes). */
function renderedSubtreeText(snapshot, indexes, element) {
  const parts = [element.text, ...getDescendants(snapshot, indexes, element, (d) => d.rendered && d.effectiveOpacity > 0.1).map((d) => d.text)];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * A focusable in-page link that a :focus stylesheet rule reveals is a skip link, not hidden content. A hidden fragment link
 * with no focus style stays flagged: keyboard users would tab onto an invisible control.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isFocusableFragmentLink(element) {
  return element.tag === 'a' && /^#./.test(element.attributes.href || '') && element.focusable && element.focusRevealed === true;
}

/**
 * An element (or an ancestor) that a :focus stylesheet rule reveals is reveal-on-focus UI (overlay, skip link), not hidden content.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isRevealedOnFocus(snapshot, indexes, element) {
  return element.focusRevealed === true;
}

// Relations whose target text is written for assistive technology (sr-only name/description text is their normal source).
const TEXT_RELATIONS = ['aria-labelledby', 'aria-describedby', 'aria-details', 'aria-errormessage'];

const referencedIdsCache = new WeakMap();

/**
 * Ids referenced per scope, cached per snapshot. aria-controls counts unless the controller says its target is inactive
 * (an unselected tab or a collapsed disclosure), because that panel stays exposed while hidden by opacity/clip.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @returns {Map<string, {text: Set<string>, controls: Set<string>}>}
 */
function referencedIdsByScope(snapshot) {
  let map = referencedIdsCache.get(snapshot);
  if (map) return map;
  map = new Map();
  const add = (el, raw, kind) => {
    const key = scopeKey(el);
    if (!map.has(key)) map.set(key, { text: new Set(), controls: new Set() });
    for (const id of raw.split(/\s+/)) if (id) map.get(key)[kind].add(id);
  };
  for (const el of snapshot.elements) {
    for (const name of TEXT_RELATIONS) if (el.attributes[name]) add(el, el.attributes[name], 'text');
    const inactive = (el.attributes.role === 'tab' && el.attributes['aria-selected'] !== 'true') || el.attributes['aria-expanded'] === 'false';
    if (el.attributes['aria-controls'] && !inactive) add(el, el.attributes['aria-controls'], 'controls');
  }
  referencedIdsCache.set(snapshot, map);
  return map;
}

/**
 * Text referenced by an ARIA relation (multi-id lists included) is intentional AT content, also when the element sits
 * inside the referenced node.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isReferencedByAriaRelation(snapshot, indexes, element) {
  const { text, controls } = referencedIdsByScope(snapshot).get(scopeKey(element)) || {};
  const own = element.attributes.id && element.attributes.id.trim();
  if (own && (text?.has(own) || controls?.has(own))) return true;
  // Text relations name their target by its whole subtree; aria-controls only exempts the controlled node itself, so a
  // control pointing at a wrapper such as <main> does not hide junk text inside it.
  return !!text && getAncestors(snapshot, indexes, element).some((node) => (
    sameScope(node, element) && node.attributes.id && text.has(node.attributes.id.trim())
  ));
}

/**
 * Visually hidden text inside a visible link, button or tab is that control's accessible name.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isNameOfVisibleControl(snapshot, indexes, element) {
  return getAncestors(snapshot, indexes, element).some((ancestor) => (
    isInteractiveAncestor(ancestor)
    && ancestor.rendered
    && ancestor.effectiveOpacity > 0.1
    && ancestor.rect.width > 0
    && ancestor.rect.height > 0
  ));
}

/**
 * A bold inline node immediately followed by a list often labels that list
 * section rather than emphasizing prose.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isListSectionLabel(indexes, element) {
  if (element.parentId == null) return false;
  const siblings = indexes.childrenByParentId.get(element.parentId) || [];
  const index = siblings.findIndex((sibling) => sibling.id === element.id);
  if (index < 0) return false;
  return siblings.slice(index + 1).some((sibling) => (
    sameScope(sibling, element) && (sibling.tag === 'ul' || sibling.tag === 'ol')
  ));
}

/**
 * Long copy introduced by a conventional footnote marker uses italics as a
 * typographic note treatment rather than stress emphasis.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isTypographicFootnote(element) {
  const text = (element.visibleText || element.text || '').trim();
  return text.length >= 20 && /^(?:\*+|[†‡])\s*\S/.test(text);
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
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function hasRenderedVisualDescendant(snapshot, indexes, element) {
  return getDescendants(snapshot, indexes, element, (descendant) => (
    descendant.rendered
    && descendant.effectiveOpacity > 0.1
    && descendant.rect.width > 0
    && descendant.rect.height > 0
  )).length > 0;
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
