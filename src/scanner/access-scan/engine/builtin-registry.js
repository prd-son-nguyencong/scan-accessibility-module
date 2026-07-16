import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvaluators, loadRuleDescriptors } from './loader.js';
import { buildRuleRegistry } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(__dirname, '../rules');
const EVALUATORS_DIR = path.join(__dirname, '../evaluators');

/** @type {Promise<import('./registry.js').RuleRegistry> | null} */
let sharedBuiltinRegistryPromise = null;

/**
 * @param {{
 *   enforceCatalogContract?: boolean,
 *   customDescriptors?: import('./schema.js').RuleDescriptor[],
 *   allowlistedEvaluators?: string[],
 * }} [options]
 */
async function buildRegistryFromDisk(options = {}) {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  return buildRuleRegistry({
    descriptors,
    evaluators,
    customDescriptors: options.customDescriptors || [],
    allowlistedEvaluators: options.allowlistedEvaluators || [],
    enforceCatalogContract: options.enforceCatalogContract ?? true,
  });
}

/**
 * @param {{
 *   enforceCatalogContract?: boolean,
 *   customDescriptors?: import('./schema.js').RuleDescriptor[],
 *   allowlistedEvaluators?: string[],
 * }} [options]
 * @returns {boolean}
 */
function usesCustomRegistryOptions(options = {}) {
  return Boolean(
    (options.customDescriptors && options.customDescriptors.length > 0)
    || (options.allowlistedEvaluators && options.allowlistedEvaluators.length > 0)
    || options.enforceCatalogContract === false,
  );
}

/**
 * Returns the concurrency-safe shared built-in registry promise used by
 * production scan and the public catalog.
 */
export function getSharedBuiltInRuleRegistry() {
  if (!sharedBuiltinRegistryPromise) {
    sharedBuiltinRegistryPromise = buildRegistryFromDisk({ enforceCatalogContract: true });
  }
  return sharedBuiltinRegistryPromise;
}

/**
 * @param {{
 *   enforceCatalogContract?: boolean,
 *   customDescriptors?: import('./schema.js').RuleDescriptor[],
 *   allowlistedEvaluators?: string[],
 * }} [options]
 */
export async function loadBuiltInRuleRegistry(options = {}) {
  if (usesCustomRegistryOptions(options)) {
    return buildRegistryFromDisk(options);
  }
  return getSharedBuiltInRuleRegistry();
}
