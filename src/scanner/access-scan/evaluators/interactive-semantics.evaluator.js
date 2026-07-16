import { getAncestors, getDescendants } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'interactive-semantics',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'button-mismatch') {
      const successfulButtons = snapshot.elements
        .filter((candidate) => candidate.tag === 'button' && candidate.rendered && candidate.focusable)
        .map((button) => elementFinding(button).element);

      for (const element of candidates) {
        if (isActionAnchor(element)) {
          findings.push(elementFinding(element, { successfulElements: successfulButtons }));
          continue;
        }
        if (isUnsemanticClickableHeadingText(snapshot, indexes, element)) {
          findings.push(elementFinding(element, {
            successfulElements: successfulButtons,
            inferredFrom: 'pointer-text-adjacent-to-heading-link',
          }));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported interactive-semantics mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isActionAnchor(element) {
  if (element.tag !== 'a' || element.attributes.role === 'button') return false;
  const href = (element.attributes.href ?? '').trim().toLowerCase();
  return href === '' || href === '#' || href.startsWith('javascript:');
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isUnsemanticClickableHeadingText(snapshot, indexes, element) {
  if (
    element.tag !== 'span'
    || element.attributes.role
    || element.focusable
    || element.computedStyle.cursor !== 'pointer'
    || !(element.visibleText || element.text).trim()
  ) {
    return false;
  }

  const heading = getAncestors(snapshot, indexes, element)
    .find((ancestor) => /^h[1-6]$/.test(ancestor.tag));
  if (!heading) return false;

  return getDescendants(snapshot, indexes, heading, (candidate) => (
    candidate.tag === 'a' && Boolean(candidate.attributes.href)
  )).length > 0;
}
