import { elementFinding } from '../../evaluators/lib/runtime-context.js';

/**
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {number} elementId
 */
export function resolveElementById(indexes, elementId) {
  return indexes.byElementId.get(elementId) || null;
}

/**
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {number[]} elementIds
 */
export function resolveElementsById(indexes, elementIds) {
  return elementIds
    .map((elementId) => resolveElementById(indexes, elementId))
    .filter(Boolean);
}

/**
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../signals/types.js').DomFact} fact
 */
export function resolveSubject(indexes, fact) {
  return resolveElementById(indexes, fact.subject.elementId);
}

/**
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../signals/types.js').DomFact} fact
 * @param {Record<string, unknown>} evidence
 */
export function findingFromFact(indexes, fact, evidence = {}) {
  const element = resolveSubject(indexes, fact);
  if (!element) return null;
  return elementFinding(element, evidence);
}

/**
 * @param {import('../../signals/types.js').SignalBundle} bundle
 * @param {string} kind
 */
export function factsByKind(bundle, kind) {
  return bundle.facts.filter((fact) => fact.kind === kind);
}
