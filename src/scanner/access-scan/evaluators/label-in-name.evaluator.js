import {
  deriveVisibleLabel,
  isInteractiveControl,
} from './lib/visible-label.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  normalizeText,
  queryCandidates,
} from './lib/runtime-context.js';

const LANDMARK_ROLES = new Set([
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
]);

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function isLandmark(element) {
  if (['header', 'footer', 'main', 'nav', 'aside', 'form'].includes(element.tag)) {
    return true;
  }
  const role = element.attributes.role;
  return Boolean(role && LANDMARK_ROLES.has(role));
}

/**
 * @param {{ visibleText?: string, accessibleName?: string }=} input
 */
export function visibleTextIsInAccessibleName(input = {}) {
  const visible = normalizeText(input.visibleText);
  const accessible = normalizeText(input.accessibleName);
  return Boolean(visible && accessible && accessible.includes(visible));
}

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'label-in-name',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      if (isLandmark(element) || !isInteractiveControl(element)) continue;
      if (!element.attributes['aria-label'] && !element.attributes['aria-labelledby']) continue;

      const visibleText = deriveVisibleLabel(snapshot, indexes, element);
      if (!visibleText) continue;

      const accessibleName = element.accessibleName || '';
      if (!visibleTextIsInAccessibleName({ visibleText, accessibleName })) {
        findings.push(elementFinding(element, {
          visibleText,
          accessibleName: normalizeText(accessibleName),
        }));
      }
    }

    return {
      status: 'complete',
      candidatesScanned: candidates.length,
      findings,
    };
  },
};
