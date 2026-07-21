import { resolveIdRefs } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'aria-reference',
  async evaluate(context, check) {
    const indexes = getIndexes(context);
    const attribute = /** @type {string} */ (check.options?.attribute);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      const { missing } = resolveIdRefs(element, indexes, attribute);
      if (missing.length > 0) {
        findings.push(elementFinding(element, {
          attribute,
          missingIds: missing,
          value: element.attributes[attribute],
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
