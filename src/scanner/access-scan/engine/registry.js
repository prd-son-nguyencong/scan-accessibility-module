import { validateRuleDescriptor } from './schema.js';
import { filterChecksForProfile } from './profiles.js';
import { validateCatalogContract } from './catalog-contract.js';

/**
 * @typedef {import('./schema.js').RuleDescriptor} RuleDescriptor
 * @typedef {import('./schema.js').ProfileId} ProfileId
 * @typedef {import('./loader.js').EvaluatorModule} EvaluatorModule
 */

/**
 * @typedef {object} RuleRegistry
 * @property {() => string[]} getActiveRuleIds
 * @property {() => string[]} getLegacyReadableRuleIds
 * @property {(ruleId: string) => RuleDescriptor | undefined} getRule
 * @property {(category: string) => RuleDescriptor[]} getRulesByCategory
 * @property {(profile: ProfileId) => Array<{ rule: RuleDescriptor, check: RuleDescriptor['checks'][number] }>} getChecksForProfile
 * @property {(ruleId: string) => boolean} isEmittingRule
 * @property {(ruleId: string) => boolean} isReadableRule
 * @property {() => RuleDescriptor[]} listRules
 * @property {() => Map<string, EvaluatorModule>} getEvaluators
 */

/**
 * @param {{
 *   descriptors: RuleDescriptor[],
 *   evaluators: Map<string, EvaluatorModule>,
 *   customDescriptors?: RuleDescriptor[],
 *   allowlistedEvaluators?: string[],
 *   enforceCatalogContract?: boolean,
 * }} input
 * @returns {RuleRegistry}
 */
export function buildRuleRegistry(input) {
  const {
    descriptors,
    evaluators,
    customDescriptors = [],
    allowlistedEvaluators = [],
    enforceCatalogContract = true,
  } = input;

  const allDescriptors = [...descriptors, ...customDescriptors];
  /** @type {Map<string, RuleDescriptor>} */
  const rulesById = new Map();
  /** @type {Map<string, string>} */
  const aliasToCanonical = new Map();
  /** @type {Map<string, RuleDescriptor[]>} */
  const rulesByCategory = new Map();
  /** @type {Set<string>} */
  const checkIds = new Set();

  for (const descriptor of allDescriptors) {
    const validation = validateRuleDescriptor(descriptor);
    if (!validation.valid) {
      const details = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');
      throw new Error(`Invalid rule descriptor "${descriptor.id}": ${details}`);
    }

    if (rulesById.has(descriptor.id)) {
      throw new Error(`duplicate rule id "${descriptor.id}"`);
    }

    for (const check of descriptor.checks) {
      if (checkIds.has(check.id)) {
        throw new Error(`duplicate check id "${check.id}" for rule "${descriptor.id}"`);
      }
      checkIds.add(check.id);

      const allowlist = customDescriptors.includes(descriptor) ? allowlistedEvaluators : null;
      if (allowlist && !allowlist.includes(check.evaluator)) {
        throw new Error(
          `check "${check.id}" on rule "${descriptor.id}" references non-allowlisted evaluator "${check.evaluator}"`,
        );
      }

      if (!evaluators.has(check.evaluator)) {
        throw new Error(
          `unresolved evaluator "${check.evaluator}" referenced by rule "${descriptor.id}" check "${check.id}"`,
        );
      }
    }

    rulesById.set(descriptor.id, descriptor);

    for (const alias of descriptor.aliases || []) {
      if (alias === descriptor.id || aliasToCanonical.has(alias) || rulesById.has(alias)) {
        throw new Error(`alias collision for "${alias}" on rule "${descriptor.id}"`);
      }
      aliasToCanonical.set(alias, descriptor.id);
    }

    const categoryRules = rulesByCategory.get(descriptor.category) || [];
    categoryRules.push(descriptor);
    rulesByCategory.set(descriptor.category, categoryRules);
  }

  if (enforceCatalogContract) {
    validateCatalogContract(rulesById);
  }

  return {
    getActiveRuleIds() {
      return [...rulesById.values()]
        .filter((rule) => rule.status === 'active')
        .map((rule) => rule.id)
        .sort();
    },

    getLegacyReadableRuleIds() {
      return [...rulesById.values()]
        .filter((rule) => rule.status === 'legacy-readable')
        .map((rule) => rule.id)
        .sort();
    },

    getRule(ruleId) {
      return rulesById.get(ruleId) || (
        aliasToCanonical.has(ruleId)
          ? rulesById.get(aliasToCanonical.get(ruleId))
          : undefined
      );
    },

    getRulesByCategory(category) {
      return [...(rulesByCategory.get(category) || [])].sort((a, b) => a.id.localeCompare(b.id));
    },

    getChecksForProfile(profile) {
      /** @type {Array<{ rule: RuleDescriptor, check: RuleDescriptor['checks'][number] }>} */
      const checks = [];
      for (const rule of rulesById.values()) {
        for (const check of filterChecksForProfile(rule.checks, profile)) {
          checks.push({ rule, check });
        }
      }
      return checks.sort((a, b) => {
        const byRule = a.rule.id.localeCompare(b.rule.id);
        return byRule !== 0 ? byRule : a.check.id.localeCompare(b.check.id);
      });
    },

    isEmittingRule(ruleId) {
      const rule = this.getRule(ruleId);
      return Boolean(rule && rule.status === 'active' && rule.checks.length > 0);
    },

    isReadableRule(ruleId) {
      return Boolean(this.getRule(ruleId));
    },

    listRules() {
      return [...rulesById.values()].sort((a, b) => a.id.localeCompare(b.id));
    },

    getEvaluators() {
      return evaluators;
    },
  };
}
