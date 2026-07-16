import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  RULE_DESCRIPTOR_SCHEMA,
  validateRuleDescriptor,
} from '../src/scanner/access-scan/engine/schema.js';
import {
  discoverModulePaths,
  loadEvaluators,
  loadRuleDescriptors,
} from '../src/scanner/access-scan/engine/loader.js';
import { buildRuleRegistry } from '../src/scanner/access-scan/engine/registry.js';
import {
  PROFILES,
  filterChecksForProfile,
  isParityOnlyCheck,
} from '../src/scanner/access-scan/engine/profiles.js';
import {
  normalizeFinding,
  toViolation,
  VIOLATION_TYPES,
} from '../src/scanner/access-scan/engine/finding.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { createViolation } from '../src/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/rule-engine-core');
const RULES_DIR = path.join(FIXTURE_ROOT, 'rules');
const EVALUATORS_DIR = path.join(FIXTURE_ROOT, 'evaluators');

const VALID_DESCRIPTOR = {
  id: 'ListEmpty',
  status: 'active',
  category: 'lists',
  aliases: ['EmptyList'],
  standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.3.1' },
  severity: { impact: 'moderate', priority: 4 },
  automation: 'deterministic',
  checks: [
    {
      id: 'empty-ul',
      profiles: ['standards', 'commercial-parity'],
      evaluator: 'always-finding',
      target: { selector: 'ul:empty', roots: ['document'], allowPluginFallback: true },
      classification: 'confirmed',
    },
  ],
  reporting: {
    title: 'List should not be empty',
    requirement: 'Empty lists confuse assistive technology.',
    recommendation: 'Populate the list or hide it from assistive technology.',
  },
  fix: { deterministic: true, policy: 'mechanically_safe' },
};

test('RULE_DESCRIPTOR_SCHEMA exports required top-level fields', () => {
  assert.equal(RULE_DESCRIPTOR_SCHEMA.type, 'object');
  assert.ok(Array.isArray(RULE_DESCRIPTOR_SCHEMA.required));
  assert.ok(RULE_DESCRIPTOR_SCHEMA.required.includes('id'));
  assert.ok(RULE_DESCRIPTOR_SCHEMA.required.includes('checks'));
});

test('validateRuleDescriptor accepts a valid descriptor', () => {
  const result = validateRuleDescriptor(VALID_DESCRIPTOR);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateRuleDescriptor returns path-based errors for invalid descriptors', () => {
  const result = validateRuleDescriptor({
    ...VALID_DESCRIPTOR,
    status: 'unknown',
    checks: [{ id: 'x', profiles: ['nope'], evaluator: '' }],
    reporting: { title: '', requirement: '', recommendation: '' },
  });
  assert.equal(result.valid, false);
  const paths = result.errors.map((error) => error.path);
  assert.ok(paths.includes('/status'));
  assert.ok(paths.includes('/checks/0/profiles/0'));
  assert.ok(paths.includes('/checks/0/evaluator'));
  assert.ok(paths.some((p) => p.startsWith('/reporting/')));
});

test('discoverModulePaths returns deterministic sorted paths', async () => {
  const paths = await discoverModulePaths(RULES_DIR, '.rules.js');
  assert.deepEqual(
    paths.map((p) => path.basename(p)),
    [
      'alpha-list-empty.rules.js',
      'aria-legacy.rules.js',
      'parity-only.rules.js',
      'zulu-error.rules.js',
    ],
  );
});

test('loadRuleDescriptors auto-discovers descriptor modules without engine edits', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  assert.equal(descriptors.length, 4);
  assert.deepEqual(
    descriptors.map((d) => d.id).sort(),
    ['AriaLabelledbyContentMismatch', 'ErrorRule', 'ListEmpty', 'ParityOnlyRule'],
  );
});

test('loadEvaluators auto-discovers evaluator plugins', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  assert.deepEqual(
    [...evaluators.keys()].sort(),
    [
      'always-finding',
      'candidate-array',
      'inapplicable',
      'invalid-return',
      'late-reject',
      'signal-aware',
      'slow',
      'throws',
    ],
  );
});

