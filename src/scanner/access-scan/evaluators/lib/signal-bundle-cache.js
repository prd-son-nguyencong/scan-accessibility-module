import { collectSignalBundle } from '../../signals/index.js';
import { getEvaluatorCache, getSnapshot } from './runtime-context.js';

export const SIGNAL_BUNDLE_CACHE_KEY = 'signalBundle';

/**
 * Snapshot-identity-safe shared cache for signal bundles across evaluators.
 * Recollects when context.snapshot is replaced on a reused context object.
 *
 * @param {unknown} context
 * @returns {import('../../signals/types.js').SignalBundle}
 */
export function getCachedSignalBundle(context) {
  const cache = getEvaluatorCache(context);
  const snapshot = getSnapshot(context);
  const entry = /** @type {{
    snapshot?: import('../../runtime/types.js').Snapshot,
    bundle?: import('../../signals/types.js').SignalBundle,
  } | undefined} */ (cache[SIGNAL_BUNDLE_CACHE_KEY]);

  if (entry?.snapshot === snapshot && entry.bundle) {
    return entry.bundle;
  }

  const bundle = collectSignalBundle(context);
  cache[SIGNAL_BUNDLE_CACHE_KEY] = { snapshot, bundle };
  cache.signalBundleCollectCount = Number(cache.signalBundleCollectCount || 0) + 1;
  return bundle;
}
