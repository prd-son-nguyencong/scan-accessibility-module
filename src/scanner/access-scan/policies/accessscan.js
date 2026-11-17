import { visibleTextIsInAccessibleName } from './lib/accessible-name.js';
import { elementFinding, getIndexes } from '../evaluators/lib/runtime-context.js';
import { redactSensitiveHtml } from '../signals/semantics.js';
import {
  factsByKind, findingFromFact, resolveElementById, resolveSubject,
} from './lib/resolve.js';
import {
  hasAmbiguousControlIds,
  selectSpatiallyDistinctSearchTargets,
} from '../signals/behavior.js';

const PARITY_CLASSIFICATION = 'commercial-parity-heuristic';

/** @type {Record<string, keyof import('../signals/types.js').SignalMetrics>} */
const MODE_METRIC_KEYS = {
  'credential-gate-region-main-mismatch': 'mainLandmarksScanned',
  'credential-gate-region-main-misuse': 'mainLandmarksScanned',
  'credential-gate-visibility-misuse': 'hiddenControlsObserved',
  'credential-gate-page-title': 'mainLandmarksScanned',
  'disclosure-tablist-role': 'disclosureTriggersScanned',
  'disclosure-tab-mismatch': 'disclosureTriggersScanned',
  'disclosure-tab-panel-mismatch': 'disclosurePanelsScanned',
  'sticky-header-semantic': 'topAnchoredHeadersScanned',
  'sticky-footer-semantic': 'bottomAnchoredFootersScanned',
  'current-link-required': 'directLinkNavsScanned',
  'current-link-destination-ambiguous': 'currentDestinationLinksScanned',
  'nav-submenu-breadcrumbs': 'submenuRowsScanned',
  'checkbox-labelledby-value': 'checkboxControlsScanned',
  'search-without-landmark': 'searchInputsScanned',
  'aria-hidden-visible': 'ariaHiddenElementsScanned',
  'structural-visibility-misuse': 'structuralElementsScanned',
  'visual-state-tablist-role': 'visualTabTriggersScanned',
  'visual-state-tab-mismatch': 'visualTabTriggersScanned',
  'visual-state-tab-panel-mismatch': 'visualTabPanelsScanned',
  'separated-footer-region-mismatch': 'footerRegionsScanned',
  'separated-footer-region-misuse': 'footerRegionsScanned',
  'nested-main-boundary-misuse': 'mainBoundariesScanned',
  'nested-main-boundary-mismatch': 'mainBoundariesScanned',
  'wrapped-footer-region-mismatch': 'wrappedFooterRegionsScanned',
  'wrapped-footer-region-misuse': 'wrappedFooterRegionsScanned',
};

const GRAPHIC_SIGNAL_KINDS = new Set([
  'graphics.pointer-transparent-overlay',
  'graphics.input-cue',
  'graphics.hidden-symbol',
  'graphics.repeated-action-symbol',
  'graphics.control-state-indicator',
]);

/**
 * @param {Record<string, unknown>} details
 */
function parityEvidence(details) {
  return {
    classification: PARITY_CLASSIFICATION,
    domObserved: true,
    ...details,
  };
}

/**
 * @param {import('../signals/types.js').SignalBundle} bundle
 * @returns {Set<number>}
 */
function buildGraphicElementIdIndex(bundle) {
  const elementIds = new Set();
  for (const fact of bundle.facts) {
    if (GRAPHIC_SIGNAL_KINDS.has(fact.kind)) {
      elementIds.add(fact.subject.elementId);
    }
  }
  return elementIds;
}

/**
 * @param {import('../signals/types.js').DomFact[]} facts
 */
function selectDisclosureGroupFacts(facts) {
  const groupedActions = facts
    .filter((fact) => fact.kind === 'relationships.grouped-action-buttons')
    .sort((left, right) => left.subject.elementId - right.subject.elementId);
  const firstGroupedActionId = groupedActions[0]?.subject.elementId ?? null;

  const disclosureGroups = facts.filter((fact) => (
    fact.kind === 'relationships.disclosure-group'
    && (firstGroupedActionId == null || fact.subject.elementId < firstGroupedActionId)
  ));

  /** @type {Map<number, import('../signals/types.js').DomFact>} */
  const merged = new Map();
  if (groupedActions[0]) {
    merged.set(groupedActions[0].subject.elementId, groupedActions[0]);
  }
  for (const fact of disclosureGroups) {
    merged.set(fact.subject.elementId, fact);
  }
  return [...merged.values()];
}

