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
    timeoutError?: unknown,
  } | undefined} */ (cache[SIGNAL_BUNDLE_CACHE_KEY]);

  if (entry?.snapshot === snapshot && entry.bundle) {
    return entry.bundle;
  }
  // Collection timed out already: fail fast instead of burning every later rule's budget on the same work.
  if (entry?.snapshot === snapshot && entry.timeoutError) throw entry.timeoutError;

  let bundle;
  try {
    bundle = collectSignalBundle(context);
  } catch (error) {
    if (/** @type {{ errorCode?: string }} */ (error)?.errorCode === 'rule_timeout') {
      cache[SIGNAL_BUNDLE_CACHE_KEY] = { snapshot, timeoutError: error };
    }
    throw error;
  }
  cache[SIGNAL_BUNDLE_CACHE_KEY] = { snapshot, bundle };
  cache.signalBundleCollectCount = Number(cache.signalBundleCollectCount || 0) + 1;
  return bundle;
}
