import {
  getAncestors,
  getDescendants,
  hasAncestor,
  resolveScopedDomId,
  sameScope,
  scopeKey,
} from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getEvaluatorCache,
  getIndexes,
  getScanUrl,
  getSnapshot,
  isFocusableControl,
  normalizeText,
  parseStylePx,
} from './lib/runtime-context.js';
import { explicitLabelText } from './lib/visible-label.js';
import { visibleTextIsInAccessibleName } from './label-in-name.evaluator.js';

const CACHE_KEY = 'commercialParityPatterns';
const PARITY_CLASSIFICATION = 'commercial-parity-heuristic';
const CURRENT_ARIA_VALUES = new Set(['page', 'step', 'location', 'date', 'time', 'true']);
const SEARCH_TOKEN = /(^|[\s_-])search([\s_-]|$)/;
const SEARCH_ENTRY_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number']);
const SUBMENU_BUTTON_TOKENS = /\b(toggle|menu|submenu|expand|collapse|open|close)\b/i;
const EXCLUDED_HIDDEN_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template']);
const EXCLUDED_WIDGET_ROLES = new Set([
  'listbox', 'combobox', 'menu', 'menubar', 'dialog', 'disclosure',
]);
const COMPOSITE_VISIBILITY_ROLES = new Set([
  'group', 'listbox', 'option', 'slider', 'tab', 'tabpanel',
]);
const SCRIPT_ONLY_TAGS = new Set(['script', 'noscript', 'style', 'template']);
const SENSITIVE_ATTR_NAMES = /(?:^|[-_])(?:token|secret|csrf|password|passwd|auth|session|key)(?:$|[-_])/i;
const GLOBAL_INFORMATION_MARKER = /(?:©|\bcopyright\b|\ball rights\b)/i;