/**
 * @param {import('../signals/types.js').SignalBundle} bundle
 * @param {unknown} context
 */
function selectSearchTargetFacts(bundle, context) {
  const snapshot = /** @type {{ snapshot: import('../runtime/types.js').Snapshot }} */ (context).snapshot;
  const indexes = getIndexes(context);
  const searchFacts = factsByKind(bundle, 'behavior.search-unlandmarked');

  /** @type {Map<number, import('../signals/types.js').DomFact>} */
  const stableTargets = new Map();
  /** @type {Map<number, import('../signals/types.js').DomFact>} */
  const ambiguousTargets = new Map();

  for (const fact of searchFacts) {
    const element = resolveSubject(indexes, fact);
    if (!element) continue;
    if (hasAmbiguousControlIds(snapshot, indexes, element)) {
      ambiguousTargets.set(element.id, fact);
      continue;
    }
    if (!stableTargets.has(element.id)) {
      stableTargets.set(element.id, fact);
    }
  }

  if (stableTargets.size > 1) {
    stableTargets.clear();
  }

  const ambiguousValues = [...ambiguousTargets.values()].map((fact) => {
    const element = resolveSubject(indexes, fact);
    return {
      element,
      targetStrategy: String(fact.evidence.targetStrategy || ''),
    };
  }).filter((entry) => entry.element);

  for (const selected of selectSpatiallyDistinctSearchTargets(
    snapshot,
    indexes,
    ambiguousValues,
  )) {
    const fact = ambiguousTargets.get(selected.element.id);
    if (fact) stableTargets.set(selected.element.id, fact);
  }

  return [...stableTargets.values()];
}

/**
 * @param {import('../signals/types.js').SignalBundle} bundle
 * @param {number} gateKey
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function hiddenElementsForGroup(bundle, groupKey, indexes) {
  return factsByKind(bundle, 'semantics.gated-entry.hidden')
    .filter((fact) => fact.evidence.groupKey === groupKey)
    .map((fact) => {
      const element = resolveSubject(indexes, fact);
      if (!element) return null;
      return {
        outerHTML: redactSensitiveHtml(element),
        selector: element.selector,
        framePath: [...element.framePath],
        shadowPath: [...element.shadowPath],
      };
    })
    .filter(Boolean);
}

/**
 * @param {string} mode
 * @param {import('../signals/types.js').SignalBundle} bundle
 * @param {unknown} context
 */