test('a newly added rules file is discovered without editing engine code', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ada-scan-rules-'));
  writeFileSync(
    path.join(tempDir, 'brand-new.rules.js'),
    `export default ${JSON.stringify({
      ...VALID_DESCRIPTOR,
      id: 'BrandNewRule',
      aliases: [],
    })};\n`,
  );
  const descriptors = await loadRuleDescriptors(tempDir);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, 'BrandNewRule');
});

test('buildRuleRegistry indexes active, legacy-readable, categories, and profiles', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  assert.equal(registry.getActiveRuleIds().length, 3);
  assert.deepEqual(registry.getLegacyReadableRuleIds(), ['AriaLabelledbyContentMismatch']);
  assert.equal(registry.getRule('ListEmpty').status, 'active');
  assert.equal(registry.getRule('AriaLabelledbyContentMismatch').status, 'legacy-readable');
  assert.deepEqual(registry.getRulesByCategory('lists').map((r) => r.id), ['ListEmpty']);
  assert.ok(registry.getChecksForProfile(PROFILES.STANDARDS).length >= 3);
  assert.ok(registry.getChecksForProfile(PROFILES.COMMERCIAL_PARITY).length >= 2);
});

test('buildRuleRegistry rejects duplicate rule ids and alias collisions', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);

  assert.throws(
    () => buildRuleRegistry({
      descriptors: [...descriptors, { ...VALID_DESCRIPTOR, id: 'ListEmpty', aliases: [] }],
      evaluators,
      enforceCatalogContract: false,
    }),
    /duplicate rule id/i,
  );

  assert.throws(
    () => buildRuleRegistry({
      descriptors: [
        { ...VALID_DESCRIPTOR, id: 'RuleA', aliases: ['SharedAlias'], checks: [{ ...VALID_DESCRIPTOR.checks[0], id: 'check-a' }] },
        { ...VALID_DESCRIPTOR, id: 'RuleB', aliases: ['SharedAlias'], checks: [{ ...VALID_DESCRIPTOR.checks[0], id: 'check-b' }] },
      ],
      evaluators,
      enforceCatalogContract: false,
    }),
    /alias collision/i,
  );

  assert.throws(
    () => buildRuleRegistry({
      descriptors: [
        { ...VALID_DESCRIPTOR, id: 'ListEmpty', aliases: [] },
        { ...VALID_DESCRIPTOR, id: 'RuleA', aliases: ['ListEmpty'], checks: [{ ...VALID_DESCRIPTOR.checks[0], id: 'check-c' }] },
      ],
      evaluators,
      enforceCatalogContract: false,
    }),
    /alias collision/i,
  );
});

test('buildRuleRegistry rejects unresolved evaluator references', () => {
  assert.throws(
    () => buildRuleRegistry({
      descriptors: [VALID_DESCRIPTOR],
      evaluators: new Map(),
      enforceCatalogContract: false,
    }),
    /unresolved evaluator/i,
  );
});

test('buildRuleRegistry restricts custom descriptors to allowlisted evaluators', () => {
  const evaluators = new Map([['allowed', { id: 'allowed', evaluate: async () => ({}) }]]);
  assert.throws(
    () => buildRuleRegistry({
      descriptors: [],
      evaluators,
      customDescriptors: [VALID_DESCRIPTOR],
      allowlistedEvaluators: ['other'],
      enforceCatalogContract: false,
    }),
    /allowlisted evaluator/i,
  );

  const registry = buildRuleRegistry({
    descriptors: [],
    evaluators,
    customDescriptors: [{ ...VALID_DESCRIPTOR, checks: [{ ...VALID_DESCRIPTOR.checks[0], evaluator: 'allowed' }] }],
    allowlistedEvaluators: ['allowed'],
    enforceCatalogContract: false,
  });
  assert.equal(registry.getRule('ListEmpty').checks[0].evaluator, 'allowed');
});