/** @type {Record<string, keyof ReturnType<typeof collectCommercialParityPatterns>['metrics']>} */
const MODE_METRIC_KEYS = {
  'credential-gate-region-main-mismatch': 'credentialGateMainsExamined',
  'credential-gate-region-main-misuse': 'credentialGateMainsExamined',
  'credential-gate-visibility-misuse': 'credentialGateHiddenExamined',
  'credential-gate-page-title': 'credentialGateMainsExamined',
  'disclosure-tablist-role': 'disclosureTriggersExamined',
  'disclosure-tab-mismatch': 'disclosureTriggersExamined',
  'disclosure-tab-panel-mismatch': 'disclosurePanelsExamined',
  'sticky-header-semantic': 'topAnchoredHeadersExamined',
  'current-link-required': 'directLinkNavsExamined',
  'current-link-destination-ambiguous': 'currentDestinationLinksExamined',
  'nav-submenu-breadcrumbs': 'submenuRowsExamined',
  'checkbox-labelledby-value': 'checkboxControlsExamined',
  'search-without-landmark': 'searchInputsExamined',
  'aria-hidden-visible': 'ariaHiddenElementsExamined',
  'structural-visibility-misuse': 'structuralHiddenElementsExamined',
  'visual-state-tablist-role': 'visualTabTriggersExamined',
  'visual-state-tab-mismatch': 'visualTabTriggersExamined',
  'visual-state-tab-panel-mismatch': 'visualTabPanelsExamined',
  'separated-footer-region-mismatch': 'separatedFooterRegionsExamined',
  'separated-footer-region-misuse': 'separatedFooterRegionsExamined',
  'nested-main-boundary-misuse': 'nestedMainBoundariesExamined',
  'wrapped-footer-region-mismatch': 'wrappedFooterRegionsExamined',
  'wrapped-footer-region-misuse': 'wrappedFooterRegionsExamined',
};

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'commercial-parity',
  async evaluate(context, check) {
    const mode = /** @type {string} */ (check.options?.mode);
    const patterns = getPatterns(context);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'credential-gate-region-main-mismatch') {
      if (patterns.credentialGate?.shell) {
        findings.push(elementFinding(patterns.credentialGate.shell, parityEvidence({
          structuralPattern: 'credential-gate-shell',
          semanticAssessment: 'credential-gate-may-be-valid-primary-content',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'credential-gate-region-main-misuse') {
      if (patterns.credentialGate?.main) {
        findings.push(elementFinding(patterns.credentialGate.main, parityEvidence({
          structuralPattern: 'credential-gate-main',
          semanticAssessment: 'credential-gate-may-be-valid-primary-content',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'credential-gate-visibility-misuse') {
      if (patterns.credentialGate?.body) {
        findings.push(elementFinding(patterns.credentialGate.body, parityEvidence({
          structuralPattern: 'rendered-credential-gate-body',
          semanticAssessment: 'body-is-visibly-rendered',
          successfulHiddenElements: patterns.credentialGate.hiddenElements,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'credential-gate-page-title') {
      if (patterns.credentialGate?.title) {
        findings.push(elementFinding(patterns.credentialGate.title, parityEvidence({
          structuralPattern: 'single-token-credential-gate-title',
          semanticAssessment: 'short-title-requires-contextual-review',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'nested-main-boundary-misuse') {
      for (const boundary of patterns.nestedMainBoundaries) {
        findings.push(elementFinding(boundary.main, parityEvidence({
          structuralPattern: 'main-inside-isolated-page-boundary',
          boundaryDepth: boundary.depth,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'wrapped-footer-region-mismatch') {
      for (const region of patterns.wrappedFooterRegions) {
        findings.push(elementFinding(region.content, parityEvidence({
          structuralPattern: 'global-information-wrapper-around-contentinfo',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'wrapped-footer-region-misuse') {
      for (const region of patterns.wrappedFooterRegions) {
        findings.push(elementFinding(region.footer, parityEvidence({
          structuralPattern: 'contentinfo-inside-equivalent-global-wrapper',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'aria-hidden-visible') {
      for (const element of patterns.ariaHiddenVisible) {
        findings.push(elementFinding(element, parityEvidence({
          structuralPattern: 'rendered-aria-hidden-root',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'structural-visibility-misuse') {
      for (const candidate of patterns.structuralVisibilityMisuse) {
        findings.push(elementFinding(candidate.element, parityEvidence({
          structuralPattern: candidate.reason,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'separated-footer-region-mismatch') {
      for (const region of patterns.separatedFooterRegions) {
        findings.push(elementFinding(region.content, parityEvidence({
          structuralPattern: 'visually-separated-global-information',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'separated-footer-region-misuse') {
      for (const region of patterns.separatedFooterRegions) {
        findings.push(elementFinding(region.footer, parityEvidence({
          structuralPattern: 'contentinfo-with-visually-separated-global-information',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'disclosure-tablist-role') {
      for (const group of patterns.disclosureGroups) {
        findings.push(elementFinding(group.container, parityEvidence({
          structuralPattern: 'aria-expanded-disclosure-group',
          triggerCount: group.triggers.length,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'disclosure-tab-mismatch') {
      for (const group of patterns.disclosureGroups) {
        for (const trigger of group.triggers) {
          findings.push(elementFinding(trigger, parityEvidence({
            structuralPattern: 'aria-expanded-disclosure-trigger',
          })));
        }
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'disclosure-tab-panel-mismatch') {
      for (const group of patterns.disclosureGroups) {
        for (const panel of group.panels) {
          findings.push(elementFinding(panel, parityEvidence({
            structuralPattern: 'aria-expanded-disclosure-panel',
          })));
        }
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'visual-state-tablist-role') {
      for (const group of patterns.visualTabGroups) {
        findings.push(elementFinding(group.container, parityEvidence({
          structuralPattern: 'indexed-controls-with-exclusive-visual-panels',
          triggerCount: group.triggers.length,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'visual-state-tab-mismatch') {
      for (const group of patterns.visualTabGroups) {
        for (const trigger of group.triggers) {
          findings.push(elementFinding(trigger, parityEvidence({
            structuralPattern: 'indexed-visual-tab-trigger',
          })));
        }
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'visual-state-tab-panel-mismatch') {
      for (const group of patterns.visualTabGroups) {
        findings.push(elementFinding(group.activePanel, parityEvidence({
          structuralPattern: 'exclusive-active-visual-panel',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'sticky-header-semantic') {
      for (const header of patterns.topAnchoredHeaders) {
        findings.push(elementFinding(header, parityEvidence({
          structuralPattern: 'rendered-top-anchored-semantic-header',
          semanticAssessment: 'semantic-only; requires manual review',
          position: header.computedStyle.position,
          topOffset: parseStylePx(header.computedStyle.top),
          hitTestConfirmed: false,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'current-link-required') {
      for (const link of patterns.currentNavLinks) {
        findings.push(elementFinding(link, parityEvidence({
          structuralPattern: 'current-link-in-direct-link-navigation',
          semanticAssessment: 'navigation-link-not-form-field',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'current-link-destination-ambiguous') {
      for (const link of patterns.currentDestinationLinks) {
        findings.push(elementFinding(link, parityEvidence({
          structuralPattern: 'visually-current-link-destination-group',
          semanticAssessment: 'current-link-destination-may-be-disabled-at-runtime',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'nav-submenu-breadcrumbs') {
      for (const row of patterns.submenuRows) {
        findings.push(elementFinding(row, parityEvidence({
          structuralPattern: 'primary-navigation-submenu-row',
          semanticAssessment: 'primary-navigation-submenu',
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'checkbox-labelledby-value') {
      for (const checkbox of patterns.checkboxLabelAnomalies) {
        findings.push(elementFinding(checkbox.element, parityEvidence({
          structuralPattern: 'checkbox-labelledby-value-anomaly',
          visibleText: checkbox.visibleText,
          accessibleName: checkbox.accessibleName,
          labelInNameActuallyPasses: checkbox.labelInNameActuallyPasses,
        })));
      }
      return complete(mode, findings, patterns);
    }

    if (mode === 'search-without-landmark') {
      for (const target of patterns.searchTargets) {
        findings.push(elementFinding(target.element, parityEvidence({
          structuralPattern: 'search-controls-without-search-landmark',
          targetStrategy: target.targetStrategy,
        })));
      }
      return complete(mode, findings, patterns);
    }

    throw Object.assign(new Error(`unsupported commercial-parity mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

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
 * @param {string} mode
 * @param {import('../engine/loader.js').EvaluatorResult['findings']} findings
 * @param {ReturnType<typeof collectCommercialParityPatterns>} patterns
 */
function complete(mode, findings, patterns) {
  const metricKey = MODE_METRIC_KEYS[mode];
  return {
    status: 'complete',
    candidatesScanned: metricKey ? patterns.metrics[metricKey] : 0,
    findings,
  };
}

/**
 * @param {unknown} context
 */
function getPatterns(context) {
  const cache = getEvaluatorCache(context);
  if (!cache[CACHE_KEY]) {
    cache[CACHE_KEY] = collectCommercialParityPatterns(context);
  }
  return /** @type {ReturnType<typeof collectCommercialParityPatterns>} */ (cache[CACHE_KEY]);
}

/**
 * @param {unknown} context
 */
function collectCommercialParityPatterns(context) {
  const snapshot = getSnapshot(context);
  const indexes = getIndexes(context);
  const scanUrl = getScanUrl(context);

  const credentialGate = collectCredentialGate(snapshot, indexes);
  const disclosureGroups = collectDisclosureGroups(snapshot, indexes);
  const visualTabGroups = collectVisualTabGroups(snapshot, indexes);
  const ariaHiddenVisible = collectAriaHiddenVisible(snapshot, indexes);
  const structuralVisibilityMisuse = collectStructuralVisibilityMisuse(snapshot, indexes);
  const separatedFooterRegions = collectSeparatedFooterRegions(snapshot, indexes);
  const nestedMainBoundaries = collectNestedMainBoundaries(snapshot, indexes);
  const wrappedFooterRegions = collectWrappedFooterRegions(snapshot, indexes);
  const topAnchoredHeaders = collectTopAnchoredHeaders(snapshot);
  const navigationSignals = collectNavigationSignals(snapshot, indexes, scanUrl);
  const currentDestinationLinks = collectCurrentDestinationLinks(snapshot, indexes);
  const submenuResult = collectSubmenuRows(snapshot, indexes);
  const checkboxLabelAnomalies = collectCheckboxLabelAnomalies(snapshot, indexes);
  const searchEvaluation = collectSearchTargets(snapshot, indexes);

  const mainsExamined = snapshot.elements.filter((element) => isMainLandmark(element) && isActiveContent(element)).length;
  const disclosureTriggersExamined = disclosureGroups.reduce(
    (sum, group) => sum + group.triggers.length,
    0,
  );
  const disclosurePanelsExamined = disclosureGroups.reduce((sum, group) => sum + group.panels.length, 0);
  const directLinkNavsExamined = snapshot.elements.filter((element) => isNavLandmark(element) && isActiveContent(element)).length;
  const checkboxControlsExamined = snapshot.elements.filter((element) => (
    element.tag === 'input' && element.attributes.type === 'checkbox'
  )).length;

  return {
    credentialGate,
    disclosureGroups,
    visualTabGroups,
    ariaHiddenVisible,
    structuralVisibilityMisuse,
    separatedFooterRegions,
    nestedMainBoundaries,
    wrappedFooterRegions,
    topAnchoredHeaders,
    currentNavLinks: navigationSignals.currentLinks,
    currentDestinationLinks,
    submenuRows: submenuResult.rows,
    checkboxLabelAnomalies,
    searchTargets: searchEvaluation.targets,
    metrics: {
      credentialGateMainsExamined: mainsExamined,
      credentialGateHiddenExamined: credentialGate?.hiddenElements.length || 0,
      disclosureTriggersExamined,
      disclosurePanelsExamined,
      visualTabTriggersExamined: visualTabGroups.reduce(
        (sum, group) => sum + group.triggers.length,
        0,
      ),
      visualTabPanelsExamined: visualTabGroups.reduce(
        (sum, group) => sum + group.panels.length,
        0,
      ),
      ariaHiddenElementsExamined: snapshot.elements.filter(
        (element) => element.attributes['aria-hidden'] === 'true',
      ).length,
      structuralHiddenElementsExamined: structuralVisibilityMisuse.length,
      separatedFooterRegionsExamined: separatedFooterRegions.length,
      nestedMainBoundariesExamined: nestedMainBoundaries.length,
      wrappedFooterRegionsExamined: wrappedFooterRegions.length,
      topAnchoredHeadersExamined: topAnchoredHeaders.length,
      directLinkNavsExamined,
      currentDestinationLinksExamined: currentDestinationLinks.length,
      submenuRowsExamined: submenuResult.examined,
      checkboxControlsExamined,
      searchInputsExamined: searchEvaluation.examined,
    },
  };
}

/**
 * Active-content semantics: rendered in the accessibility tree without requiring
 * viewport intersection. Below-fold content remains eligible for parity scans.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isActiveContent(element) {
  return element.rendered && !element.hiddenFromAT;
}

/**
 * Top-anchored headers additionally require nonzero geometry for visual relevance.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isVisuallyAnchoredHeader(element) {
  return isActiveContent(element) && element.rect.width > 0 && element.rect.height > 0;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isMainLandmark(element) {
  return element.tag === 'main' || element.attributes.role === 'main';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isFooterLandmark(element) {
  return element.tag === 'footer' || element.attributes.role === 'contentinfo';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isBanner(element) {
  return element.tag === 'header' || element.attributes.role === 'banner';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isNavLandmark(element) {
  return element.tag === 'nav' || element.attributes.role === 'navigation';
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isSearchLandmark(element) {
  return element.tag === 'search' || element.attributes.role === 'search';
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectAriaHiddenVisible(snapshot, indexes) {
  return snapshot.elements.filter((element) => (
    element.attributes['aria-hidden'] === 'true'
    && element.rendered
    && element.rect.width > 0
    && element.rect.height > 0
    && !hasAncestor(
      snapshot,
      indexes,
      element,
      (ancestor) => ancestor.attributes['aria-hidden'] === 'true',
    )
    && (
      isPointerTransparentImageOverlay(snapshot, indexes, element)
      || isInputCueWithStableControl(snapshot, indexes, element)
    )
  ));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
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
  if (element.tag !== 'svg' && element.tag !== 'i') return false;
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
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectStructuralVisibilityMisuse(snapshot, indexes) {
  /** @type {Array<{ element: import('../runtime/types.js').SnapshotElement, reason: string }>} */
  const candidates = [];

  for (const element of snapshot.elements) {
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

    if (
      element.tag === 'body'
      && element.framePath.length > 0
      && (element.rect.width <= 0 || element.rect.height <= 0)
      && !hasMeaningfulDescendant(snapshot, indexes, element)
    ) {
      candidates.push({ element, reason: 'empty-rendered-frame-body' });
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
function isSubstantiallyClippedContainer(snapshot, indexes, element) {
  if (element.tag !== 'div' || element.rect.width <= 0 || element.rect.height <= 0) {
    return false;
  }
  if (participatesInCompositeVisibilityWidget(snapshot, indexes, element)) return false;

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
      if (panels.length !== triggerCount) continue;
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
      if (activePanels.length === 1 && inactivePanels.length === triggerCount - 1) {
        return { panels, activePanel: activePanels[0] };
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

    const footerText = normalizeText(
      footer.accessibleName || footer.visibleText || footer.text || '',
    );
    const links = getDescendants(snapshot, indexes, footer, (child) => (
      child.tag === 'a' && Boolean(child.attributes.href)
    ));
    if (!GLOBAL_INFORMATION_MARKER.test(footerText) || links.length < 2) continue;

    regions.push({ footer, content });
  }

  return regions;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} left
 * @param {import('../runtime/types.js').SnapshotElement} right
 */
function hasEquivalentRect(left, right) {
  return (
    Math.abs(left.rect.x - right.rect.x) <= 2
    && Math.abs(left.rect.y - right.rect.y) <= 2
    && Math.abs(left.rect.width - right.rect.width) <= 2
    && Math.abs(left.rect.height - right.rect.height) <= 2
  );
}

/**
 * @param {string} value
 */
function isTransparentColor(value) {
  return (
    !value
    || value === 'transparent'
    || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(value)
  );
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {import('../runtime/types.js').SnapshotElement} scopeElement
 */
function findScopedBody(snapshot, scopeElement) {
  return snapshot.elements.find((element) => (
    element.tag === 'body'
    && element.framePath.length === scopeElement.framePath.length
    && element.framePath.every((segment, index) => segment === scopeElement.framePath[index])
    && element.shadowPath.length === 0
  )) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {import('../runtime/types.js').SnapshotElement} scopeElement
 */
function findScopedTitle(snapshot, scopeElement) {
  return snapshot.elements.find((element) => (
    element.tag === 'title'
    && element.framePath.length === scopeElement.framePath.length
    && element.framePath.every((segment, index) => segment === scopeElement.framePath[index])
    && element.shadowPath.length === 0
  )) || null;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function redactSensitiveHtml(element) {
  let html = element.outerHTML;
  for (const [name, value] of Object.entries(element.attributes)) {
    if (!shouldRedactAttribute(name, element)) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html
      .replace(new RegExp(`${name}="[^"]*"`, 'gi'), `${name}="[redacted]"`)
      .replace(new RegExp(`${name}='[^']*'`, 'gi'), `${name}='[redacted]'`)
      .replace(new RegExp(`${name}=([^\\s>]+)`, 'gi'), `${name}="[redacted]"`)
      .replace(new RegExp(escaped, 'g'), '[redacted]');
  }
  return html;
}

/**
 * @param {string} name
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function shouldRedactAttribute(name, element) {
  const lowerName = name.toLowerCase();
  if (SENSITIVE_ATTR_NAMES.test(lowerName)) return true;
  if (lowerName === 'value' && (
    element.attributes.type === 'password' || element.attributes.type === 'hidden'
  )) {
    return true;
  }
  return false;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectCredentialGate(snapshot, indexes) {
  for (const main of snapshot.elements.filter((element) => isMainLandmark(element) && isActiveContent(element))) {
    const gateForm = findCredentialForm(snapshot, indexes, main);
    if (!gateForm) continue;

    const body = findScopedBody(snapshot, main);
    if (!body) continue;

    const shell = findCredentialShell(snapshot, indexes, main, body);
    if (!shell || shell.id === main.id) continue;

    const hasOutsideBanner = snapshot.elements.some((element) => (
      isBanner(element)
      && isActiveContent(element)
      && !hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.id === main.id)
      && hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.id === shell.id)
    ));
    if (!hasOutsideBanner) continue;

    const headingTexts = getDescendants(snapshot, indexes, main, (child) => (
      ['h1', 'h2'].includes(child.tag) && isActiveContent(child)
    )).map((heading) => normalizeText(heading.visibleText || heading.text || ''));

    const title = findScopedTitle(snapshot, main);
    const titleText = title?.text || '';
    const normalizedTitle = normalizeText(titleText);
    const titleTokens = normalizedTitle.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || [];
    const titleElement = title && titleTokens.length === 1 && headingTexts.includes(normalizedTitle)
      ? title
      : null;

    return {
      shell,
      main,
      body,
      title: titleElement,
      hiddenElements: collectObservedHiddenElements(snapshot, indexes, shell),
    };
  }

  return null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} main
 */
function findCredentialForm(snapshot, indexes, main) {
  return getDescendants(snapshot, indexes, main, (child) => child.tag === 'form' && isActiveContent(child))
    .find((form) => {
      const credential = getDescendants(snapshot, indexes, form, (input) => {
        if (input.tag !== 'input' || !isActiveContent(input)) return false;
        const autocomplete = normalizeText(input.attributes.autocomplete);
        return (
          input.attributes.type === 'password'
          || autocomplete === 'current-password'
          || autocomplete === 'new-password'
        );
      })[0];
      const submit = getDescendants(snapshot, indexes, form, (control) => (
        isActiveContent(control)
        && (
          (control.tag === 'button' && (control.attributes.type === 'submit' || !control.attributes.type))
          || (control.tag === 'input' && control.attributes.type === 'submit')
        )
      ))[0];
      return Boolean(credential && submit);
    }) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} main
 * @param {import('../runtime/types.js').SnapshotElement} body
 */
function findCredentialShell(snapshot, indexes, main, body) {
  let shell = main;
  while (shell.parentId != null) {
    const parent = indexes.byElementId.get(shell.parentId);
    if (!parent) break;
    if (parent.id === body.id) break;
    if (parent.shadowPath.length === 0 && shell.shadowPath.length > 0) break;
    shell = parent;
  }

  const parent = shell.parentId != null ? indexes.byElementId.get(shell.parentId) : null;
  if (!parent || shell.id === main.id) return null;

  const isDocumentShell = parent.id === body.id;
  const isShadowShell = parent.shadowPath.length === 0 && shell.shadowPath.length > 0;
  return (isDocumentShell || isShadowShell) ? shell : null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} shell
 */
function collectObservedHiddenElements(snapshot, indexes, shell) {
  return getDescendants(snapshot, indexes, shell, (element) => {
    if (EXCLUDED_HIDDEN_TAGS.has(element.tag)) return false;
    if (element.tag === 'input' && element.attributes.type === 'hidden') return true;
    if (element.attributes.hidden !== undefined) return true;
    const display = element.computedStyle.display || '';
    const visibility = element.computedStyle.visibility || '';
    return display === 'none' || visibility === 'hidden';
  }).map((element) => ({
    outerHTML: redactSensitiveHtml(element),
    selector: element.selector,
    framePath: [...element.framePath],
    shadowPath: [...element.shadowPath],
  }));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
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
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectDisclosureGroups(snapshot, indexes) {
  const triggers = snapshot.elements.filter(isDisclosureTrigger);
  const subtreeTriggerCounts = buildSubtreeTriggerCounts(triggers, indexes);
  /** @type {Map<number, import('../runtime/types.js').SnapshotElement[]>} */
  const byContainer = new Map();

  for (const trigger of triggers) {
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
    groups.push({
      container,
      triggers: uniqueTriggers,
      panels: dedupeElements(panels),
    });
  }

  return dedupeGroups(groups);
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
function collectTopAnchoredHeaders(snapshot) {
  return snapshot.elements.filter((element) => {
    if (!isBanner(element) || !isVisuallyAnchoredHeader(element)) return false;
    const position = element.computedStyle.position || '';
    const topOffset = parseStylePx(element.computedStyle.top);
    return (
      (position === 'fixed' || position === 'sticky')
      && Math.abs(topOffset) <= 1
    );
  });
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {string | null} scanUrl
 */
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
 * Commercial scanners may disable a visually current navigation destination at
 * runtime. Infer that mutable group only from explicit current-state semantics,
 * while retaining one hidden mobile-menu copy and excluding unrelated hidden
 * responsive duplicates.
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
function getLinkLabel(link) {
  return normalizeText(link.accessibleName || link.visibleText || link.text);
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 * @param {string | null} scanUrl
 */
function isCurrentNavLink(link, scanUrl) {
  const ariaCurrent = normalizeText(link.attributes['aria-current']);
  if (CURRENT_ARIA_VALUES.has(ariaCurrent)) return true;
  if (hasCurrentClass(link)) return true;
  if (!scanUrl || scanUrl.startsWith('about:')) return false;
  try {
    const current = new URL(scanUrl);
    const destination = new URL(link.attributes.href || '', current);
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
function hasCurrentClass(element) {
  const classAttr = element.attributes.class || '';
  return classAttr.split(/\s+/).some((token) => token.toLowerCase() === 'current');
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectSubmenuRows(snapshot, indexes) {
  /** @type {import('../runtime/types.js').SnapshotElement[]} */
  const rows = [];
  const seenRowSignatures = new Set();
  let examined = 0;

  for (const nav of snapshot.elements.filter((element) => isNavLandmark(element) && isActiveContent(element))) {
    for (const row of getDescendants(snapshot, indexes, nav)) {
      const children = getScopedChildren(indexes, row, row);
      const link = children.find((child) => child.tag === 'a' && Boolean(child.attributes.href));
      const button = children.find((child) => (
        child.tag === 'button' || child.attributes.role === 'button'
      ));
      if (!link || !button) continue;
      examined += 1;
      if (
        !hasDisclosureEvidence(button, indexes)
        && !hasGenericSubmenuButtonLabel(button)
        && !hasNestedSubnavigation(snapshot, indexes, row)
        && !hasAdjacentSiblingLinkPanel(indexes, row, snapshot, indexes)
      ) {
        continue;
      }
      const signature = buildSubmenuRowSignature(link, button);
      if (seenRowSignatures.has(signature)) continue;
      seenRowSignatures.add(signature);
      rows.push(row);
    }
  }

  return { rows: dedupeElements(rows), examined };
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} parent
 * @param {import('../runtime/types.js').SnapshotElement} scopeElement
 */
function getScopedChildren(indexes, parent, scopeElement) {
  return (indexes.childrenByParentId.get(parent.id) || [])
    .filter((child) => sameScope(child, scopeElement));
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} button
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
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
function buttonAccessibleText(button) {
  return normalizeText(
    button.accessibleName
    || button.attributes['aria-label']
    || button.attributes.title
    || button.visibleText
    || button.text
    || '',
  );
}

/**
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} row
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} rowIndexes
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
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectCheckboxLabelAnomalies(snapshot, indexes) {
  /** @type {Array<{ element: import('../runtime/types.js').SnapshotElement, visibleText: string, accessibleName: string, labelInNameActuallyPasses: boolean }>} */
  const anomalies = [];

  for (const element of snapshot.elements) {
    if (element.tag !== 'input' || element.attributes.type !== 'checkbox') continue;
    if (!element.attributes['aria-labelledby'] || !isActiveContent(element)) continue;

    const visibleText = normalizeText(element.attributes.value || '');
    if (!visibleText || visibleText === 'on' || visibleText === 'off') continue;

    const accessibleName = normalizeText(element.accessibleName || '');
    if (!accessibleName || accessibleName === visibleText) continue;

    anomalies.push({
      element,
      visibleText,
      accessibleName,
      labelInNameActuallyPasses: visibleTextIsInAccessibleName({ visibleText, accessibleName }),
    });
  }

  return anomalies;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
function collectSearchTargets(snapshot, indexes) {
  /** @type {Map<number, { element: import('../runtime/types.js').SnapshotElement, targetStrategy: string }>} */
  const targets = new Map();
  let examined = 0;

  for (const input of snapshot.elements) {
    if (input.tag !== 'input' || !isActiveContent(input)) continue;
    examined += 1;
    const domId = input.attributes.id;
    if (domId && indexes.ambiguousDomIds.get(scopeKey(input))?.has(domId)) continue;
    if (!isSearchInput(snapshot, indexes, input)) continue;
    if (hasAncestor(snapshot, indexes, input, isSearchLandmark)) continue;

    const inferred = inferSearchContainer(snapshot, indexes, input);
    if (hasAmbiguousControlIds(snapshot, indexes, inferred.element)) continue;
    if (!targets.has(inferred.element.id)) {
      targets.set(inferred.element.id, inferred);
    }
  }

  return { targets: [...targets.values()], examined };
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
function isSearchInput(snapshot, indexes, input) {
  if (input.attributes.type === 'search' || input.attributes.role === 'searchbox') {
    return true;
  }
  return SEARCH_TOKEN.test(collectSearchSemantics(snapshot, indexes, input));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} input
 */
function collectSearchSemantics(snapshot, indexes, input) {
  const chunks = [
    input.accessibleName,
    input.attributes['aria-label'],
    input.attributes.placeholder,
    input.attributes.name,
    explicitLabelText(snapshot, indexes, input),
    nearbyContainerText(snapshot, indexes, input),
  ];
  return normalizeText(chunks.filter(Boolean).join(' '));
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} input
 */
function nearbyContainerText(snapshot, indexes, input) {
  let current = input.parentId != null ? indexes.byElementId.get(input.parentId) : null;
  const parts = [];
  while (current && current.tag !== 'body' && parts.join(' ').length < 200) {
    if (current.visibleText?.trim()) parts.push(current.visibleText.trim());
    if (current.text?.trim()) parts.push(current.text.trim());
    if (current.accessibleName?.trim()) parts.push(current.accessibleName.trim());
    current = current.parentId != null ? indexes.byElementId.get(current.parentId) : null;
  }
  return parts.join(' ');
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
function dedupeElements(elements) {
  const seen = new Set();
  return elements.filter((element) => {
    if (seen.has(element.id)) return false;
    seen.add(element.id);
    return true;
  });
}

/**
 * @param {Array<{ container: import('../runtime/types.js').SnapshotElement, triggers: import('../runtime/types.js').SnapshotElement[] }>} groups
 */
function dedupeGroups(groups) {
  const accepted = [];
  const acceptedTriggerIds = [];
  for (const group of groups) {
    const triggerIds = new Set(group.triggers.map((trigger) => trigger.id));
    const overlaps = acceptedTriggerIds.some((ids) => [...triggerIds].some((id) => ids.has(id)));
    if (overlaps) continue;
    accepted.push(group);
    acceptedTriggerIds.push(triggerIds);
  }
  return accepted;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} nav
 * @param {import('../runtime/types.js').SnapshotElement[]} links
 */
function buildNavLandmarkSignature(nav, links) {
  const label = normalizeText(nav.accessibleName || nav.attributes['aria-label'] || '');
  const linkSignatures = links.map((link) => buildLinkSemanticSignature(link)).sort().join('|');
  return `${label}::${linkSignatures}`;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 */
function buildLinkSemanticSignature(link) {
  const href = normalizeText(link.attributes.href || '');
  const text = normalizeText(link.visibleText || link.text || link.accessibleName || '');
  return `${href}::${text}`;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} link
 * @param {import('../runtime/types.js').SnapshotElement} button
 */
function buildSubmenuRowSignature(link, button) {
  return `${buildLinkSemanticSignature(link)}::${buttonAccessibleText(button)}`;
}
