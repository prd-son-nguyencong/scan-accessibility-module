import { getDescendants, hasAncestor } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'form-relationships',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'form-submit-button-mismatch') {
      for (const element of candidates) {
        const controls = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'button' || (child.tag === 'input' && child.attributes.type === 'submit')
        ));
        if (controls.length === 0) continue;
        const hasSubmit = controls.some(
          (control) => control.tag === 'input' && control.attributes.type === 'submit'
            || (control.tag === 'button' && (control.attributes.type || 'submit') === 'submit'),
        );
        if (hasSubmit) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'form-context-change-warning') {
      for (const element of candidates) {
        const hasOnchange = Boolean(
          element.attributes.onchange || element.attributes.onChange,
        );
        if (!hasOnchange) continue;
        const formAncestor = getAncestorsForm(snapshot, indexes, element);
        const hasSubmit = formAncestor
          ? getDescendants(snapshot, indexes, formAncestor, (child) => (
            (child.tag === 'button' && (child.attributes.type || 'submit') === 'submit')
              || (child.tag === 'input' && child.attributes.type === 'submit')
          )).length > 0
          : false;
        if (hasSubmit) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'main-navigation-mismatch') {
      for (const element of candidates) {
        const links = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'a' && Boolean(child.attributes.href)
        ));
        if (links.length < 3) continue;
        if (!isLikelyPrimaryNavigationLinks(links)) continue;
        if (!hasAncestor(snapshot, indexes, element, (ancestor) => (
          ancestor.tag === 'header' || ancestor.attributes.role === 'banner'
        ))) continue;
        if (hasAncestor(snapshot, indexes, element, (ancestor) => (
          ancestor.tag === 'nav' || ancestor.attributes.role === 'navigation'
        ))) continue;
        if (hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.tag === 'footer')) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'main-navigation-layout-parity') {
      for (const navigation of candidates) {
        const inBanner = (
          navigation.tag === 'header'
          || navigation.attributes.role === 'banner'
          || hasAncestor(snapshot, indexes, navigation, (ancestor) => (
            ancestor.tag === 'header' || ancestor.attributes.role === 'banner'
          ))
        );
        const position = navigation.computedStyle.position || '';
        const isChromeNav = position === 'fixed' || position === 'sticky';
        if (!inBanner && !isChromeNav) continue;

        const layout = getDescendants(snapshot, indexes, navigation, (child) => {
          if (child.tag !== 'div' || child.attributes.role) return false;
          if (child.attributes['aria-hidden'] === 'true') return false;
          if (child.computedStyle.display === 'none') return false;
          if (child.computedStyle.visibility === 'hidden') return false;
          // Absolute/fixed submenu shells are flyouts, not the primary nav layout.
          const position = child.computedStyle.position || '';
          if (position === 'absolute' || position === 'fixed') return false;
          // List-based primary nav rows.
          const listBased = getDescendants(snapshot, indexes, child, (descendant) => {
            if (descendant.tag !== 'ul' && descendant.tag !== 'ol') return false;
            const links = getDescendants(snapshot, indexes, descendant, (link) => (
              link.tag === 'a' && Boolean(link.attributes.href)
            ));
            return links.length >= 3 && isLikelyPrimaryNavigationLinks(links);
          }).length > 0;
          if (listBased) return true;
          // Flex/grid link toolbars without list markup (commercial still wants
          // the wrapper called out when the landmark itself is misused).
          const directLinks = getDescendants(snapshot, indexes, child, (link) => (
            link.tag === 'a' && Boolean(link.attributes.href)
          ));
          return directLinks.length >= 3 && isLikelyPrimaryNavigationLinks(directLinks);
        }).sort((left, right) => left.id - right.id)[0];
        if (!layout) continue;
        findings.push(elementFinding(layout, {
          structuralPattern: 'main-navigation-layout-wrapper',
        }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported form-relationships mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getAncestorsForm(snapshot, indexes, element) {
  let parentId = element.parentId;
  while (parentId != null) {
    const parent = indexes.byElementId.get(parentId);
    if (!parent) break;
    if (parent.tag === 'form') return parent;
    parentId = parent.parentId;
  }
  return null;
}

/**
 * Primary navigation lists are dominated by links that remain in the current
 * browsing context. Utility bars made mostly of new-window account links are
 * not inferred as the site's main navigation.
 *
 * @param {import('../runtime/types.js').SnapshotElement[]} links
 */
function isLikelyPrimaryNavigationLinks(links) {
  const inContext = links.filter((link) => (
    (link.attributes.target || '').toLowerCase() !== '_blank'
  ));
  return inContext.length >= 2 && inContext.length / links.length >= 0.5;
}
