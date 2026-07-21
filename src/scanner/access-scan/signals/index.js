import { isMainLandmark, isActiveContent, isNavLandmark } from './lib/dom.js';
import { getSnapshot, getIndexes, getScanUrl } from '../evaluators/lib/runtime-context.js';
import { deepFreeze } from '../runtime/deep-freeze.js';
import { collectVisibilityFacts } from './visibility.js';
import { collectSemanticsFacts } from './semantics.js';
import { collectGeometryFacts } from './geometry.js';
import { collectRelationshipFacts } from './relationships.js';
import { collectBehaviorFacts } from './behavior.js';
import { collectGraphicsFacts } from './graphics.js';
import { freezeSignalValue, SIGNAL_FAMILIES } from './types.js';

/**
 * Collect deeply immutable generic DOM facts across all signal families.
 *
 * @param {unknown} context
 */
export function collectSignalBundle(context) {
  const snapshot = getSnapshot(context);
  const indexes = getIndexes(context);
  const scanUrl = getScanUrl(context);

  const visibilityFacts = collectVisibilityFacts(snapshot, indexes);
  const semanticsFacts = collectSemanticsFacts(snapshot, indexes);
  const geometryFacts = collectGeometryFacts(snapshot);
  const relationshipFacts = collectRelationshipFacts(snapshot, indexes);
  const behaviorFacts = collectBehaviorFacts(snapshot, indexes, scanUrl);
  const graphicsFacts = collectGraphicsFacts(snapshot, indexes);

  const facts = deepFreeze([
    ...visibilityFacts,
    ...semanticsFacts,
    ...geometryFacts,
    ...relationshipFacts,
    ...behaviorFacts,
    ...graphicsFacts,
  ]);

  let hiddenControlsObserved = 0;
  let structuralElementsScanned = 0;
  let footerRegionsScanned = 0;
  let mainBoundariesScanned = 0;
  let wrappedFooterRegionsScanned = 0;
  let disclosureTriggersScanned = 0;
  let disclosurePanelsScanned = 0;
  let visualTabTriggersScanned = 0;
  let visualTabPanelsScanned = 0;
  let currentDestinationLinksScanned = 0;
  let submenuRowsScanned = 0;
  let searchInputsScanned = 0;
  let accessibleNameControlsScanned = 0;

  for (const fact of facts) {
    switch (fact.kind) {
      case 'semantics.gated-entry.hidden':
        hiddenControlsObserved += 1;
        break;
      case 'visibility.structural-misuse':
        structuralElementsScanned += 1;
        break;
      case 'relationships.separated-footer-region':
        footerRegionsScanned += 1;
        break;
      case 'relationships.nested-main-boundary':
        mainBoundariesScanned += 1;
        break;
      case 'relationships.wrapped-footer-region':
        wrappedFooterRegionsScanned += 1;
        break;
      case 'relationships.disclosure-group':
        disclosureTriggersScanned += Number(fact.evidence.triggerCount) || 0;
        disclosurePanelsScanned += Number(fact.evidence.panelCount) || 0;
        break;
      case 'relationships.visual-tab-group':
        visualTabTriggersScanned += Number(fact.evidence.triggerCount) || 0;
        visualTabPanelsScanned += Number(fact.evidence.panelCount) || 0;
        break;
      case 'behavior.current-destination-link':
        currentDestinationLinksScanned += 1;
        break;
      case 'behavior.submenu-row':
        submenuRowsScanned += 1;
        break;
      case 'behavior.search-unlandmarked':
        searchInputsScanned += 1;
        break;
      case 'semantics.accessible-name':
        accessibleNameControlsScanned += 1;
        break;
      default:
        break;
    }
  }

  const metrics = freezeSignalValue({
    mainLandmarksScanned: snapshot.elements.filter(
      (element) => isMainLandmark(element) && isActiveContent(element),
    ).length,
    hiddenControlsObserved,
    disclosureTriggersScanned,
    disclosurePanelsScanned,
    visualTabTriggersScanned,
    visualTabPanelsScanned,
    ariaHiddenElementsScanned: snapshot.elements.filter(
      (element) => element.attributes['aria-hidden'] === 'true',
    ).length,
    structuralElementsScanned,
    footerRegionsScanned,
    mainBoundariesScanned,
    wrappedFooterRegionsScanned,
    topAnchoredHeadersScanned: geometryFacts.length,
    directLinkNavsScanned: snapshot.elements.filter(
      (element) => isNavLandmark(element) && isActiveContent(element),
    ).length,
    currentDestinationLinksScanned,
    submenuRowsScanned,
    checkboxControlsScanned: snapshot.elements.filter((element) => (
      element.tag === 'input' && element.attributes.type === 'checkbox'
    )).length,
    searchInputsScanned,
    graphicsElementsScanned: graphicsFacts.length,
    accessibleNameControlsScanned,
  });

  return deepFreeze({ facts, metrics });
}

export { SIGNAL_FAMILIES, createDomFact, elementRef } from './types.js';
