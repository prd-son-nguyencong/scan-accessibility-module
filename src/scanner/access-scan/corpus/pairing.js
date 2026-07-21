import { canonicalSha256 } from '../../../reporter/fingerprint.js';
import { extractSemanticDescriptor } from './semantic-fingerprint.js';

/**
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function unwrapEntry(entry = {}) {
  return /** @type {Record<string, unknown>} */ (entry.finding || entry);
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
export function semanticScopeFingerprintForEntry(entry = {}) {
  const descriptor = extractSemanticDescriptor(unwrapEntry(entry));
  const {
    tag,
    role,
    attributes,
    landmarkPath,
    ordinal,
    disambiguator,
  } = descriptor;
  return canonicalSha256(JSON.stringify({
    tag,
    role,
    attributes,
    landmarkPath,
    ...(Number.isInteger(ordinal) ? { ordinal } : {}),
    ...(typeof disambiguator === 'string' && disambiguator.length > 0
      ? { disambiguator }
      : {}),
  }));
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function getEvidence(entry = {}) {
  return /** @type {Record<string, unknown>} */ (unwrapEntry(entry).evidence || {});
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {boolean}
 */
export function scopePathsDifferForEntries(left = {}, right = {}) {
  const leftDescriptor = extractSemanticDescriptor(unwrapEntry(left));
  const rightDescriptor = extractSemanticDescriptor(unwrapEntry(right));
  return JSON.stringify(leftDescriptor.framePath || [])
    !== JSON.stringify(rightDescriptor.framePath || [])
    || JSON.stringify(leftDescriptor.shadowPath || [])
      !== JSON.stringify(rightDescriptor.shadowPath || []);
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {boolean}
 */
export function evidenceMappingDiffersForEntries(left = {}, right = {}) {
  const leftEvidence = getEvidence(left);
  const rightEvidence = getEvidence(right);
  return String(leftEvidence.checkId || '') !== String(rightEvidence.checkId || '')
    || String(leftEvidence.structuralPattern || '') !== String(rightEvidence.structuralPattern || '');
}

/**
 * Deterministic affinity for semantic-best-match changed pairing within a rule.
 *
 * @param {Record<string, unknown>} expectedEntry
 * @param {Record<string, unknown>} actualEntry
 * @returns {number}
 */
export function pairingAffinity(expectedEntry = {}, actualEntry = {}) {
  let score = 0;
  if (semanticScopeFingerprintForEntry(expectedEntry) === semanticScopeFingerprintForEntry(actualEntry)) {
    score += 1000;
  }
  const expectedEvidence = getEvidence(expectedEntry);
  const actualEvidence = getEvidence(actualEntry);
  if (String(expectedEvidence.checkId || '') === String(actualEvidence.checkId || '')) {
    score += 100;
  }
  if (String(expectedEvidence.structuralPattern || '') === String(actualEvidence.structuralPattern || '')) {
    score += 50;
  }
  if (!scopePathsDifferForEntries(expectedEntry, actualEntry)) {
    score += 25;
  }
  return score;
}

/**
 * @param {Record<string, unknown>} expectedEntry
 * @param {Record<string, unknown>} actualEntry
 * @returns {string}
 */
export function pairingTiebreak(expectedEntry = {}, actualEntry = {}) {
  const expectedFingerprint = String(expectedEntry.fingerprint || expectedEntry.key || '');
  const actualFingerprint = String(actualEntry.fingerprint || actualEntry.key || '');
  return `${expectedFingerprint}\0${actualFingerprint}`;
}
