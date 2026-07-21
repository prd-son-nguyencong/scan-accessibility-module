import {
  getAncestors, getDescendants, hasAncestor, resolveScopedDomId, scopeKey,
} from '../runtime/graph-relationships.js';
import { normalizeText } from '../evaluators/lib/runtime-context.js';
import { CURRENT_ARIA_VALUES, SUBMENU_BUTTON_TOKENS } from './lib/constants.js';
import { isSearchInput } from './lib/search.js';
import {
  buildLinkSemanticSignature, buildNavLandmarkSignature, buildSubmenuRowSignature,
  buttonAccessibleText, dedupeElements, getLinkLabel, getScopedChildren, hasCurrentClass,
  isActiveContent, isNavLandmark, isSearchLandmark,
} from './lib/dom.js';
import { createDomFact, SIGNAL_FAMILIES } from './types.js';

function collectNavigationSignals(snapshot, indexes, scanUrl) {
  /** @type {import('../runtime/types.js').SnapshotElement[]} */
  const currentLinks = [];
  const seenNavSignatures = new Set();
  const seenCurrentLinkSignatures = new Set();

  for (const nav of snapshot.elements.filter((element) => isNavLandmark(element) && isActiveContent(element))) {
    const links = getDescendants(snapshot, indexes, nav, (child) => (
      child.tag === 'a' && Boolean(child.attributes.href)
    ));
    const hasList = getDescendants(snapshot, indexes, nav, (child) => (
      child.tag === 'ul' || child.tag === 'ol'
    )).length > 0;
    if (links.length === 0 || hasList) continue;

    const navSignature = buildNavLandmarkSignature(nav, links);
    if (seenNavSignatures.has(navSignature)) continue;
    seenNavSignatures.add(navSignature);

    for (const link of links) {
      if (!isCurrentNavLink(link, scanUrl)) continue;
      const linkSignature = buildLinkSemanticSignature(link);
      if (seenCurrentLinkSignatures.has(linkSignature)) continue;
      seenCurrentLinkSignatures.add(linkSignature);
      currentLinks.push(link);
    }
  }

  return { currentLinks };
}

/**
 * Visually current navigation destinations may be disabled at runtime.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectCurrentDestinationLinks(snapshot, indexes) {
  const links = snapshot.elements.filter((element) => (
    element.tag === 'a' && Boolean(element.attributes.href)
  ));
  const currentLabels = new Set(
    links
      .filter(hasCurrentClass)
      .map((link) => `${scopeKey(link)}::${getLinkLabel(link)}`)
      .filter((key) => !key.endsWith('::')),
  );
  if (currentLabels.size === 0) return [];

  /** @type {import('../runtime/types.js').SnapshotElement[]} */
  const matches = [];
  for (const key of currentLabels) {
    const group = links.filter((link) => (
      `${scopeKey(link)}::${getLinkLabel(link)}` === key
      && hasAncestor(snapshot, indexes, link, isNavLandmark)
      && (
        isActiveContent(link)
        || hasAncestor(snapshot, indexes, link, (ancestor) => (
          isNavLandmark(ancestor) && ancestor.attributes['aria-hidden'] === 'true'
        ))
      )
    ));
    if (group.length >= 2) matches.push(...group);
  }
  return matches;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 */

