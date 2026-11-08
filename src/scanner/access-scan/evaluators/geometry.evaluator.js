import { withDeadline } from '../engine/deadline.js';
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
      const targets = candidates.filter((element) => (
        element.rendered
        && element.focusable
        && element.rect.width > 0
        && element.rect.height > 0
      ));
      const isUndersized = (element) => (
        element.rect.width < MIN_TARGET_PX || element.rect.height < MIN_TARGET_PX
      );

      /** @type {Map<string, import('../runtime/types.js').SnapshotElement[]>} */
      const targetsByScope = new Map();
      for (const element of targets) {
        const key = scopeKey(element);
        const bucket = targetsByScope.get(key) || [];
        bucket.push(element);
        targetsByScope.set(key, bucket);
      }
      // Sorted by top edge so each element only inspects peers within 24px vertically (plus the tallest peer's height).
      const maxHeightByScope = new Map();
      for (const [key, bucket] of targetsByScope) {
        bucket.sort((a, b) => a.rect.y - b.rect.y);
        maxHeightByScope.set(key, Math.max(...bucket.map((peer) => peer.rect.height)));
      }
      const nearbyPeers = (element, center) => {
        const bucket = targetsByScope.get(scopeKey(element)) || [];
        const from = center.y - MIN_CENTER_SPACING_PX - maxHeightByScope.get(scopeKey(element));
        const to = center.y + MIN_CENTER_SPACING_PX;
        let lo = 0;
        let hi = bucket.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (bucket[mid].rect.y < from) lo = mid + 1; else hi = mid;
        }
        const peers = [];
        for (let i = lo; i < bucket.length && bucket[i].rect.y <= to; i += 1) peers.push(bucket[i]);
        return peers;
      };

      // WCAG 2.5.8: the 24px circle centred on an undersized target must not touch any other target.
      for (const element of withDeadline(targets.filter(isUndersized))) {
        const center = targetCenter(element);
        const tooClose = nearbyPeers(element, center).some((peer) => {
          if (peer.id === element.id) return false;
          if (isUndersized(peer)) {
            return centerDistance(center, targetCenter(peer)) < MIN_CENTER_SPACING_PX;
          }
          return distanceToRect(center, peer.rect) < MIN_CENTER_SPACING_PX / 2;
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

/**
 * @param {{ x: number, y: number }} point
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
function distanceToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}
