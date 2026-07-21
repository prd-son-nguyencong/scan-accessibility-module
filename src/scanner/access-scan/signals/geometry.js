import { parseStylePx } from '../evaluators/lib/runtime-context.js';
import { SUBSTANTIAL_STICKY_HEADER_HEIGHT } from './lib/constants.js';
import {
  hasAuthoredTransform,
  isBanner,
  isFooterLandmark,
  isActiveContent,
  isVisuallyAnchoredHeader,
} from './lib/dom.js';
import { createDomFact, SIGNAL_FAMILIES } from './types.js';

function collectTopAnchoredHeaders(snapshot) {
  return snapshot.elements.filter((element) => {
    if (!isBanner(element) || !isVisuallyAnchoredHeader(element)) return false;
    const position = element.computedStyle.position || '';
    const topOffset = parseStylePx(element.computedStyle.top);
    return (
      (
        position === 'fixed'
        || (
          position === 'sticky'
          && (
            hasAuthoredTransform(element)
            || element.rect.height >= SUBSTANTIAL_STICKY_HEADER_HEIGHT
          )
        )
      )
      && Math.abs(topOffset) <= 1
    );
  });
}

/**
 * Bottom-anchored contentinfo/footer chrome (chat widgets, sticky site footers).
 * Commercial also samples contentinfo nested inside a fixed/sticky ancestor
 * (Olivia chat popover) even when the landmark itself is `position: static`.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 */
function collectBottomAnchoredFooters(snapshot) {
  /** @type {Map<number, import('../runtime/types.js').SnapshotElement>} */
  const byId = new Map(snapshot.elements.map((element) => [element.id, element]));

  return snapshot.elements.filter((element) => {
    if (!isFooterLandmark(element) || !isActiveContent(element)) return false;
    if (element.rect.width <= 0 || element.rect.height <= 0) return false;
    if (isDirectlyBottomAnchored(element)) return true;
    return hasBottomAnchoredAncestor(element, byId);
  });
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isDirectlyBottomAnchored(element) {
  const position = element.computedStyle.position || '';
  if (position !== 'fixed' && position !== 'sticky') return false;
  const bottomOffset = parseStylePx(element.computedStyle.bottom);
  return Number.isFinite(bottomOffset) && Math.abs(bottomOffset) <= 8;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 * @param {Map<number, import('../runtime/types.js').SnapshotElement>} byId
 */
function hasBottomAnchoredAncestor(element, byId) {
  let parentId = element.parentId;
  while (parentId != null) {
    const parent = byId.get(parentId);
    if (!parent) break;
    const position = parent.computedStyle.position || '';
    if (position === 'fixed' || position === 'sticky') {
      const bottomOffset = parseStylePx(parent.computedStyle.bottom);
      // Chat docks sit slightly above the viewport edge (launcher offset).
      if (Number.isFinite(bottomOffset) && bottomOffset >= 0 && bottomOffset <= 120) {
        return true;
      }
    }
    parentId = parent.parentId;
  }
  return false;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @returns {import('./types.js').DomFact[]}
 */
function collectGeometryFacts(snapshot) {
  /** @type {import('./types.js').DomFact[]} */
  const facts = [];
  for (const header of collectTopAnchoredHeaders(snapshot)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.GEOMETRY,
      'geometry.top-anchored-header',
      header,
      {
        position: header.computedStyle.position,
        topOffset: parseStylePx(header.computedStyle.top),
        height: header.rect.height,
        hasAuthoredTransform: hasAuthoredTransform(header),
      },
    ));
  }
  for (const footer of collectBottomAnchoredFooters(snapshot)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.GEOMETRY,
      'geometry.bottom-anchored-footer',
      footer,
      {
        position: footer.computedStyle.position,
        bottomOffset: parseStylePx(footer.computedStyle.bottom),
        height: footer.rect.height,
      },
    ));
  }
  return facts;
}

export {
  collectTopAnchoredHeaders,
  collectBottomAnchoredFooters,
  collectGeometryFacts,
};
