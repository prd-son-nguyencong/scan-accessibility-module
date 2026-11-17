import { canonicalSha256 } from '../../reporter/fingerprint.js';
import {
  isCommercialParityMarker,
  isStandardsConfirmedMarker,
  resolveFindingElement,
} from './finding-evidence.js';

/**
 * @param {{ canonicalRuleId?: string, nativeRuleId?: string, ruleId?: string, element?: Record<string, unknown> }} finding
 * @param {Record<string, unknown>} element
 * @returns {string}
 */
export function markerConfirmationIdentity(finding, element = {}) {
  const resolved = element && Object.keys(element).length > 0 ? element : resolveFindingElement(finding);
  return canonicalSha256({
    canonicalRuleId: finding.canonicalRuleId || finding.nativeRuleId || finding.ruleId || '',
    nativeRuleId: finding.nativeRuleId || finding.ruleId || finding.canonicalRuleId || '',
    selector: resolved.selector || '',
    normalizedHtmlHash: resolved.normalizedHtmlHash || null,
    framePath: Array.isArray(resolved.framePath) ? [...resolved.framePath] : [],
    shadowPath: Array.isArray(resolved.shadowPath) ? [...resolved.shadowPath] : [],
  });
}

/**
 * @typedef {'commercial' | 'standards'} MarkerContextType
 * @typedef {{ type: MarkerContextType, element: Record<string, unknown> }} MarkerContext
 */

/**
 * @param {Record<string, unknown>} finding
 * @returns {MarkerContext[]}
 */
function extractMarkerContexts(finding) {
  /** @type {MarkerContext[]} */
  const contexts = [];

  /**
   * @param {Record<string, unknown> | undefined} evidence
   * @param {Record<string, unknown> | undefined} element
   */
  function walkEvidence(evidence, element) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      return;
    }
    if (isCommercialParityMarker(evidence)) {
      contexts.push({
        type: 'commercial',
        element: element && Object.keys(element).length > 0
          ? element
          : resolveFindingElement(finding),
      });
    }
    if (isStandardsConfirmedMarker(evidence)) {
      contexts.push({
        type: 'standards',
        element: element && Object.keys(element).length > 0
          ? element
          : resolveFindingElement(finding),
      });
    }
    for (const observation of evidence.observations || []) {
      walkEvidence(
        /** @type {Record<string, unknown>} */ (observation?.evidence),
        /** @type {Record<string, unknown>} */ (observation?.element) || element,
      );
    }
  }

  walkEvidence(
    /** @type {Record<string, unknown>} */ (finding?.evidence),
    /** @type {Record<string, unknown>} */ (finding?.element),
  );

  return contexts;
}

/**
 * @param {{ canonicalRuleId?: string, nativeRuleId?: string, ruleId?: string, element?: Record<string, unknown> }} finding
 * @returns {string}
 */
export function findingConfirmationIdentity(finding) {
  return markerConfirmationIdentity(finding, resolveFindingElement(finding));
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {boolean}
 */
export function isCommercialParityFinding(finding) {
  return extractMarkerContexts(finding).some((context) => context.type === 'commercial');
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {boolean}
 */
export function isStandardsConfirmedFinding(finding) {
  return extractMarkerContexts(finding).some((context) => context.type === 'standards');
}

/**
 * Commercial findings require an independently confirmed standards marker with
 * the same element identity. Descriptor membership or classification alone
 * never counts as confirmation.
 *
 * @param {{ findings?: Array<Record<string, unknown>> }} fixUnit
 * @returns {boolean}
 */
export function hasIndependentStandardsConfirmation(fixUnit) {
  /** @type {MarkerContext[]} */
  const commercial = [];
  /** @type {MarkerContext[]} */
  const standards = [];

  for (const finding of fixUnit.findings || []) {
    for (const context of extractMarkerContexts(finding)) {
      if (context.type === 'commercial') commercial.push({ finding, ...context });
      if (context.type === 'standards') standards.push({ finding, ...context });
    }
  }

  if (commercial.length === 0) {
    return true;
  }

  return commercial.every((commercialContext) => {
    const identity = markerConfirmationIdentity(
      commercialContext.finding,
      commercialContext.element,
    );
    return standards.some((standardsContext) =>
      markerConfirmationIdentity(standardsContext.finding, standardsContext.element) === identity
    );
  });
}
