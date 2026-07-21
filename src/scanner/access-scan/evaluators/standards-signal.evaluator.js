import { completeStandardsPolicy } from '../policies/standards.js';
import { getCachedSignalBundle } from './lib/signal-bundle-cache.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'standards-signal',
  async evaluate(context, check) {
    const mode = /** @type {string} */ (check.options?.mode);
    const bundle = getCachedSignalBundle(context);
    return completeStandardsPolicy(mode, bundle, context);
  },
};