test('filterChecksForProfile keeps standards checks in both profiles but drops parity-only in standards', () => {
  const rule = {
    checks: [
      { id: 'both', profiles: ['standards', 'commercial-parity'] },
      { id: 'parity', profiles: ['commercial-parity'] },
      { id: 'standards', profiles: ['standards'] },
    ],
  };

  const standardsChecks = filterChecksForProfile(rule.checks, PROFILES.STANDARDS);
  const parityChecks = filterChecksForProfile(rule.checks, PROFILES.COMMERCIAL_PARITY);

  assert.deepEqual(standardsChecks.map((c) => c.id), ['both', 'standards']);
  assert.deepEqual(parityChecks.map((c) => c.id), ['both', 'parity', 'standards']);
  assert.equal(isParityOnlyCheck(rule.checks[1]), true);
  assert.equal(isParityOnlyCheck(rule.checks[0]), false);
});

test('normalizeFinding enforces the normalized finding contract', () => {
  const rule = {
    id: 'ListEmpty',
    severity: { impact: 'moderate', priority: 4 },
    standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.3.1' },
    reporting: { recommendation: 'Fix the list.' },
  };

  const finding = normalizeFinding(
    {
      violationType: 'confirmed',
      element: {
        outerHTML: '<ul></ul>',
        selector: 'ul',
        framePath: ['frame-1'],
        shadowPath: ['host', 'inner'],
      },
      evidence: { observed: true },
    },
    rule,
  );

  assert.equal(finding.ruleId, 'ListEmpty');
  assert.equal(finding.violationType, VIOLATION_TYPES.CONFIRMED);
  assert.deepEqual(finding.severity, {
    impact: 'moderate',
    priority: 4,
    wcagRef: 'WCAG 2.0 A 1.3.1',
  });
  assert.deepEqual(finding.element, {
    outerHTML: '<ul></ul>',
    selector: 'ul',
    framePath: ['frame-1'],
    shadowPath: ['host', 'inner'],
  });
  assert.equal(finding.recommendation, 'Fix the list.');
  assert.deepEqual(finding.evidence, {
    observed: true,
    violationType: 'confirmed',
  });
});

test('toViolation adapts normalized findings to createViolation without breaking existing fields', () => {
  const baseline = createViolation({
    ruleId: 'ListEmpty',
    layer: 'accessScan',
    impact: 'moderate',
    priority: 4,
    element: { outerHTML: '<ul></ul>', selector: 'ul', scanId: null },
    source: { mode: 'url', url: 'https://example.test' },
    fix: { deterministic: true, hint: 'legacy hint' },
  });

  const finding = normalizeFinding(
    {
      violationType: 'commercial-parity',
      element: {
        outerHTML: '<ul></ul>',
        selector: 'ul',
        framePath: [],
        shadowPath: [],
      },
      evidence: { classification: 'commercial-parity-heuristic', observed: true },
    },
    {
      id: 'ListEmpty',
      category: 'lists',
      severity: { impact: 'moderate', priority: 4 },
      standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.3.1' },
      reporting: { recommendation: 'Review parity overlay.' },
      fix: { deterministic: false, policy: 'manual_only' },
    },
  );

  const adapted = toViolation(finding, {
    layer: 'accessScan',
    source: { mode: 'url', url: 'https://example.test' },
  });

  for (const key of Object.keys(baseline)) {
    assert.ok(key in adapted, `missing top-level field ${key}`);
  }
  for (const key of Object.keys(baseline.element)) {
    assert.ok(key in adapted.element, `missing element field ${key}`);
  }
  for (const key of Object.keys(baseline.source)) {
    assert.ok(key in adapted.source, `missing source field ${key}`);
  }
  for (const key of Object.keys(baseline.fix)) {
    assert.ok(key in adapted.fix, `missing fix field ${key}`);
  }

  assert.equal(adapted.ruleId, 'ListEmpty');
  assert.equal(adapted.element.selector, 'ul');
  assert.deepEqual(adapted.element.framePath, []);
  assert.deepEqual(adapted.element.shadowPath, []);
  assert.deepEqual(adapted.evidence, {
    classification: 'commercial-parity-heuristic',
    observed: true,
    violationType: 'commercial-parity',
    publicCategory: 'lists',
    fixPolicy: 'manual_only',
  });
});