function isCurrentNavLink(link, scanUrl) {
  const ariaCurrent = normalizeText(link.attributes['aria-current']);
  if (CURRENT_ARIA_VALUES.has(ariaCurrent)) return true;
  if (hasCurrentClass(link)) return true;
  if (!scanUrl || scanUrl.startsWith('about:')) return false;
  try {
    const current = new URL(scanUrl);
    const destination = new URL(link.attributes.href || '', current);
    // Root landing pages always have logo/home anchors pointing at `/`.
    // Require an explicit current cue there to avoid RequiredFormField EXTRAs.
    if (current.pathname === '/' || current.pathname === '') return false;
    return (
      destination.pathname === current.pathname
      && destination.search === current.search
      && destination.hash === current.hash
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function collectSubmenuRows(snapshot, indexes) {
  /** @type {import('../runtime/types.js').SnapshotElement[]} */
  const rows = [];
  const seenRowSignatures = new Set();

  for (const nav of snapshot.elements.filter((element) => isNavLandmark(element) && isActiveContent(element))) {
    for (const row of getDescendants(snapshot, indexes, nav)) {
      if (/(?:branding|logo-wrap|brand-wrap|nav__brand)/i.test(row.attributes.class || '')) {
        continue;
      }
      const children = getScopedChildren(indexes, row, row);
      const links = children.filter((child) => child.tag === 'a' && Boolean(child.attributes.href));
      const buttons = children.filter((child) => (
        child.tag === 'button' || child.attributes.role === 'button'
      ));
      // Breadcrumb/submenu parity is a compact link+disclosure pair — not a
      // full primary-nav toolbar that happens to include one mega-menu button.
      if (links.length === 0 || buttons.length === 0) continue;
      if (links.length > 2 || buttons.length > 2 || children.length > 4) continue;
      // Branding rows are usually logo + utility link, not breadcrumbs.
      if (links.length >= 2 && links.every((link) => !(link.visibleText || link.text || '').trim())) {
        continue;
      }

      const link = links[0];
      const button = buttons.find((candidate) => candidate.id !== link.id) || buttons[0];
      if (!link || !button || button.id === link.id) continue;
      const disclosed = hasDisclosureEvidence(button, indexes);
      if (
        !disclosed
        && !hasGenericSubmenuButtonLabel(button)
        && !hasNestedSubnavigation(snapshot, indexes, row)
        && !hasAdjacentSiblingLinkPanel(indexes, row, snapshot, indexes)
      ) {
        continue;
      }
      // Generic hamburger/chrome toggles sit beside logo + wrapper nodes.
      // Keep token/adjacent matching for true compact link+control pairs only.
      if (!disclosed && children.length > 2) continue;
      const signature = buildSubmenuRowSignature(link, button);
      if (seenRowSignatures.has(signature)) continue;
      seenRowSignatures.add(signature);
      rows.push(row);
    }
  }

  return dedupeElements(rows);
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} parent
 * @param {import('../runtime/types.js').SnapshotElement} scopeElement
 */

function hasDisclosureEvidence(button, indexes) {
  if (button.attributes['aria-expanded'] !== undefined) return true;
  if (button.attributes['aria-haspopup'] !== undefined) return true;
  const controls = button.attributes['aria-controls'];
  if (!controls) return false;
  const domId = controls.split(/\s+/).filter(Boolean)[0];
  return Boolean(domId && resolveScopedDomId(indexes, button, domId));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} button
 */

function hasGenericSubmenuButtonLabel(button) {
  return SUBMENU_BUTTON_TOKENS.test(buttonAccessibleText(button));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} button
 */

function hasAdjacentSiblingLinkPanel(indexes, row, snapshot, rowIndexes) {
  const parent = row.parentId != null ? indexes.byElementId.get(row.parentId) : null;
  if (!parent) return false;
  const siblings = getScopedChildren(indexes, parent, row);
  return siblings.some((sibling) => {
    if (sibling.id === row.id) return false;
    return getDescendants(snapshot, rowIndexes, sibling, (child) => (
      child.tag === 'a' && Boolean(child.attributes.href) && isActiveContent(child)
    )).length > 0;
  });
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} row
 */

function hasNestedSubnavigation(snapshot, indexes, row) {
  return getDescendants(snapshot, indexes, row, (child) => (
    child.tag === 'ul'
    || child.tag === 'ol'
    || child.tag === 'nav'
    || child.attributes.role === 'navigation'
  )).length > 0;
}

/**
 * Repeated responsive copies commonly reuse control IDs. Adjacent copies are
 * left alone because their identity is ambiguous. Equivalent groups separated
 * into distinct page regions are one semantic search pattern, so report one.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {Array<{ element: import('../runtime/types.js').SnapshotElement, targetStrategy: string }>} targets
 */

function selectSpatiallyDistinctSearchTargets(snapshot, indexes, targets) {
  /** @type {Map<string, Array<{ element: import('../runtime/types.js').SnapshotElement, targetStrategy: string }>>} */
  const bySignature = new Map();
  for (const target of targets) {
    const signature = buildSearchGroupSignature(snapshot, indexes, target.element);
    const bucket = bySignature.get(signature) || [];
    bucket.push(target);
    bySignature.set(signature, bucket);
  }

  const selected = [];
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => left.element.rect.y - right.element.rect.y);
    const maximumHeight = Math.max(...ordered.map(({ element }) => element.rect.height), 1);
    const minimumSeparation = Math.max(400, maximumHeight * 4);
    const spread = ordered.at(-1).element.rect.y - ordered[0].element.rect.y;
    if (spread <= minimumSeparation) continue;
    selected.push(ordered[0]);
  }
  return selected;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 */

function buildSearchGroupSignature(snapshot, indexes, container) {
  const controls = getDescendants(snapshot, indexes, container, (child) => (
    ['input', 'select', 'textarea'].includes(child.tag)
  )).map((control) => normalizeText([
    control.tag,
    control.attributes.type,
    control.accessibleName,
    control.attributes['aria-label'],
    control.attributes.placeholder,
    control.attributes.name,
  ].filter(Boolean).join(':'))).sort();
  const actions = getDescendants(snapshot, indexes, container, (child) => (
    child.tag === 'button'
    || (child.tag === 'input' && ['submit', 'button'].includes(child.attributes.type || ''))
  )).map((action) => buttonAccessibleText(action)).filter(Boolean).sort();
  return `${controls.join('|')}::${actions.join('|')}`;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 */

function hasAmbiguousControlIds(snapshot, indexes, container) {
  const controls = ['input', 'select', 'textarea'].includes(container.tag)
    ? [container]
    : getDescendants(snapshot, indexes, container, (child) => (
      ['input', 'select', 'textarea'].includes(child.tag)
    ));
  return controls.some((control) => {
    const domId = control.attributes.id;
    return Boolean(domId && indexes.ambiguousDomIds.get(scopeKey(control))?.has(domId));
  });
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} input
 */

function inferSearchContainer(snapshot, indexes, input) {
  let current = input.parentId != null ? indexes.byElementId.get(input.parentId) : null;
  while (current && current.tag !== 'body') {
    const controls = getDescendants(snapshot, indexes, current, (child) => (
      ['input', 'select', 'textarea'].includes(child.tag)
    ));
    const hasAction = getDescendants(snapshot, indexes, current, (child) => (
      child.tag === 'button'
      || (child.tag === 'input' && ['submit', 'button'].includes(child.attributes.type || ''))
      || (child.tag === 'a' && Boolean(child.attributes.href))
    )).length > 0;
    if (controls.length >= 2 && hasAction) {
      return { element: current, targetStrategy: 'smallest-multi-control-action-group' };
    }
    current = current.parentId != null ? indexes.byElementId.get(current.parentId) : null;
  }

  const formAncestor = getAncestors(snapshot, indexes, input).find((ancestor) => ancestor.tag === 'form');
  if (formAncestor) {
    return { element: formAncestor, targetStrategy: 'closest-form' };
  }

  return { element: input, targetStrategy: 'search-input' };
}

/**
 * @param {import('../runtime/types.js').SnapshotElement[]} elements
 */

function collectSearchObservations(snapshot, indexes) {
  /** @type {Array<{ element: import('../runtime/types.js').SnapshotElement, targetStrategy: string, inputId: number }>} */
  const observations = [];

  for (const input of snapshot.elements) {
    if (input.tag !== 'input' || !isActiveContent(input)) continue;
    if (!isSearchInput(snapshot, indexes, input)) continue;
    if (hasAncestor(snapshot, indexes, input, isSearchLandmark)) continue;

    const inferred = inferSearchContainer(snapshot, indexes, input);
    observations.push({
      element: inferred.element,
      targetStrategy: inferred.targetStrategy,
      inputId: input.id,
    });
  }

  return observations;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {string} scanUrl
 * @returns {import('./types.js').DomFact[]}
 */
function collectBehaviorFacts(snapshot, indexes, scanUrl) {
  /** @type {import('./types.js').DomFact[]} */
  const facts = [];
  const navigationSignals = collectNavigationSignals(snapshot, indexes, scanUrl);

  for (const link of navigationSignals.currentLinks) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.BEHAVIOR,
      'behavior.nav-current-link',
      link,
      { href: link.attributes.href || '' },
    ));
  }

  for (const link of collectCurrentDestinationLinks(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.BEHAVIOR,
      'behavior.current-destination-link',
      link,
      { href: link.attributes.href || '' },
    ));
  }

  for (const row of collectSubmenuRows(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.BEHAVIOR,
      'behavior.submenu-row',
      row,
      {},
    ));
  }

  for (const observation of collectSearchObservations(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.BEHAVIOR,
      'behavior.search-unlandmarked',
      observation.element,
      {
        targetStrategy: observation.targetStrategy,
        inputId: observation.inputId,
      },
      [observation.inputId],
    ));
  }

  return facts;
}

export {
  collectNavigationSignals,
  collectBehaviorFacts,
  collectCurrentDestinationLinks,
  isCurrentNavLink,
  collectSubmenuRows,
  hasDisclosureEvidence,
  hasGenericSubmenuButtonLabel,
  hasAdjacentSiblingLinkPanel,
  hasNestedSubnavigation,
  selectSpatiallyDistinctSearchTargets,
  buildSearchGroupSignature,
  hasAmbiguousControlIds,
  inferSearchContainer,
};