export function applyAccessScanPolicy(mode, bundle, context) {
  const indexes = getIndexes(context);
  /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
  const findings = [];

  if (mode === 'credential-gate-region-main-mismatch') {
    const shell = factsByKind(bundle, 'semantics.gated-entry')
      .find((fact) => fact.evidence.role === 'shell');
    if (shell) {
      const finding = findingFromFact(indexes, shell, parityEvidence({
        structuralPattern: 'credential-gate-shell',
        semanticAssessment: 'credential-gate-may-be-valid-primary-content',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'credential-gate-region-main-misuse') {
    const main = factsByKind(bundle, 'semantics.gated-entry')
      .find((fact) => fact.evidence.role === 'main');
    if (main) {
      const finding = findingFromFact(indexes, main, parityEvidence({
        structuralPattern: 'credential-gate-main',
        semanticAssessment: 'credential-gate-may-be-valid-primary-content',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'credential-gate-visibility-misuse') {
    const body = factsByKind(bundle, 'semantics.gated-entry')
      .find((fact) => fact.evidence.role === 'body');
    if (body) {
      const groupKey = body.evidence.groupKey;
      const finding = findingFromFact(indexes, body, parityEvidence({
        structuralPattern: 'rendered-credential-gate-body',
        semanticAssessment: 'body-is-visibly-rendered',
        successfulHiddenElements: hiddenElementsForGroup(bundle, groupKey, indexes),
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'credential-gate-page-title') {
    const title = factsByKind(bundle, 'semantics.gated-entry')
      .find((fact) => fact.evidence.role === 'title');
    if (title) {
      const finding = findingFromFact(indexes, title, parityEvidence({
        structuralPattern: 'single-token-credential-gate-title',
        semanticAssessment: 'short-title-requires-contextual-review',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'nested-main-boundary-misuse') {
    for (const fact of factsByKind(bundle, 'relationships.nested-main-boundary')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'main-inside-isolated-page-boundary',
        boundaryDepth: fact.evidence.boundaryDepth,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'nested-main-boundary-mismatch') {
    for (const fact of factsByKind(bundle, 'relationships.nested-main-boundary')) {
      const boundaryId = fact.relatedElementIds[0];
      const boundary = resolveElementById(indexes, boundaryId);
      if (!boundary) continue;
      findings.push(elementFinding(boundary, parityEvidence({
        structuralPattern: 'page-boundary-wrapping-main-landmark',
        boundaryDepth: fact.evidence.boundaryDepth,
      })));
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'wrapped-footer-region-mismatch') {
    for (const fact of factsByKind(bundle, 'relationships.wrapped-footer-region')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'global-information-wrapper-around-contentinfo',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'wrapped-footer-region-misuse') {
    for (const fact of factsByKind(bundle, 'relationships.wrapped-footer-region')) {
      const footerId = fact.relatedElementIds[0];
      const footer = resolveElementById(indexes, footerId);
      if (!footer) continue;
      findings.push(elementFinding(footer, parityEvidence({
        structuralPattern: 'contentinfo-inside-equivalent-global-wrapper',
      })));
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'aria-hidden-visible') {
    const graphicElementIds = buildGraphicElementIdIndex(bundle);
    for (const fact of factsByKind(bundle, 'visibility.aria-hidden-exposed')) {
      const element = resolveElementById(indexes, fact.subject.elementId);
      if (!element) continue;
      // Graphics signals, plus non-img hosts that still expose a visual `src`
      // (commercial avatar chips often use <span aria-hidden src="...">).
      const looksGraphic = (
        graphicElementIds.has(fact.subject.elementId)
        || (
          Object.hasOwn(element.attributes, 'src')
          && element.tag !== 'img'
          && element.tag !== 'script'
          && element.tag !== 'iframe'
        )
      );
      if (!looksGraphic) continue;
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'rendered-aria-hidden-root',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'structural-visibility-misuse') {
    for (const fact of factsByKind(bundle, 'visibility.structural-misuse')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: fact.evidence.reason,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'separated-footer-region-mismatch') {
    for (const fact of factsByKind(bundle, 'relationships.separated-footer-region')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'visually-separated-global-information',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'separated-footer-region-misuse') {
    for (const fact of factsByKind(bundle, 'relationships.separated-footer-region')) {
      const footerId = fact.relatedElementIds[0];
      const footer = resolveElementById(indexes, footerId);
      if (!footer) continue;
      findings.push(elementFinding(footer, parityEvidence({
        structuralPattern: 'contentinfo-with-visually-separated-global-information',
      })));
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'disclosure-tablist-role') {
    for (const fact of selectDisclosureGroupFacts(bundle.facts)) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'aria-expanded-disclosure-group',
        triggerCount: fact.evidence.triggerCount,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'disclosure-tab-mismatch') {
    for (const fact of selectDisclosureGroupFacts(bundle.facts)) {
      for (const triggerId of fact.relatedElementIds.slice(0, Number(fact.evidence.triggerCount) || 0)) {
        const trigger = resolveElementById(indexes, triggerId);
        if (!trigger) continue;
        findings.push(elementFinding(trigger, parityEvidence({
          structuralPattern: 'aria-expanded-disclosure-trigger',
        })));
      }
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'disclosure-tab-panel-mismatch') {
    for (const fact of selectDisclosureGroupFacts(bundle.facts)) {
      const triggerCount = Number(fact.evidence.triggerCount) || 0;
      const panelIds = fact.relatedElementIds.slice(triggerCount);
      for (const panelId of panelIds) {
        const panel = resolveElementById(indexes, panelId);
        if (!panel) continue;
        findings.push(elementFinding(panel, parityEvidence({
          structuralPattern: 'aria-expanded-disclosure-panel',
        })));
      }
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'visual-state-tablist-role') {
    for (const fact of factsByKind(bundle, 'relationships.visual-tab-group')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'indexed-controls-with-exclusive-visual-panels',
        triggerCount: fact.evidence.triggerCount,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'visual-state-tab-mismatch') {
    for (const fact of factsByKind(bundle, 'relationships.visual-tab-group')) {
      const triggerCount = Number(fact.evidence.triggerCount) || 0;
      for (const triggerId of fact.relatedElementIds.slice(0, triggerCount)) {
        const trigger = resolveElementById(indexes, triggerId);
        if (!trigger) continue;
        findings.push(elementFinding(trigger, parityEvidence({
          structuralPattern: 'indexed-visual-tab-trigger',
        })));
      }
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'visual-state-tab-panel-mismatch') {
    for (const fact of factsByKind(bundle, 'relationships.visual-tab-group')) {
      const triggerCount = Number(fact.evidence.triggerCount) || 0;
      const panelIds = fact.relatedElementIds.slice(triggerCount);
      if (panelIds.length > 0) {
        for (const panelId of panelIds) {
          const panel = resolveElementById(indexes, panelId);
          if (!panel) continue;
          findings.push(elementFinding(panel, parityEvidence({
            structuralPattern: 'exclusive-active-visual-panel',
          })));
        }
        continue;
      }
      const activePanelId = Number(fact.evidence.activePanelId);
      const activePanel = resolveElementById(indexes, activePanelId);
      if (!activePanel) continue;
      findings.push(elementFinding(activePanel, parityEvidence({
        structuralPattern: 'exclusive-active-visual-panel',
      })));
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'sticky-header-semantic') {
    // When a bottom-anchored chat/footer contentinfo is present, commercial
    // reports FocusNotObscuredFooter and typically omits the sticky header.
    if (factsByKind(bundle, 'geometry.bottom-anchored-footer').length > 0) {
      return complete(mode, findings, bundle);
    }
    for (const fact of factsByKind(bundle, 'geometry.top-anchored-header')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'rendered-top-anchored-semantic-header',
        semanticAssessment: 'semantic-only; requires manual review',
        position: fact.evidence.position,
        topOffset: fact.evidence.topOffset,
        hitTestConfirmed: false,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'sticky-footer-semantic') {
    for (const fact of factsByKind(bundle, 'geometry.bottom-anchored-footer')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'rendered-bottom-anchored-semantic-footer',
        semanticAssessment: 'semantic-only; requires manual review',
        position: fact.evidence.position,
        bottomOffset: fact.evidence.bottomOffset,
        hitTestConfirmed: false,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'current-link-required') {
    for (const fact of factsByKind(bundle, 'behavior.nav-current-link')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'current-link-in-direct-link-navigation',
        semanticAssessment: 'navigation-link-not-form-field',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'current-link-destination-ambiguous') {
    for (const fact of factsByKind(bundle, 'behavior.current-destination-link')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'visually-current-link-destination-group',
        semanticAssessment: 'current-link-destination-may-be-disabled-at-runtime',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'nav-submenu-breadcrumbs') {
    for (const fact of factsByKind(bundle, 'behavior.submenu-row')) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'primary-navigation-submenu-row',
        semanticAssessment: 'primary-navigation-submenu',
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'checkbox-labelledby-value') {
    for (const fact of factsByKind(bundle, 'semantics.checkbox-value')) {
      const visibleText = String(fact.evidence.visibleText || '');
      const accessibleName = String(fact.evidence.accessibleName || '');
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'checkbox-labelledby-value-anomaly',
        visibleText,
        accessibleName,
        labelInNameActuallyPasses: visibleTextIsInAccessibleName({ visibleText, accessibleName }),
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  if (mode === 'search-without-landmark') {
    for (const fact of selectSearchTargetFacts(bundle, context)) {
      const finding = findingFromFact(indexes, fact, parityEvidence({
        structuralPattern: 'search-controls-without-search-landmark',
        targetStrategy: fact.evidence.targetStrategy,
      }));
      if (finding) findings.push(finding);
    }
    return complete(mode, findings, bundle);
  }

  throw Object.assign(new Error(`unsupported commercial-parity mode "${mode}"`), {
    errorCode: 'evaluator_failure',
  });
}

/**
 * @param {string} mode
 * @param {import('../engine/loader.js').EvaluatorResult['findings']} findings
 * @param {import('../signals/types.js').SignalBundle} bundle
 */
function complete(mode, findings, bundle) {
  const metricKey = MODE_METRIC_KEYS[mode];
  return {
    status: 'complete',
    candidatesScanned: metricKey ? bundle.metrics[metricKey] : 0,
    findings,
  };
}

export { MODE_METRIC_KEYS, PARITY_CLASSIFICATION };
