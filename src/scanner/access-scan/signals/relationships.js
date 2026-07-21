import {
  getAncestors, getDescendants, hasAncestor, resolveScopedDomId, sameScope, scopeKey,
} from '../runtime/graph-relationships.js';
import { isFocusableControl, normalizeText } from '../evaluators/lib/runtime-context.js';
import {
  EXCLUDED_WIDGET_ROLES, GLOBAL_INFORMATION_MARKER, SEARCH_ENTRY_INPUT_TYPES, SEARCH_TOKEN,
} from './lib/constants.js';
import {
  dedupeElements, dedupeGroups, getScopedChildren, hasEquivalentRect, isActiveContent,
  isBanner, isFooterLandmark, isMainLandmark, isNavLandmark, isSearchLandmark, isTransparentColor,
  buttonAccessibleText,
} from './lib/dom.js';
import { isSearchInput } from './lib/search.js';
import { createDomFact, SIGNAL_FAMILIES } from './types.js';

function collectVisualTabGroups(snapshot, indexes) {
  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[], activePanel: import('../runtime/types.js').SnapshotElement }>} */
  const groups = [];
  const seenTriggerIds = new Set();

  for (const container of snapshot.elements) {
    if (!isActiveContent(container)) continue;
    const children = getScopedChildren(indexes, container, container)
      .filter((child) => isActiveContent(child));
    const triggers = children.filter(isVisualTabTrigger);
    if (triggers.length < 2 || triggers.length !== children.length) continue;
    if (!hasCommonOrdinalDataAttribute(triggers)) continue;
    if (triggers.some((trigger) => seenTriggerIds.has(trigger.id))) continue;

    const panelSet = findExclusiveVisualPanelSet(snapshot, indexes, container, triggers.length);
    if (!panelSet) continue;
    groups.push({
      container,
      triggers,
      panels: panelSet.panels,
      activePanel: panelSet.activePanel,
    });
    for (const trigger of triggers) seenTriggerIds.add(trigger.id);
  }

  return groups;
}

/**
 * Commercial accessScan often scores job-search chrome (Search / Clear / Locate)
 * as an unlabeled tablist even without exclusive panels. Emit the same visual-tab
 * fact shape so existing TabListMisMatch / TabMismatch policies apply.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectSearchChromeTabGroups(snapshot, indexes) {
  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[], activePanel: import('../runtime/types.js').SnapshotElement }>} */
  const groups = [];
  const seen = new Set();

  for (const container of snapshot.elements) {
    if (!isActiveContent(container) || container.tag !== 'div') continue;
    if (!containerContainsSearchEntryControls(snapshot, indexes, container)) continue;

    const triggers = getDescendants(snapshot, indexes, container, (child) => (
      isActiveContent(child)
      && isFocusableControl(child)
      && (child.tag === 'button' || child.attributes.role === 'button')
      && isSearchChromeActionButton(child)
    ));
    const hasSearchSubmit = triggers.some((trigger) => (
      /(?:^|\b)search(?:\b|$)/i.test(buttonAccessibleText(trigger))
      && !/(?:clear|reset|filter)/i.test(buttonAccessibleText(trigger))
    ));
    const hasClearOrReset = triggers.some((trigger) => (
      /(?:clear|reset)/i.test(buttonAccessibleText(trigger))
    ));
    // Commercial samples the Search + Clear Filter pair; locate-me is optional.
    if (!hasSearchSubmit || !hasClearOrReset || triggers.length < 2) continue;

    // Prefer the tightest container that still holds ≥2 search actions.
    const alreadyCovered = triggers.every((trigger) => seen.has(trigger.id));
    if (alreadyCovered) continue;

    const jobsPanels = findNearbyJobsMountPanels(snapshot, indexes, container);
    groups.push({
      container,
      triggers,
      panels: jobsPanels,
      activePanel: jobsPanels[0] || null,
    });
    for (const trigger of triggers) seen.add(trigger.id);
  }

  // Keep the smallest containers (search wrap over page shell).
  return groups.sort((left, right) => (
    (left.container.rect.width * left.container.rect.height)
    - (right.container.rect.width * right.container.rect.height)
  )).filter((group, index, all) => {
    const triggerIds = new Set(group.triggers.map((trigger) => trigger.id));
    return !all.slice(0, index).some((prior) => (
      prior.triggers.every((trigger) => triggerIds.has(trigger.id))
      || group.triggers.every((trigger) => prior.triggers.some((candidate) => candidate.id === trigger.id))
    ));
  }).slice(0, 3);
}

