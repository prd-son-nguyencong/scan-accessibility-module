import { scopeKey } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

const MIN_TARGET_PX = 24;
const MIN_CENTER_SPACING_PX = 24;

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'geometry',
  async evaluate(context, check) {
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'target-size') {
      const undersized = candidates.filter((element) => (
        element.rendered
        && element.focusable
        && element.rect.width > 0
        && element.rect.height > 0
        && (element.rect.width < MIN_TARGET_PX || element.rect.height < MIN_TARGET_PX)
        && !passesInlineSpacingException(element)
      ));

      /** @type {Map<string, import('../runtime/types.js').SnapshotElement[]>} */
      const undersizedByScope = new Map();
      for (const element of undersized) {
        const key = scopeKey(element);
        const bucket = undersizedByScope.get(key) || [];
        bucket.push(element);
        undersizedByScope.set(key, bucket);
      }

      for (const element of undersized) {
        const peers = undersizedByScope.get(scopeKey(element)) || [];
        if (peers.length <= 1) continue;
        const center = targetCenter(element);
        const tooClose = peers.some((peer) => {
          if (peer.id === element.id) return false;
          return centerDistance(center, targetCenter(peer)) < MIN_CENTER_SPACING_PX;
        });
        if (!tooClose) continue;
        findings.push(elementFinding(element, {
          width: Math.round(element.rect.width),
          height: Math.round(element.rect.height),
        }));
      }

      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported geometry mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * getBoundingClientRect already includes padding — use rect dimensions directly.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function passesInlineSpacingException(element) {
  const style = element.computedStyle;
  const inlineDisplay = style.display === 'inline' || style.display === 'inline-block'
    || style.display === 'inline-flex';
  if (!inlineDisplay) return false;
  return element.rect.width >= MIN_TARGET_PX && element.rect.height >= MIN_TARGET_PX;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function targetCenter(element) {
  return {
    x: element.rect.x + element.rect.width / 2,
    y: element.rect.y + element.rect.height / 2,
  };
}

/**
 * @param {{ x: number, y: number }} left
 * @param {{ x: number, y: number }} right
 */
function centerDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
