import {
  getAncestors,
  getDescendants,
  hasAncestor,
  resolveIdRefs,
  resolveScopedDomId,
  scopeKey,
} from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
} from './lib/runtime-context.js';

const EXCLUDED_WIDGET_ROLES = new Set([
  'listbox', 'combobox', 'menu', 'menubar', 'dialog', 'disclosure',
]);

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'tab-graph',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'tablist-role-explicit') {
      const groups = groupTabsByContainer(snapshot, indexes);
      for (const group of groups) {
        if (group.containerRole === 'tablist') continue;
        if (group.tabs.length < 2) continue;
        findings.push(elementFinding(group.container));
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tablist-role-inferred') {
      for (const inferred of inferRolelessTabInterfaces(snapshot, indexes)) {
        findings.push(elementFinding(inferred.container));
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-mismatch-explicit') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tablist') continue;
        const tabs = getDescendants(snapshot, indexes, element, (child) => (
          child.attributes.role === 'tab'
        ));
        if (tabs.length > 0) continue;
        const interactives = getDescendants(snapshot, indexes, element, (child) => (
          isInteractiveTabDescendant(child)
        ));
        for (const child of interactives) {
          findings.push(elementFinding(child));
        }
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-mismatch-inferred') {
      for (const inferred of inferRolelessTabInterfaces(snapshot, indexes)) {
        for (const trigger of inferred.triggers) {
          findings.push(elementFinding(trigger));
        }
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-panel-mismatch-inferred') {
      for (const inferred of inferRolelessTabInterfaces(snapshot, indexes)) {
        for (const panel of inferred.panels) {
          findings.push(elementFinding(panel));
        }
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-aria-selected') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tab') continue;
        if (!hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.attributes.role === 'tablist')) {
          continue;
        }
        if (element.attributes['aria-selected']) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-aria-controls') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tab') continue;
        if (!hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.attributes.role === 'tablist')) {
          continue;
        }
        if (element.attributes['aria-controls']) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tablist-misuse') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tablist') continue;
        const tabs = getDescendants(snapshot, indexes, element, (child) => child.attributes.role === 'tab');
        if (tabs.length === 0) findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-misuse') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tab') continue;
        if (!hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.attributes.role === 'tablist')) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-panel-mismatch-explicit') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tab') continue;
        const controls = element.attributes['aria-controls'];
        if (!controls) continue;
        for (const domId of controls.split(/\s+/).filter(Boolean)) {
          const panel = resolveScopedDomId(indexes, element, domId);
          if (!panel) continue;
          if (panel.attributes.role === 'tabpanel') continue;
          findings.push(elementFinding(panel));
        }
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tab-panel-misuse') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tabpanel') continue;
        const labelledBy = resolveIdRefs(element, indexes, 'aria-labelledby').resolved;
        const controlsFromTabs = snapshot.elements.some((tab) => {
          if (tab.attributes.role !== 'tab') return false;
          const controls = tab.attributes['aria-controls'];
          const domId = element.attributes.id;
          return controls && domId && controls.split(/\s+/).includes(domId)
            && scopeKey(tab) === scopeKey(element);
        });
        if (labelledBy.length === 0 && !controlsFromTabs) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    if (mode === 'tabpanel-labelledby') {
      for (const element of snapshot.elements) {
        if (element.attributes.role !== 'tabpanel') continue;
        if (element.attributes['aria-labelledby'] || element.attributes['aria-label']) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: snapshot.elements.length, findings };
    }

    throw Object.assign(new Error(`unsupported tab-graph mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function groupTabsByContainer(snapshot, indexes) {
  /** @type {Map<number, { container: import('../runtime/types.js').SnapshotElement, tabs: import('../runtime/types.js').SnapshotElement[], containerRole: string | undefined }>} */
  const groups = new Map();
  for (const element of snapshot.elements) {
    if (element.attributes.role !== 'tab') continue;
    const container = findNearestTabGroup(snapshot, indexes, element);
    if (!container) continue;
    if (!groups.has(container.id)) {
      groups.set(container.id, {
        container,
        tabs: [],
        containerRole: container.attributes.role,
      });
    }
    groups.get(container.id).tabs.push(element);
  }
  return [...groups.values()];
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} tab
 */
function findNearestTabGroup(snapshot, indexes, tab) {
  const ancestors = [tab, ...getAncestors(snapshot, indexes, tab)];
  return ancestors.find((ancestor) => (
    ancestor.attributes.role === 'tablist'
    || ancestor.tag === 'ul'
    || ancestor.tag === 'ol'
    || ancestor.tag === 'div'
    || ancestor.tag === 'section'
    || ancestor.tag === 'nav'
  )) || null;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement[]} triggers
 */
function hasTabStateEvidence(triggers) {
  const hasAriaSelected = triggers.some((trigger) => (
    trigger.attributes['aria-selected'] !== undefined
  ));
  const hasRovingTabindex = triggers.some((trigger) => trigger.attributes.tabindex === '0')
    && triggers.some((trigger) => (
      trigger.attributes.tabindex === '-1'
      || trigger.attributes.tabindex === undefined
    ));
  return hasAriaSelected || hasRovingTabindex;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isInteractiveTabDescendant(element) {
  const role = element.attributes.role || '';
  return (
    element.tag === 'button'
    || element.tag === 'a'
    || element.tag === 'input'
    || role === 'button'
    || role === 'tab'
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function inferRolelessTabInterfaces(snapshot, indexes) {
  /** @type {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[] }>} */
  const results = [];
  const triggers = snapshot.elements.filter((element) => isTabTrigger(element));

  /** @type {Map<number, import('../runtime/types.js').SnapshotElement[]>} */
  const byContainer = new Map();

  for (const trigger of triggers) {
    const panel = resolveTriggerPanel(trigger, indexes);
    if (!panel) continue;
    const container = findLowestCommonContainer(snapshot, indexes, trigger, panel);
    if (!container) continue;
    if (isExcludedWidget(snapshot, indexes, container)) continue;
    if (hasExistingTabRoles(snapshot, indexes, container, trigger, panel)) continue;
    const bucket = byContainer.get(container.id) || [];
    bucket.push(trigger);
    byContainer.set(container.id, bucket);
  }

  for (const [containerId, containerTriggers] of byContainer.entries()) {
    const uniqueTriggers = dedupeElements(containerTriggers);
    if (uniqueTriggers.length < 2) continue;
    const panels = uniqueTriggers
      .map((trigger) => resolveTriggerPanel(trigger, indexes))
      .filter(Boolean);
    const uniquePanels = dedupeElements(panels);
    if (uniquePanels.length < 2 || uniquePanels.length !== uniqueTriggers.length) continue;
    if (!hasTabStateEvidence(uniqueTriggers)) continue;
    const container = indexes.byElementId.get(containerId);
    if (!container) continue;
    results.push({ container, triggers: uniqueTriggers, panels: uniquePanels });
  }

  return dedupeInterfaces(results);
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isTabTrigger(element) {
  if (element.attributes['aria-haspopup']) return false;
  if (element.attributes['aria-expanded'] !== undefined) return false;
  if (element.attributes['aria-controls']) return true;
  const href = element.attributes.href || '';
  return (element.tag === 'a' || element.tag === 'button') && href.startsWith('#') && href.length > 1;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function resolveTriggerPanel(trigger, indexes) {
  const controls = trigger.attributes['aria-controls'];
  const href = trigger.attributes.href || '';
  const domId = controls || (href.startsWith('#') ? href.slice(1) : '');
  if (!domId) return null;
  return resolveScopedDomId(indexes, trigger, domId) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 * @param {import('../runtime/types.js').SnapshotElement} panel
 */
function findLowestCommonContainer(snapshot, indexes, trigger, panel) {
  const triggerAncestors = [trigger, ...getAncestors(snapshot, indexes, trigger)];
  const panelAncestors = new Set([panel.id, ...getAncestors(snapshot, indexes, panel).map((el) => el.id)]);
  return triggerAncestors.find((ancestor) => panelAncestors.has(ancestor.id)) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} container
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 * @param {import('../runtime/types.js').SnapshotElement} panel
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
 * @param {import('../runtime/types.js').SnapshotElement} trigger
 * @param {import('../runtime/types.js').SnapshotElement} panel
 */
function hasExistingTabRoles(snapshot, indexes, container, trigger, panel) {
  if (container.attributes.role === 'tablist') return true;
  if (trigger.attributes.role === 'tab' || panel.attributes.role === 'tabpanel') return true;
  return getDescendants(snapshot, indexes, container, (child) => (
    child.attributes.role === 'tab' || child.attributes.role === 'tabpanel'
  )).length > 0;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement[]} elements
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
 * @param {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[], panels: import('../runtime/types.js').SnapshotElement[] }>} interfaces
 */
function dedupeInterfaces(interfaces) {
  const accepted = [];
  const acceptedTriggerIds = [];
  for (const candidate of interfaces) {
    const triggerIds = new Set(candidate.triggers.map((trigger) => trigger.id));
    const overlaps = acceptedTriggerIds.some((ids) => [...triggerIds].some((id) => ids.has(id)));
    if (overlaps) continue;
    accepted.push(candidate);
    acceptedTriggerIds.push(triggerIds);
  }
  return accepted;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getDirectChildren(snapshot, indexes, element) {
  return snapshot.elements.filter((child) => child.parentId === element.id);
}