/**
 * Sibling button strips that use exclusive `.active` / `.current` state (carousels,
 * consent choosers) without ARIA tabs — commercial TabList/TabMismatch samples.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectExclusiveActiveButtonTabGroups(snapshot, indexes) {
  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[], activePanel: import('../runtime/types.js').SnapshotElement | null }>} */
  const groups = [];
  const seen = new Set();

  for (const container of snapshot.elements) {
    if (!isActiveContent(container)) continue;
    const children = getScopedChildren(indexes, container, container)
      .filter((child) => isActiveContent(child));

    /** @type {import('../runtime/types.js').SnapshotElement[]} */
    let triggers = children.filter((child) => (
      isFocusableControl(child)
      && (child.tag === 'button' || child.attributes.role === 'button')
      && child.attributes.role !== 'tab'
      && child.attributes['aria-expanded'] === undefined
      && child.attributes['aria-controls'] === undefined
      && Boolean(buttonAccessibleText(child))
    ));

    // Timeline pattern: wrapper chips with `.current`, each holding one button.
    /** @type {import('../runtime/types.js').SnapshotElement[] | null} */
    let wrapperTriggers = null;
    if (triggers.length < 2) {
      const wrapped = children.map((child) => {
        const nested = getScopedChildren(indexes, child, child).filter((candidate) => (
          isFocusableControl(candidate)
          && (candidate.tag === 'button' || candidate.attributes.role === 'button')
          && candidate.attributes['aria-expanded'] === undefined
          && candidate.attributes['aria-controls'] === undefined
          && Boolean(buttonAccessibleText(candidate))
        ));
        return nested.length === 1 ? { wrapper: child, trigger: nested[0] } : null;
      }).filter(Boolean);
      if (
        wrapped.length >= 2
        && wrapped.length === children.length
        && wrapped.filter(({ wrapper }) => (
          /(?:^|\s)current(?:\s|$)/i.test(` ${wrapper.attributes.class || ''} `)
        )).length === 1
      ) {
        wrapperTriggers = wrapped.map(({ trigger }) => trigger);
        triggers = wrapperTriggers;
      }
    }

    if (triggers.length < 2) continue;
    // Allow decorative non-focusable siblings; reject mixed focusable chrome.
    if (!wrapperTriggers) {
      const otherFocusable = children.filter((child) => (
        isFocusableControl(child) && !triggers.some((trigger) => trigger.id === child.id)
      ));
      if (otherFocusable.length > 0) continue;
    }
    if (triggers.some((trigger) => seen.has(trigger.id))) continue;
    if (!wrapperTriggers && !hasExclusiveActiveState(triggers, indexes)) continue;

    const panelSet = findExclusiveVisualPanelSet(snapshot, indexes, container, triggers.length);
    groups.push({
      container,
      triggers,
      panels: panelSet?.panels || [],
      activePanel: panelSet?.activePanel || null,
    });
    for (const trigger of triggers) seen.add(trigger.id);
  }

  return groups;
}

/**
 * Consent chooser button strips (Accept / Decline / Manage) without ARIA tabs.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectConsentButtonTabGroups(snapshot, indexes) {
  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[], activePanel: null }>} */
  const groups = [];
  const seen = new Set();

  for (const container of snapshot.elements) {
    if (!isActiveContent(container) || container.tag !== 'div') continue;
    const children = getScopedChildren(indexes, container, container)
      .filter((child) => isActiveContent(child));
    const triggers = children.filter((child) => (
      isFocusableControl(child)
      && (child.tag === 'button' || child.attributes.role === 'button')
      && isConsentActionButton(child)
    ));
    if (triggers.length < 2) continue;
    const otherFocusable = children.filter((child) => (
      isFocusableControl(child) && !triggers.some((trigger) => trigger.id === child.id)
    ));
    if (otherFocusable.length > 0) continue;
    if (triggers.some((trigger) => seen.has(trigger.id))) continue;
    if (!triggers.some((trigger) => /accept/i.test(buttonAccessibleText(trigger)))) continue;
    if (!triggers.some((trigger) => /decline|reject|deny/i.test(buttonAccessibleText(trigger)))) {
      continue;
    }

    groups.push({
      container,
      triggers,
      panels: [],
      activePanel: null,
    });
    for (const trigger of triggers) seen.add(trigger.id);
  }

  return groups;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isConsentActionButton(element) {
  const label = buttonAccessibleText(element);
  return /(?:^|\b)(?:accept|decline|reject|deny|manage|settings|consent|agree|disagree)(?:\b|$)/i.test(
    label,
  );
}

