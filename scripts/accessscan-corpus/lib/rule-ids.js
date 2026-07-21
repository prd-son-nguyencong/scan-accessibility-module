/** @type {Set<string> | null} */
let allowedRuleIdsOverride = null;

/** @type {(() => Set<string> | Promise<Set<string>>) | null} */
let allowedRuleIdsResolver = null;

/** @type {Promise<Set<string>> | null} */
let builtinAllowedRuleIdsCache = null;

/**
 * @param {Iterable<string>} ruleIds
 */
export function setAllowedRuleIdsForTests(ruleIds) {
  allowedRuleIdsOverride = new Set(ruleIds);
  allowedRuleIdsResolver = null;
}

/**
 * @param {() => Set<string> | Promise<Set<string>>} resolver
 */
export function setAllowedRuleIdsResolverForTests(resolver) {
  allowedRuleIdsResolver = resolver;
  allowedRuleIdsOverride = null;
}

export function resetAllowedRuleIdsForTests() {
  allowedRuleIdsOverride = null;
  allowedRuleIdsResolver = null;
}

export function resetBuiltinAllowedRuleIdsCacheForTests() {
  builtinAllowedRuleIdsCache = null;
}

/**
 * @param {{ allowedRuleIds?: Set<string> }=} options
 * @returns {Promise<Set<string>>}
 */
export async function resolveAllowedRuleIds(options = {}) {
  if (options.allowedRuleIds) {
    return options.allowedRuleIds;
  }
  if (allowedRuleIdsOverride) {
    return allowedRuleIdsOverride;
  }
  if (allowedRuleIdsResolver) {
    const resolved = allowedRuleIdsResolver();
    return resolved instanceof Promise ? resolved : resolved;
  }
  if (!builtinAllowedRuleIdsCache) {
    builtinAllowedRuleIdsCache = (async () => {
      const { listAccessScanCatalogRuleIds } = await import(
        '../../../src/scanner/access-scan/engine/public-catalog.js'
      );
      return new Set(listAccessScanCatalogRuleIds());
    })();
  }
  return builtinAllowedRuleIdsCache;
}
