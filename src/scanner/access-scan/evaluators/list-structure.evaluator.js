import { getDescendants } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'list-structure',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      const listItems = getDescendants(snapshot, indexes, element, (child) => child.tag === 'li');
      if (listItems.length === 0 && element.attributes['aria-hidden'] !== 'true') {
        findings.push(elementFinding(element));
      }
    }

    return {
      status: 'complete',
      candidatesScanned: candidates.length,
      findings,
    };
  },
};