/**
 * @param {import('../runtime/types.js').SnapshotElement[]} triggers
 */
function hasExclusiveActiveState(triggers, indexes) {
  const active = triggers.filter((trigger) => {
    const className = ` ${trigger.attributes.class || ''} `;
    return (
      /(?:^|\s)(?:active|current|selected|is-active|is-current)(?:\s|$)/i.test(className)
      || trigger.attributes['aria-pressed'] === 'true'
      || trigger.attributes['aria-current'] === 'true'
    );
  });
  if (active.length === 1) return true;

  // Timeline chips often put `.current` on the parent group wrapper.
  if (!indexes) return false;
  const parents = triggers.map((trigger) => (
    trigger.parentId != null ? indexes.byElementId.get(trigger.parentId) : null
  ));
  if (parents.some((parent) => !parent)) return false;
  const currentParents = parents.filter((parent) => (
    /(?:^|\s)current(?:\s|$)/i.test(` ${parent.attributes.class || ''} `)
  ));
  return currentParents.length === 1;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isSearchChromeActionButton(element) {
  const label = buttonAccessibleText(element);
  return /(?:^|\b)(?:search|clear|reset|filter|locate|use your location)(?:\b|$)/i.test(label);
}

/**
 * Jobs list / pagination mounts near a search chrome container — commercial
 * TabPanelMismatch samples these alongside Search/Clear triggers.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 */
function findNearbyJobsMountPanels(snapshot, indexes, container) {
  const roots = [container, ...getAncestors(snapshot, indexes, container)].slice(0, 8);
  /** @type {import('../runtime/types.js').SnapshotElement[]} */
  const mounts = [];
  for (const root of roots) {
    for (const candidate of [root, ...getDescendants(snapshot, indexes, root)]) {
      const component = candidate.attributes['data-react-component']
        || candidate.attributes['data-component']
        || '';
      const className = candidate.attributes.class || '';
      if (!/(?:jobs-list-only|jobs-pagination|jobs-list|results-list)/i.test(`${component} ${className}`)) {
        continue;
      }
      if (mounts.some((existing) => existing.id === candidate.id)) continue;
      mounts.push(candidate);
    }
    if (mounts.length >= 2) break;
  }
  return mounts.slice(0, 2);
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function isVisualTabTrigger(element) {
  if (
    !isFocusableControl(element)
    || element.attributes.role === 'tab'
    || element.attributes['aria-expanded'] !== undefined
  ) {
    return false;
  }
  return Boolean(buttonAccessibleText(element));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement[]} triggers
 */

function hasCommonOrdinalDataAttribute(triggers) {
  const candidateNames = Object.keys(triggers[0].attributes)
    .filter((name) => name.startsWith('data-'));
  return candidateNames.some((name) => {
    const values = triggers.map((trigger) => trigger.attributes[name]);
    if (values.some((value) => !/^\d+$/.test(value || ''))) return false;
    return new Set(values).size === triggers.length;
  });
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} triggerContainer
 * @param {number} triggerCount
 */

function findExclusiveVisualPanelSet(snapshot, indexes, triggerContainer, triggerCount) {
  const searchRoots = [
    indexes.byElementId.get(triggerContainer.parentId),
    ...getAncestors(snapshot, indexes, triggerContainer),
  ].filter(Boolean).slice(0, 5);

  for (const root of searchRoots) {
    const possibleParents = [root, ...getDescendants(snapshot, indexes, root)];
    for (const parent of possibleParents) {
      if (parent.id === triggerContainer.id) continue;
      const panels = getScopedChildren(indexes, parent, triggerContainer)
        .filter((child) => isActiveContent(child));
      if (panels.length < 2) continue;
      if (panels.some((panel) => isVisualTabTrigger(panel))) continue;

      const activePanels = panels.filter((panel) => (
        panel.effectiveOpacity > 0.1
        && panel.computedStyle.pointerEvents !== 'none'
        && panel.rect.width > 0
        && panel.rect.height > 0
      ));
      const inactivePanels = panels.filter((panel) => (
        panel.effectiveOpacity <= 0.1
        || panel.computedStyle.pointerEvents === 'none'
        || panel.rect.width <= 0
        || panel.rect.height <= 0
      ));
      // Prefer exact trigger/panel cardinality; also accept exclusive carousels
      // where slide count exceeds the labeled trigger count.
      if (
        activePanels.length === 1
        && inactivePanels.length >= 1
        && (panels.length === triggerCount || panels.length > triggerCount)
      ) {
        return { panels: [activePanels[0]], activePanel: activePanels[0] };
      }
    }
  }
  return null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectSeparatedFooterRegions(snapshot, indexes) {
  /** @type {Array<{ footer: import('../runtime/types.js').SnapshotElement, content: import('../runtime/types.js').SnapshotElement }>} */
  const regions = [];

  for (const footer of snapshot.elements.filter((element) => (
    isActiveContent(element)
    && (element.tag === 'footer' || element.attributes.role === 'contentinfo')
  ))) {
    const footerBackground = footer.computedStyle.backgroundColor || '';
    const markers = getDescendants(snapshot, indexes, footer, (child) => (
      GLOBAL_INFORMATION_MARKER.test(child.text || child.visibleText || '')
    ));

    for (const marker of markers) {
      const surface = getAncestors(snapshot, indexes, marker).find((ancestor) => {
        if (ancestor.id === footer.id) return false;
        const background = ancestor.computedStyle.backgroundColor || '';
        return (
          !isTransparentColor(background)
          && background !== footerBackground
        );
      });
      if (!surface) continue;

      let content = marker;
      while (content.parentId != null && content.parentId !== surface.id) {
        const parent = indexes.byElementId.get(content.parentId);
        if (!parent || parent.id === footer.id) break;
        content = parent;
      }

      regions.push({ footer, content });
      break;
    }
  }

  return regions;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectNestedMainBoundaries(snapshot, indexes) {
  /** @type {Array<{ main: import('../runtime/types.js').SnapshotElement, boundary: import('../runtime/types.js').SnapshotElement, depth: number }>} */
  const boundaries = [];

  for (const main of snapshot.elements.filter((element) => (
    isMainLandmark(element) && isActiveContent(element)
  ))) {
    if (normalizeText(main.accessibleName || main.visibleText || main.text || '').length < 50) {
      continue;
    }

    const ancestors = getAncestors(snapshot, indexes, main);
    const bodyIndex = ancestors.findIndex((ancestor) => ancestor.tag === 'body');
    if (bodyIndex < 2) continue;
    const wrappers = ancestors.slice(0, bodyIndex);
    if (wrappers.some((wrapper) => (
      wrapper.tag !== 'div'
      || wrapper.attributes.role
      || !isActiveContent(wrapper)
      || !hasEquivalentRect(wrapper, main)
    ))) {
      continue;
    }

    const hasIsolatedChain = wrappers.every((wrapper, index) => {
      const expectedChild = index === 0 ? main : wrappers[index - 1];
      const activeChildren = getScopedChildren(indexes, wrapper, main)
        .filter(isActiveContent);
      return activeChildren.length === 1 && activeChildren[0].id === expectedChild.id;
    });
    if (!hasIsolatedChain) continue;

    const body = ancestors[bodyIndex];
    const boundary = wrappers.at(-1);
    if (!boundary || boundary.parentId !== body.id) continue;
    const siblings = getScopedChildren(indexes, body, body)
      .filter((element) => element.id !== boundary.id && isActiveContent(element));
    const hasBannerSibling = siblings.some((element) => (
      isBanner(element)
      || getDescendants(snapshot, indexes, element, isBanner).length > 0
    ));
    const hasFooterSibling = siblings.some((element) => (
      isFooterLandmark(element)
      || getDescendants(snapshot, indexes, element, isFooterLandmark).length > 0
    ));
    if (!hasBannerSibling || !hasFooterSibling) continue;

    boundaries.push({ main, boundary, depth: wrappers.length });
  }

  return boundaries;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectWrappedFooterRegions(snapshot, indexes) {
  /** @type {Array<{ footer: import('../runtime/types.js').SnapshotElement, content: import('../runtime/types.js').SnapshotElement }>} */
  const regions = [];

  for (const footer of snapshot.elements.filter((element) => (
    isFooterLandmark(element) && isActiveContent(element)
  ))) {
    const content = footer.parentId != null
      ? indexes.byElementId.get(footer.parentId)
      : null;
    if (
      !content
      || content.tag !== 'div'
      || content.attributes.role
      || !isActiveContent(content)
      || !sameScope(content, footer)
      || !hasEquivalentRect(content, footer)
    ) {
      continue;
    }

    const activeChildren = getScopedChildren(indexes, content, footer)
      .filter(isActiveContent);
    if (activeChildren.length !== 1 || activeChildren[0].id !== footer.id) continue;

    const footerText = normalizeText([
      footer.accessibleName || '',
      footer.visibleText || '',
      footer.text || '',
      ...getDescendants(snapshot, indexes, footer, (child) => Boolean(
        normalizeText(child.visibleText || child.text || ''),
      )).slice(0, 40).map((child) => child.visibleText || child.text || ''),
    ].join(' '));
    const links = getDescendants(snapshot, indexes, footer, (child) => (
      child.tag === 'a' && Boolean(child.attributes.href)
    ));
    // Prefer copyright markers, but commercial also wraps footers that only
    // expose privacy/contact/applicant chrome without a © line.
    if (
      !GLOBAL_INFORMATION_MARKER.test(footerText)
      && !/(?:\bprivacy\b|\bterms\b|\bcontact\b|\bapplicants?\b|\bcareers?\b)/i.test(footerText)
    ) {
      continue;
    }
    if (links.length < 2) continue;

    regions.push({ footer, content });
  }

  return regions;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} left
 * @param {import('../runtime/types.js').SnapshotElement} right
 */

function collectGroupedActionButtons(indexes, snapshot) {
  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[] }>} */
  const groups = [];

  for (const container of snapshot.elements) {
    if (!isActiveContent(container) || container.attributes.role) continue;
    const children = getScopedChildren(indexes, container, container)
      .filter(isActiveContent);
    if (children.length < 3) continue;

    const triggers = children.filter((child) => (
      isFocusableControl(child)
      && (child.tag === 'button' || child.attributes.role === 'button')
      && Boolean(buttonAccessibleText(child))
    ));
    if (triggers.length !== children.length) continue;

    const launchers = triggers.filter((trigger) => (
      trigger.attributes['aria-haspopup'] !== undefined
      || trigger.attributes['aria-controls'] !== undefined
      || trigger.attributes['aria-expanded'] !== undefined
    ));
    if (launchers.length !== 1) continue;
    if (triggers.some((trigger) => trigger.rect.width <= 0 || trigger.rect.height <= 0)) {
      continue;
    }

    const centers = triggers.map((trigger) => trigger.rect.y + trigger.rect.height / 2);
    const verticalSpread = Math.max(...centers) - Math.min(...centers);
    const maximumHeight = Math.max(...triggers.map((trigger) => trigger.rect.height));
    if (verticalSpread > maximumHeight) continue;

    groups.push({ container, triggers, panels: [] });
  }

  return groups;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectDisclosureGroups(snapshot, indexes) {
  const triggers = snapshot.elements.filter(isDisclosureTrigger);
  const subtreeTriggerCounts = buildSubtreeTriggerCounts(triggers, indexes);
  /** @type {Map<number, import('../runtime/types.js').SnapshotElement[]>} */
  const byContainer = new Map();

  for (const trigger of triggers) {
    if (hasIndependentLabelledRegion(snapshot, indexes, trigger)) continue;
    const panel = resolveTriggerPanel(trigger, indexes);
    const container = panel
      ? findLowestCommonContainer(snapshot, indexes, trigger, panel)
      : findTriggerGroupContainer(indexes, trigger, subtreeTriggerCounts);
    if (!container) continue;
    if (hasExistingTabRoles(snapshot, indexes, container)) continue;
    if (isExcludedWidget(snapshot, indexes, container)) continue;
    if (containerContainsSearchEntryControls(snapshot, indexes, container)) continue;
    const bucket = byContainer.get(container.id) || [];
    bucket.push(trigger);
    byContainer.set(container.id, bucket);
  }

  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[] }>} */
  const groups = [];
  for (const [containerId, containerTriggers] of byContainer.entries()) {
    const uniqueTriggers = dedupeElements(containerTriggers);
    if (uniqueTriggers.length < 2) continue;
    const container = indexes.byElementId.get(containerId);
    if (!container) continue;
    const panels = uniqueTriggers
      .map((trigger) => resolveTriggerPanel(trigger, indexes))
      .filter(Boolean);
    if (
      panels.length === 0
      && uniqueTriggers.every((trigger) => Boolean(trigger.attributes['aria-haspopup']))
    ) {
      continue;
    }
    groups.push({
      container,
      triggers: uniqueTriggers,
      panels: dedupeElements(panels),
    });
  }

  return dedupeGroups(groups);
}

/**
 * Reverse aria-labelledby relationships identify independent disclosure regions
 * even when authors omit aria-controls from the trigger.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 */

function isDisclosureTrigger(element) {
  if (!isActiveContent(element) || !isFocusableControl(element)) return false;
  if (element.attributes.role === 'tab') return false;
  return element.attributes['aria-expanded'] !== undefined;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement[]} triggers
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function buildSubtreeTriggerCounts(triggers, indexes) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const trigger of triggers) {
    let current = trigger;
    while (current) {
      counts.set(current.id, (counts.get(current.id) || 0) + 1);
      current = current.parentId != null ? indexes.byElementId.get(current.parentId) : null;
    }
  }
  return counts;
}

