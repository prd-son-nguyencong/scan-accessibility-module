import { deepFreeze } from '../runtime/deep-freeze.js';
import { getSharedBuiltInRuleRegistry } from './builtin-registry.js';

/** @typedef {import('./schema.js').RuleDescriptor} RuleDescriptor */

const CATEGORY_PUBLIC_META = Object.freeze([
  { id: 'general', label: 'General', wcagVersions: ['WCAG 2.1', 'WCAG 2.0'] },
  { id: 'interactive', label: 'Interactive Content', wcagVersions: ['WCAG 2.2', 'WCAG 2.0'] },
  { id: 'forms', label: 'Forms', wcagVersions: ['WCAG 2.0'] },
  { id: 'landmarks', label: 'Landmarks', wcagVersions: ['WCAG 2.0'] },
  { id: 'graphics', label: 'Graphics', wcagVersions: ['WCAG 2.0'] },
  { id: 'dragging', label: 'Dragging Alternative', wcagVersions: ['WCAG 2.2'] },
  { id: 'aria', label: 'ARIA', wcagVersions: ['WCAG 2.1'] },
  { id: 'lists', label: 'Lists', wcagVersions: ['WCAG 2.0'] },
  { id: 'metadata', label: 'Metadata', wcagVersions: ['WCAG 2.0'] },
  { id: 'tabs', label: 'Tabs', wcagVersions: ['WCAG 2.0'] },
  { id: 'tables', label: 'Tables', wcagVersions: ['WCAG 2.0'] },
]);

const CATEGORY_META_BY_ID = new Map(CATEGORY_PUBLIC_META.map((category) => [category.id, category]));

/**
 * @param {RuleDescriptor} rule
 * @returns {string}
 */
function resolvePublicCategoryId(rule) {
  return rule.publicCategory || rule.category;
}

/**
 * @param {{ id: string, label: string, wcagVersions: string[], rules: string[] }} category
 */
function cloneCategory(category) {
  return deepFreeze({
    id: category.id,
    label: category.label,
    wcagVersions: [...category.wcagVersions],
    rules: [...category.rules],
  });
}

/**
 * @param {import('./registry.js').RuleRegistry} registry
 */
function buildCatalogFromRegistry(registry) {
  /** @type {Map<string, string[]>} */
  const rulesByPublicCategory = new Map(
    CATEGORY_PUBLIC_META.map((category) => [category.id, []]),
  );
  /** @type {Map<string, Readonly<{
   *   title: string,
   *   requirement: string,
   *   recommendation: string,
   *   category: string,
   *   publicCategory: string,
   *   fix: RuleDescriptor['fix'],
   *   status: RuleDescriptor['status'],
   * }>>} */
  const ruleMetadataById = new Map();

  for (const rule of registry.listRules()) {
    const publicCategoryId = resolvePublicCategoryId(rule);
    if (!CATEGORY_META_BY_ID.has(publicCategoryId)) {
      throw new Error(`rule "${rule.id}" references unknown public category "${publicCategoryId}"`);
    }
    rulesByPublicCategory.get(publicCategoryId).push(rule.id);
    ruleMetadataById.set(rule.id, deepFreeze({
      title: rule.reporting.title,
      requirement: rule.reporting.requirement,
      recommendation: rule.reporting.recommendation,
      category: rule.category,
      publicCategory: publicCategoryId,
      fix: { ...rule.fix },
      status: rule.status,
    }));
  }

  const categories = CATEGORY_PUBLIC_META.map((meta) => deepFreeze({
    id: meta.id,
    label: meta.label,
    wcagVersions: Object.freeze([...meta.wcagVersions]),
    rules: Object.freeze(rulesByPublicCategory.get(meta.id).sort((left, right) => left.localeCompare(right))),
  }));

  return deepFreeze({
    categories,
    ruleMetadataById,
    categoryByRuleId: new Map(
      categories.flatMap((category) => category.rules.map((ruleId) => [ruleId, category])),
    ),
  });
}

const registry = await getSharedBuiltInRuleRegistry();
const catalog = buildCatalogFromRegistry(registry);

/** @type {ReadonlyArray<{ id: string, label: string, wcagVersions: string[], rules: string[] }>} */
export const ACCESSSCAN_CATEGORIES = Object.freeze(
  catalog.categories.map((category) => cloneCategory(category)),
);

/**
 * @param {string} ruleId
 * @returns {{ id: string, label: string, wcagVersions: string[], rules: string[] } | null}
 */
export function getAccessScanCategory(ruleId) {
  const category = catalog.categoryByRuleId.get(ruleId);
  if (!category) return null;
  return cloneCategory(category);
}

/**
 * @param {string} ruleId
 * @returns {{ title: string, requirement: string, recommendation: string } | null}
 */
export function getAccessScanRuleRequirement(ruleId) {
  const metadata = catalog.ruleMetadataById.get(ruleId);
  if (!metadata) return null;
  return deepFreeze({
    title: metadata.title,
    requirement: metadata.requirement,
    recommendation: metadata.recommendation,
  });
}

/**
 * @param {string} ruleId
 */
export function getAccessScanRuleMetadata(ruleId) {
  const metadata = catalog.ruleMetadataById.get(ruleId);
  if (!metadata) return null;
  return deepFreeze(structuredClone(metadata));
}

/**
 * @returns {string[]}
 */
export function listAccessScanCatalogRuleIds() {
  return ACCESSSCAN_CATEGORIES.flatMap((category) => [...category.rules]);
}
