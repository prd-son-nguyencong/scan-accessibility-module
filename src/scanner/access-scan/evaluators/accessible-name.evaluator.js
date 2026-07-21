import {
  getAncestors,
  getDescendants,
  hasNavigationAncestor,
} from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  hasAccessibleName,
  queryCandidates,
} from './lib/runtime-context.js';

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<typeof getIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function hasImageAltDescendant(snapshot, indexes, element) {
  return getDescendants(
    snapshot,
    indexes,
    element,
    (child) => child.tag === 'img' && Boolean(child.attributes.alt?.trim()),
  ).length > 0;
}

/**
 * Authored control names exclude accessible names that only come from nested
 * SVG `<title>` / `<desc>` heuristics — commercial scanners still Bad-Score
 * icon-only close buttons that lack aria-label or visible text.
 *
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function hasAuthoredControlName(element) {
  if (element.attributes['aria-label']?.trim()) return true;
  if (element.attributes['aria-labelledby']?.trim()) return true;
  if (element.attributes.title?.trim()) return true;
  if ((element.visibleText || element.text || '').trim()) return true;
  return false;
}

/**
 * Logo / brand marks often sit in the banner outside a <nav>. Footer wordmarks
 * are also nameless SVG links, but external social glyphs in footers are scored
 * as IconDiscernible (when unlabeled) — not LinkNavigationDiscernible.
 *
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<typeof getIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function hasChromeLandmarkAncestor(snapshot, indexes, element) {
  if (hasNavigationAncestor(snapshot, indexes, element)) return true;
  const ancestors = getAncestors(snapshot, indexes, element);
  const inBanner = ancestors.some((ancestor) => (
    ancestor.tag === 'header' || ancestor.attributes.role === 'banner'
  ));
  if (inBanner && isGraphicOnlyLink(snapshot, indexes, element)) return true;

  const inFooter = ancestors.some((ancestor) => (
    ancestor.tag === 'footer' || ancestor.attributes.role === 'contentinfo'
  ));
  if (!inFooter) return false;
  // Legacy font-icon social glyphs without accessible names.
  if (isFontIconOnlyLink(snapshot, indexes, element)) return true;
  // Brand wordmarks (relative or absolute). External social SVGs use target=_blank.
  if (!isGraphicOnlyLink(snapshot, indexes, element)) return false;
  return (element.attributes.target || '').toLowerCase() !== '_blank';
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<typeof getIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function isFontIconOnlyLink(snapshot, indexes, element) {
  if ((element.visibleText || element.text || '').trim()) return false;
  const children = getDescendants(snapshot, indexes, element, (child) => (
    child.parentId === element.id
  ));
  if (children.length === 0) return false;
  const hasFontIcon = children.some((child) => child.tag === 'i');
  if (!hasFontIcon) return false;
  return children.every((child) => (
    child.tag === 'i'
    || child.tag === 'span'
    || child.tag === 'b'
    || child.tag === 'em'
  ));
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<typeof getIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function isGraphicOnlyLink(snapshot, indexes, element) {
  if ((element.visibleText || element.text || '').trim()) return false;
  // Only authored hosts matter — SVG internals (path/rect/use) are not link content.
  const children = getDescendants(snapshot, indexes, element, (child) => (
    child.parentId === element.id
  ));
  if (children.length === 0) return false;
  const hasGraphic = children.some((child) => (
    child.tag === 'svg' || child.tag === 'img' || child.tag === 'i'
  ));
  if (!hasGraphic) return false;
  return children.every((child) => (
    child.tag === 'svg'
    || child.tag === 'img'
    || child.tag === 'i'
    || child.tag === 'span'
    || child.tag === 'b'
    || child.tag === 'em'
  ));
}

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'accessible-name',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      if (mode === 'button-missing-name') {
        const missing = check.options?.authoredNameOnly
          ? !hasAuthoredControlName(element)
          : !hasAccessibleName(element);
        if (missing) {
          findings.push(elementFinding(element));
        }
        continue;
      }

      if (mode === 'anchor-link-missing-name') {
        const href = element.attributes.href || '';
        if (!href || href === '#') continue;
        if (!hasAccessibleName(element) && !hasImageAltDescendant(snapshot, indexes, element)) {
          findings.push(elementFinding(element));
        }
        continue;
      }

      if (mode === 'nav-link-missing-name') {
        if (!hasChromeLandmarkAncestor(snapshot, indexes, element)) continue;
        const href = (element.attributes.href || '').trim().toLowerCase();
        // Empty/#/javascript anchors are ButtonMismatch territory, not missing names.
        if (!href || href === '#' || href.startsWith('javascript:')) continue;
        if (!hasAccessibleName(element) && !hasImageAltDescendant(snapshot, indexes, element)) {
          findings.push(elementFinding(element));
        }
      }
    }

    return {
      status: 'complete',
      candidatesScanned: candidates.length,
      findings,
    };
  },
};
