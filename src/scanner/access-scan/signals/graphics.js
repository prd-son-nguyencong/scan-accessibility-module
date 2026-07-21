import {
  getAncestors, getDescendants, hasAncestor, scopeKey,
} from '../runtime/graph-relationships.js';
import { normalizeText } from '../evaluators/lib/runtime-context.js';
import { isActiveContent } from './lib/dom.js';
import { createDomFact, SIGNAL_FAMILIES } from './types.js';

function isPointerTransparentImageOverlay(snapshot, indexes, element) {
  return (
    element.tag === 'div'
    && ['absolute', 'fixed'].includes(element.computedStyle.position)
    && element.computedStyle.pointerEvents === 'none'
    && getDescendants(snapshot, indexes, element, (child) => child.tag === 'img').length > 0
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isInputCueWithStableControl(snapshot, indexes, element) {
  if (element.tag !== 'svg') return false;
  for (const ancestor of getAncestors(snapshot, indexes, element).slice(0, 3)) {
    const inputs = getDescendants(snapshot, indexes, ancestor, (child) => (
      child.tag === 'input' && isActiveContent(child)
    ));
    if (inputs.length === 0) continue;
    return inputs.some((input) => {
      const domId = input.attributes.id;
      return Boolean(
        domId
        && !indexes.ambiguousDomIds.get(scopeKey(input))?.has(domId)
      );
    });
  }
  return false;
}

/**
 * Large visible SVG symbols remain observable even when aria-hidden.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isHiddenSymbolGraphic(snapshot, indexes, element) {
  if (element.tag !== 'svg') return false;
  const hasSymbolReference = getDescendants(
    snapshot,
    indexes,
    element,
    (child) => child.tag === 'use',
  ).length > 0;
  if (!hasSymbolReference) return false;

  const area = element.rect.width * element.rect.height;
  if (area >= 2000) return true;

  return hasAncestor(snapshot, indexes, element, (ancestor) => (
    ['button', 'input', 'select', 'textarea'].includes(ancestor.tag)
    && (
      Object.hasOwn(ancestor.attributes, 'disabled')
      || ancestor.attributes['aria-disabled'] === 'true'
    )
  ));
}

/**
 * Repeated hidden symbols paired with the same visible action label.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @returns {Set<number>}
 */

function collectRepeatedHiddenActionSymbols(snapshot, indexes) {
  /** @type {Map<string, number[]>} */
  const groups = new Map();

  for (const element of snapshot.elements) {
    if (
      element.tag !== 'svg'
      || element.attributes['aria-hidden'] !== 'true'
      || !element.rendered
      || element.rect.width <= 0
      || element.rect.height <= 0
    ) {
      continue;
    }

    const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
    if (
      !parent
      || !isActiveContent(parent)
      || (
        parent.tag !== 'a'
        && parent.tag !== 'button'
        && parent.attributes.role !== 'button'
      )
    ) {
      continue;
    }

    const label = normalizeText(parent.visibleText || parent.text || '');
    const accessibleLabel = normalizeText(
      parent.accessibleName || parent.attributes['aria-label'] || label,
    );
    const symbol = (indexes.childrenByParentId.get(element.id) || [])
      .find((child) => child.tag === 'use');
    if (!label || accessibleLabel !== label || !symbol) continue;

    const reference = symbol.attributes.href || symbol.attributes['xlink:href'] || '';
    const key = `${scopeKey(element)}::${label}::${reference}`;
    const ids = groups.get(key) || [];
    ids.push(element.id);
    groups.set(key, ids);
  }

  return new Set(
    [...groups.values()]
      .filter((ids) => ids.length > 1)
      .flat(),
  );
}

/**
 * Visually exposed state-indicator wrappers hidden inside a popup/list control
 * are reported at the authored aria-hidden wrapper.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isControlStateIndicator(snapshot, indexes, element) {
  if (element.tag !== 'span' || normalizeText(element.visibleText || element.text || '')) {
    return false;
  }
  const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
  if (
    !parent
    || (parent.tag !== 'button' && parent.attributes.role !== 'button')
    || (
      parent.attributes['aria-haspopup'] === undefined
      && parent.attributes['aria-expanded'] === undefined
      && parent.attributes['aria-controls'] === undefined
    )
  ) {
    return false;
  }
  return getDescendants(snapshot, indexes, element, (child) => (
    child.tag === 'svg' && child.rendered && child.rect.width > 0 && child.rect.height > 0
  )).length > 0;
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
function collectGraphicsFacts(snapshot, indexes) {
  /** @type {import('./types.js').DomFact[]} */
  const facts = [];
  const repeatedHiddenActionSymbols = collectRepeatedHiddenActionSymbols(snapshot, indexes);

  for (const element of snapshot.elements) {
    if (isPointerTransparentImageOverlay(snapshot, indexes, element)) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.GRAPHICS,
        'graphics.pointer-transparent-overlay',
        element,
        { position: element.computedStyle.position },
      ));
    }

    if (isInputCueWithStableControl(snapshot, indexes, element)) {
      const inputIds = [];
      for (const ancestor of getAncestors(snapshot, indexes, element).slice(0, 3)) {
        for (const input of getDescendants(snapshot, indexes, ancestor, (child) => (
          child.tag === 'input' && isActiveContent(child)
        ))) {
          const domId = input.attributes.id;
          if (domId && !indexes.ambiguousDomIds.get(scopeKey(input))?.has(domId)) {
            inputIds.push(input.id);
          }
        }
      }
      facts.push(createDomFact(
        SIGNAL_FAMILIES.GRAPHICS,
        'graphics.input-cue',
        element,
        { tag: element.tag },
        inputIds,
      ));
    }

    if (isHiddenSymbolGraphic(snapshot, indexes, element)) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.GRAPHICS,
        'graphics.hidden-symbol',
        element,
        {
          area: element.rect.width * element.rect.height,
          hasSymbolReference: true,
          hasDisabledAncestor: hasAncestor(snapshot, indexes, element, (ancestor) => (
            ['button', 'input', 'select', 'textarea'].includes(ancestor.tag)
            && (
              Object.hasOwn(ancestor.attributes, 'disabled')
              || ancestor.attributes['aria-disabled'] === 'true'
            )
          )),
        },
      ));
    }

    if (repeatedHiddenActionSymbols.has(element.id)) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.GRAPHICS,
        'graphics.repeated-action-symbol',
        element,
        { ariaHidden: true },
      ));
    }

    if (isControlStateIndicator(snapshot, indexes, element)) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.GRAPHICS,
        'graphics.control-state-indicator',
        element,
        { tag: element.tag },
      ));
    }

    if (
      element.tag === 'svg'
      && element.attributes.role === 'img'
      && element.attributes['aria-hidden'] !== 'true'
      && element.attributes.role !== 'presentation'
      && !element.attributes['aria-label']
      && !element.attributes['aria-labelledby']
      && getDescendants(snapshot, indexes, element, (child) => child.tag === 'title').length === 0
    ) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.GRAPHICS,
        'graphics.unlabeled-icon',
        element,
        { role: element.attributes.role },
      ));
    }
  }

  return facts;
}

export {
  isPointerTransparentImageOverlay,
  isInputCueWithStableControl,
  isHiddenSymbolGraphic,
  collectRepeatedHiddenActionSymbols,
  isControlStateIndicator,
  collectGraphicsFacts,
};
