import { visibleTextIsInAccessibleName } from '../policies/lib/accessible-name.js';
import { completeStandardsPolicy } from '../policies/standards.js';
import { getCachedSignalBundle } from './lib/signal-bundle-cache.js';

export { visibleTextIsInAccessibleName };

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'label-in-name',
  async evaluate(context, check) {
    const bundle = getCachedSignalBundle(context);
    const result = completeStandardsPolicy('label-in-name', bundle, context);
    if (check.options?.excludeShadowRoots !== true) {
      return result;
    }
    return {
      ...result,
      findings: result.findings.filter((finding) => finding.element.shadowPath.length === 0),
    };
  },
};
