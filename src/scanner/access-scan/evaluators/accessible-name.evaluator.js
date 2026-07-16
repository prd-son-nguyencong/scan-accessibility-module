import {
  getDescendants,
  hasNavigationAncestor,
} from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  hasAccessibleName,
  queryCandidates,
} from './lib/runtime-context.js';

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<typeof getIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function hasImageAltDescendant(snapshot, indexes, element) {
  return getDescendants(
    snapshot,
    indexes,
    element,
    (child) => child.tag === 'img' && Boolean(child.attributes.alt?.trim()),
  ).length > 0;
}

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'accessible-name',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      if (mode === 'button-missing-name') {
        if (!hasAccessibleName(element)) {
          findings.push(elementFinding(element));
        }
        continue;
      }

      if (mode === 'anchor-link-missing-name') {
        const href = element.attributes.href || '';
        if (!href || href === '#') continue;
        if (!hasAccessibleName(element) && !hasImageAltDescendant(snapshot, indexes, element)) {
          findings.push(elementFinding(element));
        }
        continue;
      }

      if (mode === 'nav-link-missing-name') {
        if (!hasNavigationAncestor(snapshot, indexes, element)) continue;
        if (!hasAccessibleName(element) && !hasImageAltDescendant(snapshot, indexes, element)) {
          findings.push(elementFinding(element));
        }
      }
    }

    return {
      status: 'complete',
      candidatesScanned: candidates.length,
      findings,
    };
  },
};
