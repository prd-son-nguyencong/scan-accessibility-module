import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  ACCESSSCAN_CATEGORIES,
  getAccessScanCategory,
  listAccessScanCatalogRuleIds,
} from '../../src/schema.js';
import { getAccessScanRuleRequirement } from '../../src/scanner/access-scan/engine/public-catalog.js';
import { loadBuiltInRuleRegistry } from '../../src/scanner/access-scan/engine/builtin-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const GOLDEN_CATALOG_PATH = path.join(
  PACKAGE_ROOT,
  'test/fixtures/access-scan/catalog-rule-ids.json'
);

export const GOLDEN_CATALOG_SCHEMA_VERSION = '1.0.0';

/** Readable in legacy reports and reporter copy; not emitted by current scanners. */
export const LEGACY_NON_EMITTING_RULE_ID = 'AriaLabelledbyContentMismatch';

export const ACTIVE_RULE_COUNT = 82;
export const CATALOG_RULE_COUNT = ACTIVE_RULE_COUNT + 1;

export const STICKY_HEADER_DUAL_CATEGORY_CONTRACT = Object.freeze({
  ruleId: 'StickyHeaderObscuresFocus',
  publicCategoryId: 'interactive',
  historicalCategoryId: 'lists',
});

/** Top-level and nested keys produced by createViolation today. */
export const VIOLATION_FIELD_CONTRACT = Object.freeze({
  topLevel: [
    'id',
    'ruleId',
    'layer',
    'category',
    'wcagRef',
    'impact',
    'priority',
    'count',
    'foundAt',
    'related',
    'element',
    'source',
    'fix',
  ],
  element: ['outerHTML', 'selector', 'scanId'],
  source: [
    'mode',
    'file',
    'line',
    'snippet',
    'url',
    'confidence',
    'method',
    'preimageSha256',
    'preimageRange',
    'partial',
    'page',
    'routeDependencies',
  ],
  fix: ['deterministic', 'hint', 'patch'],
});

/**
 * Engine-adapted violation keys: base createViolation contract plus additive
 * element extensions (framePath/shadowPath) and evidence bag from toViolation.
 * V1 projection intentionally keeps the base 3 element keys only.
 */
export const ENGINE_VIOLATION_FIELD_CONTRACT = Object.freeze({
  topLevel: [...VIOLATION_FIELD_CONTRACT.topLevel, 'evidence'],
  element: [...VIOLATION_FIELD_CONTRACT.element, 'framePath', 'shadowPath'],
  source: [...VIOLATION_FIELD_CONTRACT.source],
  fix: [...VIOLATION_FIELD_CONTRACT.fix],
});

/** Top-level and nested keys produced by projectReportV1 page violations today. */
export const V1_VIOLATION_FIELD_CONTRACT = Object.freeze({
  topLevel: [
    'id',
    'ruleId',
    'canonicalRuleId',
    'layer',
    'layers',
    'category',
    'wcagRef',
    'impact',
    'priority',
    'count',
    'foundAt',
    'related',
    'element',
    'source',
    'fix',
    'evidence',
    'manualChecks',
  ],
  element: ['outerHTML', 'selector', 'scanId'],
  source: [
    'mode',
    'file',
    'line',
    'snippet',
    'method',
    'confidence',
    'preimageSha256',
    'preimageRange',
    'routeDependencies',
    'url',
  ],
  fix: ['deterministic', 'hint', 'patch'],
  evidence: ['message', 'observations'],
});

function assertGoldenCatalogIntegrity(catalog) {
  if (catalog.schemaVersion !== GOLDEN_CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `Golden catalog schemaVersion must be ${GOLDEN_CATALOG_SCHEMA_VERSION}, got ${catalog.schemaVersion}`,
    );
  }
  if (!Array.isArray(catalog.ruleIds) || catalog.ruleIds.length === 0) {
    throw new Error('Golden catalog ruleIds must be a non-empty array');
  }
  if (!Array.isArray(catalog.legacyNonEmittingRuleIds) || catalog.legacyNonEmittingRuleIds.length === 0) {
    throw new Error('Golden catalog legacyNonEmittingRuleIds must be a non-empty array');
  }
  if (!Number.isInteger(catalog.activeRuleCount) || catalog.activeRuleCount <= 0) {
    throw new Error('Golden catalog activeRuleCount must be a positive integer');
  }

  const uniqueRuleIds = new Set(catalog.ruleIds);
  if (uniqueRuleIds.size !== catalog.ruleIds.length) {
    const duplicates = catalog.ruleIds.filter(
      (ruleId, index) => catalog.ruleIds.indexOf(ruleId) !== index,
    );
    throw new Error(`Golden catalog ruleIds must be unique: ${[...new Set(duplicates)].join(', ')}`);
  }

  const legacySet = new Set(catalog.legacyNonEmittingRuleIds);
  if (legacySet.size !== catalog.legacyNonEmittingRuleIds.length) {
    throw new Error('Golden catalog legacyNonEmittingRuleIds must be unique');
  }

  const missingLegacy = catalog.legacyNonEmittingRuleIds.filter((ruleId) => !uniqueRuleIds.has(ruleId));
  if (missingLegacy.length > 0) {
    throw new Error(
      `Golden catalog legacyNonEmittingRuleIds must be present in ruleIds: ${missingLegacy.join(', ')}`,
    );
  }

  const expectedActiveCount = catalog.ruleIds.length - catalog.legacyNonEmittingRuleIds.length;
  if (catalog.activeRuleCount !== expectedActiveCount) {
    throw new Error(
      `Golden catalog activeRuleCount must equal ruleIds minus legacy IDs (${expectedActiveCount})`,
    );
  }
}

