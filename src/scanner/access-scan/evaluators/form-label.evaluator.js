import {
  explicitLabelText,
} from './lib/visible-label.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<typeof getIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
function hasFormControlLabel(snapshot, indexes, element) {
  if (explicitLabelText(snapshot, indexes, element).trim()) return true;
  if (element.attributes['aria-label']?.trim()) return true;
  if (element.attributes['aria-labelledby']?.trim()) return true;
  return false;
}

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'form-label',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      if (mode === 'checkbox-missing-label' || mode === 'radio-missing-label') {
        if (!hasFormControlLabel(snapshot, indexes, element)) {
          findings.push(elementFinding(element));
        }
        continue;
      }

      if (mode === 'visual-required-missing-attr') {
        const labelText = explicitLabelText(snapshot, indexes, element);
        const placeholder = element.attributes.placeholder || '';
        const visuallyRequired = labelText.includes('*') || placeholder.includes('*');
        const hasRequiredAttr = (
          'required' in element.attributes
          || element.attributes['aria-required'] === 'true'
        );
        if (visuallyRequired && !hasRequiredAttr) {
          findings.push(elementFinding(element, {
            visuallyRequired,
            hasRequiredAttr,
          }));
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