test('legacy Aria rule is representable as non-emitting readable metadata', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });
  const legacy = registry.getRule('AriaLabelledbyContentMismatch');

  assert.equal(legacy.status, 'legacy-readable');
  assert.deepEqual(legacy.checks, []);
  assert.equal(typeof legacy.reporting.title, 'string');
  assert.equal(registry.isEmittingRule('AriaLabelledbyContentMismatch'), false);
  assert.equal(registry.isReadableRule('AriaLabelledbyContentMismatch'), true);
});

test('runRules honors skipRules before execution', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: {},
    skipRules: ['ListEmpty', 'ErrorRule'],
  });

  const ruleIds = result.executionRecords.map((record) => record.ruleId);
  assert.ok(!ruleIds.includes('ListEmpty'));
  assert.ok(!ruleIds.includes('ErrorRule'));
});

test('runRules isolates evaluator failures and continues other checks', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: {},
    skipRules: ['ListEmpty', 'ParityOnlyRule', 'AriaLabelledbyContentMismatch'],
  });

  const errorRule = result.executionRecords.find((record) => record.ruleId === 'ErrorRule');
  assert.ok(errorRule);
  assert.equal(errorRule.status, 'error');
  assert.equal(errorRule.errorCode, 'evaluator_failure');
  assert.equal(errorRule.errorMessage, undefined);
  assert.equal(errorRule.errorStack, undefined);
  assert.ok(errorRule.checks.some((check) => check.status === 'error'));
  assert.ok(errorRule.checks.some((check) => check.status === 'complete'));
  assert.equal(result.findings.length, 1);
});

test('runRules records timeout with sanitized errorCode and no stack leakage', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors: [
      {
        ...VALID_DESCRIPTOR,
        id: 'TimeoutRule',
        checks: [{ id: 'slow', profiles: ['standards'], evaluator: 'slow' }],
      },
    ],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: {},
    ruleTimeoutMs: 20,
  });

  const record = result.executionRecords[0];
  assert.equal(record.ruleId, 'TimeoutRule');
  assert.equal(record.status, 'timeout');
  assert.equal(record.errorCode, 'rule_timeout');
  assert.equal(record.errorMessage, undefined);
  assert.equal(record.errorStack, undefined);
  assert.ok(record.durationMs >= 0);
});

test('runRules never runs parity-only checks in standards profile', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const standards = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: {},
    skipRules: ['ListEmpty', 'ErrorRule', 'AriaLabelledbyContentMismatch'],
  });
  const parity = await runRules({
    registry,
    profile: PROFILES.COMMERCIAL_PARITY,
    context: {},
    skipRules: ['ListEmpty', 'ErrorRule', 'AriaLabelledbyContentMismatch'],
  });

  assert.equal(standards.findings.length, 0);
  assert.equal(parity.findings.length, 1);
  assert.equal(parity.findings[0].violationType, VIOLATION_TYPES.COMMERCIAL_PARITY);
});

test('runRules records complete execution metrics', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: {},
    skipRules: ['ErrorRule', 'ParityOnlyRule', 'AriaLabelledbyContentMismatch'],
  });

  const record = result.executionRecords.find((entry) => entry.ruleId === 'ListEmpty');
  assert.equal(record.status, 'complete');
  assert.equal(record.candidateCount, 1);
  assert.equal(record.findingCount, 1);
  assert.ok(record.durationMs >= 0);
  assert.ok(Array.isArray(record.checks));
});

test('runRules skips legacy-readable rules with no emitting checks', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: {},
    skipRules: ['ListEmpty', 'ErrorRule', 'ParityOnlyRule'],
  });

  assert.equal(
    result.executionRecords.find((record) => record.ruleId === 'AriaLabelledbyContentMismatch'),
    undefined,
  );
});