/**
 * Horizontal action groups with one launcher and multiple immediate actions.
 *
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').Snapshot} snapshot
 */

function hasIndependentLabelledRegion(snapshot, indexes, trigger) {
  const domId = trigger.attributes.id?.trim();
  if (!domId) return false;

  for (const ancestor of getAncestors(snapshot, indexes, trigger).slice(0, 3)) {
    const localTriggers = getDescendants(
      snapshot,
      indexes,
      ancestor,
      isDisclosureTrigger,
    );
    if (localTriggers.length !== 1) continue;

    const labelledRegions = getDescendants(snapshot, indexes, ancestor, (candidate) => (
      candidate.id !== trigger.id
      && (candidate.attributes['aria-labelledby'] || '').split(/\s+/).includes(domId)
      && getDescendants(
        snapshot,
        indexes,
        candidate,
        (descendant) => descendant.id === trigger.id,
      ).length === 0
    ));
    if (labelledRegions.length === 0) continue;

    const hasVisuallyExposedRegion = labelledRegions.some((region) => (
      isActiveContent(region)
      && region.rect.width > 0
      && region.rect.height > 0
    ));
    if (!hasVisuallyExposedRegion) return true;
  }
  return false;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function resolveTriggerPanel(trigger, indexes) {
  const controls = trigger.attributes['aria-controls'];
  if (!controls) return null;
  const domId = controls.split(/\s+/).filter(Boolean)[0];
  if (!domId) return null;
  return resolveScopedDomId(indexes, trigger, domId) || null;
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 * @param {Map<number, number>} subtreeTriggerCounts
 */

function findTriggerGroupContainer(indexes, trigger, subtreeTriggerCounts) {
  let current = trigger.parentId != null ? indexes.byElementId.get(trigger.parentId) : null;
  while (current) {
    if ((subtreeTriggerCounts.get(current.id) || 0) >= 2) {
      return current;
    }
    current = current.parentId != null ? indexes.byElementId.get(current.parentId) : null;
  }
  return null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} left
 * @param {import('../runtime/types.js').SnapshotElement} right
 */

function findLowestCommonContainer(snapshot, indexes, left, right) {
  const leftAncestors = [left, ...getAncestors(snapshot, indexes, left)];
  const rightIds = new Set([right.id, ...getAncestors(snapshot, indexes, right).map((el) => el.id)]);
  return leftAncestors.find((ancestor) => rightIds.has(ancestor.id)) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 */

function hasExistingTabRoles(snapshot, indexes, container) {
  if (container.attributes.role === 'tablist') return true;
  return getDescendants(snapshot, indexes, container, (child) => (
    child.attributes.role === 'tab' || child.attributes.role === 'tabpanel'
  )).length > 0;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 */

function isExcludedWidget(snapshot, indexes, container) {
  if (EXCLUDED_WIDGET_ROLES.has(container.attributes.role || '')) return true;
  if (container.tag === 'details') return true;
  return hasAncestor(snapshot, indexes, container, (ancestor) => (
    EXCLUDED_WIDGET_ROLES.has(ancestor.attributes.role || '') || ancestor.tag === 'details'
  ));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 */

function containerContainsSearchEntryControls(snapshot, indexes, container) {
  return getDescendants(snapshot, indexes, container, (child) => {
    if (!isActiveContent(child)) return false;
    if (child.tag === 'textarea' || child.tag === 'select') return true;
    if (child.attributes.role === 'searchbox' || child.attributes.role === 'combobox') return true;
    if (child.tag !== 'input') return false;
    const type = (child.attributes.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'hidden' || type === 'password') {
      return false;
    }
    if (SEARCH_ENTRY_INPUT_TYPES.has(type)) return true;
    return isSearchInput(snapshot, indexes, child);
  }).length > 0;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 */

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @returns {import('./types.js').DomFact[]}
 */
function collectRelationshipFacts(snapshot, indexes) {
  /** @type {import('./types.js').DomFact[]} */
  const facts = [];

  for (const group of collectGroupedActionButtons(indexes, snapshot)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.grouped-action-buttons',
      group.container,
      { triggerCount: group.triggers.length },
      group.triggers.map((trigger) => trigger.id),
    ));
  }

  for (const group of collectDisclosureGroups(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.disclosure-group',
      group.container,
      {
        triggerCount: group.triggers.length,
        panelCount: group.panels.length,
      },
      [
        ...group.triggers.map((trigger) => trigger.id),
        ...group.panels.map((panel) => panel.id),
      ],
    ));
  }

  for (const group of collectVisualTabGroups(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.visual-tab-group',
      group.container,
      {
        triggerCount: group.triggers.length,
        panelCount: group.panels.length,
        activePanelId: group.activePanel.id,
      },
      [
        ...group.triggers.map((trigger) => trigger.id),
        ...group.panels.map((panel) => panel.id),
      ],
    ));
  }

  for (const group of collectSearchChromeTabGroups(snapshot, indexes)) {
    const evidence = {
      triggerCount: group.triggers.length,
      panelCount: group.panels.length,
    };
    // Only attach activePanelId when jobs mounts act as panels — otherwise
    // Search+Clear chrome alone must not emit TabPanelMismatch.
    if (group.activePanel && group.panels.length > 0) {
      evidence.activePanelId = group.activePanel.id;
    }
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.visual-tab-group',
      group.container,
      evidence,
      [
        ...group.triggers.map((trigger) => trigger.id),
        ...group.panels.map((panel) => panel.id),
      ],
    ));
  }

  for (const group of collectExclusiveActiveButtonTabGroups(snapshot, indexes)) {
    const evidence = {
      triggerCount: group.triggers.length,
      panelCount: group.panels.length,
    };
    if (group.activePanel) {
      evidence.activePanelId = group.activePanel.id;
    }
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.visual-tab-group',
      group.container,
      evidence,
      [
        ...group.triggers.map((trigger) => trigger.id),
        ...group.panels.map((panel) => panel.id),
      ],
    ));
  }

  for (const group of collectConsentButtonTabGroups(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.visual-tab-group',
      group.container,
      {
        triggerCount: group.triggers.length,
        panelCount: 0,
      },
      group.triggers.map((trigger) => trigger.id),
    ));
  }

  for (const region of collectSeparatedFooterRegions(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.separated-footer-region',
      region.content,
      {},
      [region.footer.id],
    ));
  }

  for (const boundary of collectNestedMainBoundaries(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.nested-main-boundary',
      boundary.main,
      { boundaryDepth: boundary.depth },
      [boundary.boundary.id],
    ));
  }

  for (const region of collectWrappedFooterRegions(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.RELATIONSHIPS,
      'relationships.wrapped-footer-region',
      region.content,
      {},
      [region.footer.id],
    ));
  }

  return facts;
}

export {
  collectVisualTabGroups,
  collectRelationshipFacts,
  isVisualTabTrigger,
  hasCommonOrdinalDataAttribute,
  findExclusiveVisualPanelSet,
  collectSeparatedFooterRegions,
  collectNestedMainBoundaries,
  collectWrappedFooterRegions,
  collectGroupedActionButtons,
  collectDisclosureGroups,
  isDisclosureTrigger,
  buildSubtreeTriggerCounts,
  hasIndependentLabelledRegion,
  resolveTriggerPanel,
  findTriggerGroupContainer,
  findLowestCommonContainer,
  hasExistingTabRoles,
  isExcludedWidget,
  containerContainsSearchEntryControls,
};