const goldenCatalog = (() => {
  const catalog = JSON.parse(readFileSync(GOLDEN_CATALOG_PATH, 'utf8'));
  assertGoldenCatalogIntegrity(catalog);
  return catalog;
})();

export function loadGoldenCatalog() {
  return structuredClone(goldenCatalog);
}

export function loadGoldenLegacyNonEmittingRuleIds() {
  return [...goldenCatalog.legacyNonEmittingRuleIds].sort();
}

export function loadGoldenCatalogRuleIds() {
  return [...goldenCatalog.ruleIds].sort();
}

export function loadGoldenActiveCatalogRuleIds() {
  const legacy = new Set(goldenCatalog.legacyNonEmittingRuleIds);
  return goldenCatalog.ruleIds.filter((ruleId) => !legacy.has(ruleId)).sort();
}

export { listAccessScanCatalogRuleIds };

export async function listActiveAccessScanRuleIds() {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  return registry.getActiveRuleIds();
}

export async function listRegistryCatalogRuleIds() {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  return [
    ...registry.getActiveRuleIds(),
    ...registry.getLegacyReadableRuleIds(),
  ].sort();
}

export function getAccessScanCatalogByRuleId() {
  const byRuleId = new Map();
  for (const category of ACCESSSCAN_CATEGORIES) {
    for (const ruleId of category.rules) {
      byRuleId.set(ruleId, category);
    }
  }
  return byRuleId;
}

export function assertRuleRequirementMetadata(ruleId) {
  const requirement = getAccessScanRuleRequirement(ruleId);
  if (!requirement) {
    throw new Error(`Missing reporter requirement metadata for ${ruleId}`);
  }
  if (typeof requirement.title !== 'string' || requirement.title.trim().length === 0) {
    throw new Error(`Missing title for ${ruleId}`);
  }
  if (typeof requirement.requirement !== 'string' || requirement.requirement.trim().length === 0) {
    throw new Error(`Missing requirement copy for ${ruleId}`);
  }
}

export function assertExactViolationFieldContract(violation, contract, label = 'violation') {
  assert.deepEqual(
    Object.keys(violation).sort(),
    [...contract.topLevel].sort(),
    `${label} top-level keys`,
  );
  for (const nested of ['element', 'source', 'fix']) {
    assert.deepEqual(
      Object.keys(violation[nested] || {}).sort(),
      [...contract[nested]].sort(),
      `${label}.${nested} keys`,
    );
  }
}

export function compareRuleIdSets(left, right, leftLabel, rightLabel) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    onlyLeft: [...leftSet].filter((ruleId) => !rightSet.has(ruleId)).sort(),
    onlyRight: [...rightSet].filter((ruleId) => !leftSet.has(ruleId)).sort(),
    leftLabel,
    rightLabel,
  };
}

/**
 * Shared Playwright fixture page setup used by accessScan characterization tests.
 */
export async function createFixturePage(browser, markup) {
  const { newPage } = await import('../../src/scanner/browser.js');
  const { installRuntimeHooks } = await import('../../src/scanner/access-scan/runtime/index.js');
  const page = await newPage(browser);
  await installRuntimeHooks(page);
  await page.setContent(markup);
  return page;
}

export async function scanFixtureWithAccessScan(page, url, options = {}) {
  const { scanWithAccessScan } = await import('../../src/scanner/access-scan/index.js');
  return scanWithAccessScan(page, url, { skipNavigation: true, ...options });
}

export { getAccessScanCategory };