test('buildRuleRegistry enforces 82 active and one legacy-readable catalog contract by default', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);

  assert.throws(
    () => buildRuleRegistry({ descriptors, evaluators }),
    /catalog contract/i,
  );
});

test('buildRuleRegistry allows partial fixture registries with enforceCatalogContract:false', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors,
    evaluators,
    enforceCatalogContract: false,
  });
  assert.equal(registry.getActiveRuleIds().length, 3);
});

test('buildRuleRegistry rejects legacy-readable rules with emitting checks', () => {
  const evaluators = new Map([['noop', { id: 'noop', evaluate: async () => ({ status: 'inapplicable', candidates: 0, findings: [] }) }]]);
  assert.throws(
    () => buildRuleRegistry({
      descriptors: [{
        ...VALID_DESCRIPTOR,
        id: 'AriaLabelledbyContentMismatch',
        status: 'legacy-readable',
        checks: [{ id: 'legacy-check', profiles: ['standards'], evaluator: 'noop' }],
      }],
      evaluators,
      enforceCatalogContract: false,
    }),
    /legacy-readable.*empty checks/i,
  );
});

test('validateRuleDescriptor rejects non-portable target selectors and fixed-count options', () => {
  const cases = [
    { patch: { target: { selector: '#main-nav' } }, path: '/checks/0/target/selector' },
    { patch: { target: { selector: '.btn-primary' } }, path: '/checks/0/target/selector' },
    { patch: { target: { selector: '[data-testid="filter"]' } }, path: '/checks/0/target/selector' },
    { patch: { target: { selector: 'li:nth-child(3)' } }, path: '/checks/0/target/selector' },
    { patch: { options: { hostname: 'example.com' } }, path: '/checks/0/options/hostname' },
    { patch: { options: { url: 'https://example.com/jobs' } }, path: '/checks/0/options/url' },
    { patch: { options: { expectedFailureCount: 2 } }, path: '/checks/0/options/expectedFailureCount' },
  ];

  for (const { patch, path: expectedPath } of cases) {
    const result = validateRuleDescriptor({
      ...VALID_DESCRIPTOR,
      checks: [{ ...VALID_DESCRIPTOR.checks[0], ...patch }],
    });
    assert.equal(result.valid, false, `expected portability failure for ${JSON.stringify(patch)}`);
    assert.ok(
      result.errors.some((error) => error.path === expectedPath),
      `missing path ${expectedPath} in ${JSON.stringify(result.errors)}`,
    );
  }
});

test('validateRuleDescriptor derives honest classifications and rejects dishonest overrides', () => {
  const { classification: _ignored, ...baseCheck } = VALID_DESCRIPTOR.checks[0];
  const heuristic = {
    ...VALID_DESCRIPTOR,
    id: 'StrongMismatch',
    automation: 'heuristic',
    fix: { deterministic: false, policy: 'manual_only' },
    checks: [{ ...baseCheck, id: 'heuristic-check' }],
  };
  assert.equal(validateRuleDescriptor(heuristic).valid, true);

  const dishonest = validateRuleDescriptor({
    ...heuristic,
    checks: [{ ...baseCheck, id: 'heuristic-check', classification: 'confirmed' }],
  });
  assert.equal(dishonest.valid, false);
  assert.ok(dishonest.errors.some((error) => error.path.includes('/classification')));

  const parityOnStandards = validateRuleDescriptor({
    ...VALID_DESCRIPTOR,
    checks: [{
      ...VALID_DESCRIPTOR.checks[0],
      profiles: ['standards'],
      classification: 'commercial-parity',
    }],
  });
  assert.equal(parityOnStandards.valid, false);
  assert.ok(parityOnStandards.errors.some((error) => error.path.includes('/classification')));

  const dishonestFix = validateRuleDescriptor({
    ...heuristic,
    fix: { deterministic: true, policy: 'mechanically_safe' },
  });
  assert.equal(dishonestFix.valid, false);
  assert.ok(dishonestFix.errors.some((error) => error.path === '/fix/deterministic'));
});

