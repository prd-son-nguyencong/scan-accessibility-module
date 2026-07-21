import { applyAccessScanPolicy } from '../policies/accessscan.js';
import { getCachedSignalBundle } from './lib/signal-bundle-cache.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'commercial-parity',
  async evaluate(context, check) {
    const mode = /** @type {string} */ (check.options?.mode);
    const bundle = getCachedSignalBundle(context);
    return applyAccessScanPolicy(mode, bundle, context);
  },
};
