/**
 * Shared resolvers for finding/violation evidence and element scope.
 * Reads top-level fields first, then nested `evidence.observations[]`.
 */

/**
 * @param {Record<string, unknown>} evidence
 * @param {Set<string>} seen
 * @param {Record<string, unknown>[]} slices
 */
function collectEvidenceSlices(evidence, seen, slices) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return;
  }
  const key = JSON.stringify(evidence);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  slices.push(evidence);

  for (const observation of evidence.observations || []) {
    if (observation?.evidence) {
      collectEvidenceSlices(/** @type {Record<string, unknown>} */ (observation.evidence), seen, slices);
    }
  }
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {Record<string, unknown>[]}
 */
export function resolveFindingEvidenceSlices(finding) {
  /** @type {Record<string, unknown>[]} */
  const slices = [];
  const seen = new Set();
  collectEvidenceSlices(finding?.evidence, seen, slices);
  return slices;
}

/**
 * @param {Record<string, unknown> | undefined} element
 * @param {Record<string, unknown>[]} candidates
 * @param {Set<string>} seen
 */
function pushElementCandidate(element, candidates, seen) {
  if (!element || typeof element !== 'object' || Array.isArray(element)) {
    return;
  }
  const key = JSON.stringify(element);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push(element);
}

/**
 * @param {Record<string, unknown>} evidence
 * @param {Record<string, unknown>[]} candidates
 * @param {Set<string>} seen
 */
function collectElementsFromEvidence(evidence, candidates, seen) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return;
  }
  for (const observation of evidence.observations || []) {
    pushElementCandidate(/** @type {Record<string, unknown>} */ (observation?.element), candidates, seen);
    if (observation?.evidence) {
      collectElementsFromEvidence(/** @type {Record<string, unknown>} */ (observation.evidence), candidates, seen);
    }
  }
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {Record<string, unknown>[]}
 */
function resolveFindingElementCandidates(finding) {
  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  const seen = new Set();
  pushElementCandidate(/** @type {Record<string, unknown>} */ (finding?.element), candidates, seen);
  for (const observation of finding?.evidence?.observations || []) {
    pushElementCandidate(/** @type {Record<string, unknown>} */ (observation?.element), candidates, seen);
    if (observation?.evidence) {
      collectElementsFromEvidence(/** @type {Record<string, unknown>} */ (observation.evidence), candidates, seen);
    }
  }
  return candidates;
}

function elementCandidateScore(element) {
  return (
    (element.normalizedHtmlHash ? 8 : 0)
    + (Array.isArray(element.framePath) && element.framePath.length > 0 ? 4 : 0)
    + (Array.isArray(element.shadowPath) && element.shadowPath.length > 0 ? 2 : 0)
    + (element.selector ? 1 : 0)
  );
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {Record<string, unknown>}
 */
export function resolveFindingElement(finding) {
  const candidates = resolveFindingElementCandidates(finding);
  if (candidates.length === 0) {
    return {};
  }
  return [...candidates].sort((left, right) =>
    elementCandidateScore(right) - elementCandidateScore(left)
  )[0];
}

/**
 * @param {Record<string, unknown>} evidence
 * @returns {boolean}
 */
export function isCommercialParityMarker(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return false;
  }
  if (evidence.violationType === 'commercial-parity') {
    return true;
  }
  if (evidence.profile === 'commercial-parity') {
    return true;
  }
  const classification = String(evidence.classification || '');
  return classification === 'commercial-parity'
    || classification === 'commercial-parity-heuristic';
}

/**
 * @param {Record<string, unknown>} evidence
 * @returns {boolean}
 */
export function isStandardsConfirmedMarker(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return false;
  }
  return evidence.violationType === 'confirmed' && evidence.profile === 'standards';
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {boolean}
 */
export function isCommercialParityFinding(finding) {
  return resolveFindingEvidenceSlices(finding).some(isCommercialParityMarker);
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {boolean}
 */
export function isStandardsConfirmedFinding(finding) {
  return resolveFindingEvidenceSlices(finding).some(isStandardsConfirmedMarker);
}
