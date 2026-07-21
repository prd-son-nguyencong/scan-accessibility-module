import { deepFreeze } from '../runtime/deep-freeze.js';

export const SIGNAL_FAMILIES = Object.freeze({
  VISIBILITY: 'visibility',
  SEMANTICS: 'semantics',
  GEOMETRY: 'geometry',
  RELATIONSHIPS: 'relationships',
  GRAPHICS: 'graphics',
  BEHAVIOR: 'behavior',
});

/**
 * @typedef {typeof SIGNAL_FAMILIES[keyof typeof SIGNAL_FAMILIES]} SignalFamily
 *
 * @typedef {object} ElementRef
 * @property {number} elementId
 * @property {string} selector
 * @property {string[]} framePath
 * @property {string[]} shadowPath
 *
 * @typedef {object} DomFact
 * @property {string} kind
 * @property {SignalFamily} family
 * @property {ElementRef} subject
 * @property {number[]} relatedElementIds
 * @property {Record<string, unknown>} evidence
 *
 * @typedef {object} SignalMetrics
 * @property {number} mainLandmarksScanned
 * @property {number} hiddenControlsObserved
 * @property {number} disclosureTriggersScanned
 * @property {number} disclosurePanelsScanned
 * @property {number} visualTabTriggersScanned
 * @property {number} visualTabPanelsScanned
 * @property {number} ariaHiddenElementsScanned
 * @property {number} structuralElementsScanned
 * @property {number} footerRegionsScanned
 * @property {number} mainBoundariesScanned
 * @property {number} wrappedFooterRegionsScanned
 * @property {number} topAnchoredHeadersScanned
 * @property {number} directLinkNavsScanned
 * @property {number} currentDestinationLinksScanned
 * @property {number} submenuRowsScanned
 * @property {number} checkboxControlsScanned
 * @property {number} searchInputsScanned
 * @property {number} graphicsElementsScanned
 * @property {number} accessibleNameControlsScanned
 *
 * @typedef {object} SignalBundle
 * @property {DomFact[]} facts
 * @property {SignalMetrics} metrics
 */

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 * @returns {ElementRef}
 */
export function elementRef(element) {
  return deepFreeze({
    elementId: element.id,
    selector: element.selector,
    framePath: [...element.framePath],
    shadowPath: [...element.shadowPath],
  });
}

/**
 * @param {SignalFamily} family
 * @param {string} kind
 * @param {import('../runtime/types.js').SnapshotElement} element
 * @param {Record<string, unknown>=} evidence
 * @param {number[]=} relatedElementIds
 * @returns {DomFact}
 */
export function createDomFact(family, kind, element, evidence = {}, relatedElementIds = []) {
  return deepFreeze({
    kind,
    family,
    subject: elementRef(element),
    relatedElementIds: deepFreeze([...relatedElementIds]),
    evidence: deepFreeze({ ...evidence }),
  });
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function freezeSignalValue(value) {
  return deepFreeze(value);
}