test('runRules defaults profile to standards', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const result = await runRules({
    registry,
    context: {},
    skipRules: ['ListEmpty', 'ErrorRule', 'AriaLabelledbyContentMismatch'],
  });

  assert.equal(result.findings.length, 0);
});

test('runRules accepts evaluator candidate arrays and candidatesScanned metadata', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'ArrayRule',
      checks: [{ id: 'array-check', profiles: ['standards'], evaluator: 'candidate-array' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({ registry, context: {} });
  const record = result.executionRecords.find((entry) => entry.ruleId === 'ArrayRule');
  assert.equal(record.status, 'complete');
  assert.equal(record.candidateCount, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].evidence.source, 'array-result');
});

test('runRules marks parity-only rules inapplicable under standards profile', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });

  const result = await runRules({
    registry,
    context: {},
    skipRules: ['ListEmpty', 'ErrorRule', 'AriaLabelledbyContentMismatch'],
  });

  const parityRecord = result.executionRecords.find((record) => record.ruleId === 'ParityOnlyRule');
  assert.ok(parityRecord);
  assert.equal(parityRecord.status, 'inapplicable');
  assert.deepEqual(parityRecord.checks, []);
});

test('runRules marks rules inapplicable when every executed check is inapplicable', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'InapplicableRule',
      checks: [{ id: 'noop', profiles: ['standards'], evaluator: 'inapplicable' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({ registry, context: {} });
  const record = result.executionRecords[0];
  assert.equal(record.ruleId, 'InapplicableRule');
  assert.equal(record.status, 'inapplicable');
  assert.equal(record.findingCount, 0);
  assert.equal(record.checks[0].status, 'inapplicable');
});

test('runRules treats empty candidate findings as complete not inapplicable', async () => {
  const evaluators = new Map([
    ['empty-complete', {
      id: 'empty-complete',
      async evaluate() {
        return { status: 'complete', candidates: 0, candidatesScanned: 0, findings: [] };
      },
    }],
  ]);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'EmptyCompleteRule',
      checks: [{ id: 'empty', profiles: ['standards'], evaluator: 'empty-complete' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({ registry, context: {} });
  assert.equal(result.executionRecords[0].status, 'complete');
  assert.equal(result.executionRecords[0].findingCount, 0);
});

test('validateRuleDescriptor rejects unknown top-level properties', () => {
  const result = validateRuleDescriptor({
    ...VALID_DESCRIPTOR,
    typoField: 'oops',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/typoField' && /unknown property/i.test(error.message)));
});

test('validateRuleDescriptor rejects non-portable eligibility values', () => {
  const result = validateRuleDescriptor({
    ...VALID_DESCRIPTOR,
    checks: [{
      ...VALID_DESCRIPTOR.checks[0],
      eligibility: { selector: '#main' },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '/checks/0/eligibility/selector'));
});

test('buildRuleRegistry rejects duplicate global check IDs across rules', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  assert.throws(
    () => buildRuleRegistry({
      descriptors: [
        VALID_DESCRIPTOR,
        {
          ...VALID_DESCRIPTOR,
          id: 'OtherRule',
          aliases: [],
          checks: [{ ...VALID_DESCRIPTOR.checks[0], id: 'empty-ul' }],
        },
      ],
      evaluators,
      enforceCatalogContract: false,
    }),
    /duplicate check id/i,
  );
});

test('buildRuleRegistry resolves aliases to canonical rules', async () => {
  const descriptors = await loadRuleDescriptors(RULES_DIR);
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({ descriptors, evaluators, enforceCatalogContract: false });
  assert.equal(registry.getRule('EmptyList').id, 'ListEmpty');
});

test('loadEvaluators rejects duplicate evaluator IDs', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ada-scan-evaluators-'));
  writeFileSync(
    path.join(tempDir, 'one.evaluator.js'),
    'export default { id: "dup", evaluate: async () => ({ status: "inapplicable", candidates: 0, findings: [] }) };\n',
  );
  writeFileSync(
    path.join(tempDir, 'two.evaluator.js'),
    'export default { id: "dup", evaluate: async () => ({ status: "inapplicable", candidates: 0, findings: [] }) };\n',
  );
  await assert.rejects(loadEvaluators(tempDir), /duplicate evaluator id/i);
});

test('runRules reports scan_cancelled when parent signal aborts', async () => {
  const evaluators = new Map([
    ['hang', {
      id: 'hang',
      async evaluate() {
        return new Promise(() => {});
      },
    }],
  ]);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'ParentAbortRule',
      checks: [{ id: 'wait', profiles: ['standards'], evaluator: 'hang' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const parent = new AbortController();
  const runPromise = runRules({
    registry,
    context: {},
    signal: parent.signal,
    ruleTimeoutMs: 5_000,
  });
  parent.abort();
  const result = await runPromise;
  const record = result.executionRecords[0];
  assert.equal(record.status, 'error');
  assert.equal(record.errorCode, 'scan_cancelled');
});

test('runRules passes combined deadline AbortSignal to evaluators on timeout', async () => {
  let sawAbort = false;
  const evaluators = new Map([
    ['probe', {
      id: 'probe',
      async evaluate(_context, _check, { signal } = {}) {
        return new Promise(() => {
          signal?.addEventListener('abort', () => {
            sawAbort = signal.aborted;
          }, { once: true });
        });
      },
    }],
  ]);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'SignalAwareRule',
      checks: [{ id: 'aware', profiles: ['standards'], evaluator: 'probe' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({
    registry,
    context: {},
    ruleTimeoutMs: 20,
  });

  const record = result.executionRecords[0];
  assert.equal(sawAbort, true);
  assert.equal(record.status, 'timeout');
  assert.equal(record.errorCode, 'rule_timeout');
});

test('runRules contains late rejecting evaluator promises after deadline wins', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'LateRejectRule',
      checks: [{ id: 'late', profiles: ['standards'], evaluator: 'late-reject' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({
    registry,
    context: {},
    ruleTimeoutMs: 20,
  });

  assert.equal(result.executionRecords[0].status, 'timeout');
  assert.equal(result.executionRecords[0].errorCode, 'rule_timeout');
});

test('runRules treats null evaluator returns as evaluator_failure', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'InvalidReturnRule',
      checks: [{ id: 'invalid', profiles: ['standards'], evaluator: 'invalid-return' }],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const result = await runRules({ registry, context: {} });
  const record = result.executionRecords[0];
  assert.equal(record.status, 'error');
  assert.equal(record.errorCode, 'evaluator_failure');
});

test('runRules prefers rule_timeout over evaluator_failure across multi-check rules', async () => {
  const evaluators = await loadEvaluators(EVALUATORS_DIR);
  const registry = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'MixedFailureRule',
      checks: [
        { id: 'throws-first', profiles: ['standards'], evaluator: 'throws' },
        { id: 'slow-second', profiles: ['standards'], evaluator: 'slow' },
      ],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const forward = await runRules({
    registry,
    context: {},
    ruleTimeoutMs: 20,
  });
  assert.equal(forward.executionRecords[0].status, 'timeout');
  assert.equal(forward.executionRecords[0].errorCode, 'rule_timeout');

  const registryReversed = buildRuleRegistry({
    descriptors: [{
      ...VALID_DESCRIPTOR,
      id: 'MixedFailureRule',
      checks: [
        { id: 'slow-first', profiles: ['standards'], evaluator: 'slow' },
        { id: 'throws-second', profiles: ['standards'], evaluator: 'throws' },
      ],
    }],
    evaluators,
    enforceCatalogContract: false,
  });

  const reverse = await runRules({
    registry: registryReversed,
    context: {},
    ruleTimeoutMs: 20,
  });
  assert.equal(reverse.executionRecords[0].status, 'timeout');
  assert.equal(reverse.executionRecords[0].errorCode, 'rule_timeout');
});

