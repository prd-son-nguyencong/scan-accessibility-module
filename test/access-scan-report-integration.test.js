import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as scanner from '../src/index.js';
import { CORPUS_COMPARATOR_VERSION } from '../src/scanner/access-scan/corpus/constants.js';
import {
  buildAccessScanExecutionTotals,
  mergeAccessScanExecutionTotals,
} from '../src/scanner/access-scan/engine/execution-totals.js';
import { resolveScanProfile, PROFILES } from '../src/scanner/access-scan/index.js';
import {
  buildScanReportV2,
  projectReportV1,
  validateScanReportV2,
  computeReportId,
  extractAccessScanRunMetadata,
} from '../src/reporter/report-v2.js';
import {
  formatAccessScanProfileLabel,
  buildAccessScanSection,
  buildAxeSection,
  buildGenericViolationSection,
  buildScannerRunEvidence,
  buildHtml,
} from '../src/reporter/html.js';
import { lookupPolicyDecision, POLICIES } from '../src/fix/policy/registry.js';
import { buildFixUnitsFromProjectedViolations } from '../src/fix/canonical/fix-unit.js';
import { printConsoleSummary } from '../src/reporter/scan-report.js';
import {
  findingConfirmationIdentity,
  hasIndependentStandardsConfirmation,
  isCommercialParityFinding,
  isStandardsConfirmedFinding,
} from '../src/fix/policy/finding-confirmation.js';
import { resolveFindingEvidenceSlices } from '../src/fix/policy/finding-evidence.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

const REQUIRED_VIOLATION_KEYS = [
  'id', 'ruleId', 'canonicalRuleId', 'layer', 'layers', 'category', 'wcagRef',
  'impact', 'priority', 'count', 'foundAt', 'related', 'element', 'source',
  'fix', 'evidence', 'manualChecks',
];

const REQUIRED_FINDING_KEYS = [
  'findingId', 'nativeRuleId', 'nativeRuleIds', 'canonicalRuleId', 'layer',
  'layers', 'category', 'impact', 'priority', 'count', 'pageState', 'route',
  'wcagRef', 'element', 'source', 'evidence', 'manualChecks', 'fix',
];

function accessScanViolation(overrides = {}) {
  return {
    id: 'runtime-access',
    ruleId: 'ListEmpty',
    layer: 'accessScan',
    category: 'accessibility',
    wcagRef: 'Best Practice',
    impact: 'moderate',
    priority: 3,
    count: 1,
    foundAt: '2026-07-17T00:00:00.000Z',
    element: {
      outerHTML: '<ul id="jobs"></ul>',
      selector: '#jobs',
      framePath: [],
      shadowPath: [],
    },
    source: { mode: 'url', file: null, line: null, confidence: 'none', method: 'unresolved' },
    fix: { deterministic: false, hint: 'List should not be empty.', patch: null },
    evidence: {
      violationType: 'commercial-parity',
      profile: 'commercial-parity',
      classification: 'commercial-parity-heuristic',
      checkId: 'lists:list-empty',
    },
    ...overrides,
  };
}

function sampleExecutionRecords() {
  return [
    {
      ruleId: 'ListEmpty',
      status: 'complete',
      durationMs: 12,
      candidateCount: 2,
      findingCount: 1,
      checks: [
        {
          checkId: 'lists:list-empty',
          status: 'complete',
          durationMs: 8,
          candidateCount: 2,
          findingCount: 1,
        },
        {
          checkId: 'lists:list-structure',
          status: 'inapplicable',
          durationMs: 4,
          candidateCount: 0,
          findingCount: 0,
        },
      ],
    },
    {
      ruleId: 'RegionMain',
      status: 'inapplicable',
      durationMs: 3,
      candidateCount: 0,
      findingCount: 0,
      checks: [],
    },
  ];
}

test('CORPUS_COMPARATOR_VERSION is a stable exported corpus contract constant', () => {
  assert.equal(typeof CORPUS_COMPARATOR_VERSION, 'string');
  assert.match(CORPUS_COMPARATOR_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(CORPUS_COMPARATOR_VERSION, '1.0.0');
});

test('buildAccessScanExecutionTotals records deterministic per-check and aggregate counts', () => {
  const totals = buildAccessScanExecutionTotals(sampleExecutionRecords());

  assert.deepEqual(totals.aggregates.rules, {
    complete: 1,
    inapplicable: 1,
    error: 0,
    timeout: 0,
    skipped: 0,
  });
  assert.deepEqual(totals.aggregates.checks, {
    complete: 1,
    inapplicable: 1,
    error: 0,
    timeout: 0,
    skipped: 0,
    candidates: 2,
    findings: 1,
  });
  assert.deepEqual(totals.perCheck, [
    {
      checkId: 'lists:list-empty',
      status: 'complete',
      statusCounts: { complete: 1 },
      candidateCount: 2,
      findingCount: 1,
    },
    {
      checkId: 'lists:list-structure',
      status: 'inapplicable',
      statusCounts: { inapplicable: 1 },
      candidateCount: 0,
      findingCount: 0,
    },
  ]);
  assert.equal(JSON.stringify(totals).includes('paradox'), false);
  assert.equal(JSON.stringify(totals).includes('localhost'), false);
});

test('buildAccessScanRun preserves legacy includeThirdParty and records resolved profile metadata', () => {
  const totals = buildAccessScanExecutionTotals(sampleExecutionRecords());
  const run = scanner.buildAccessScanRun([accessScanViolation()], {
    includeThirdParty: true,
    engineVersion: '1.0.1',
    profile: PROFILES.COMMERCIAL_PARITY,
    executionTotals: totals,
  });

  assert.equal(run.evidence.includeThirdParty, true);
  assert.equal(run.evidence.profile, 'commercial-parity');
  assert.equal(run.evidence.comparatorVersion, CORPUS_COMPARATOR_VERSION);
  assert.deepEqual(run.evidence.execution, totals);
});

test('buildAccessScanRun maps legacy includeThirdParty=false to standards profile', () => {
  const run = scanner.buildAccessScanRun([], {
    includeThirdParty: false,
    engineVersion: '1.0.1',
  });

  assert.equal(run.evidence.includeThirdParty, false);
  assert.equal(run.evidence.profile, 'standards');
});

test('explicit profile option takes precedence over includeThirdParty when building runs', () => {
  const run = scanner.buildAccessScanRun([], {
    includeThirdParty: true,
    profile: PROFILES.STANDARDS,
    engineVersion: '1.0.1',
  });

  assert.equal(run.evidence.includeThirdParty, true);
  assert.equal(run.evidence.profile, 'standards');
  assert.equal(resolveScanProfile({ profile: PROFILES.STANDARDS, includeThirdParty: true }), 'standards');
});

test('buildScanReportV2 preserves V2 finding shape while adding accessScan run metadata', () => {
  const totals = buildAccessScanExecutionTotals(sampleExecutionRecords());
  const scanResults = [{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [accessScanViolation()],
    scannerRuns: [scanner.buildAccessScanRun([accessScanViolation()], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
      executionTotals: totals,
    })],
  }];

  const report = buildScanReportV2(scanResults, fixture.context);
  const finding = report.pages[0].findings[0];
  for (const key of REQUIRED_FINDING_KEYS) {
    assert.ok(Object.hasOwn(finding, key), `missing finding field ${key}`);
  }

  const accessRun = report.scanners.find((entry) => entry.layer === 'accessScan');
  assert.equal(accessRun.evidence.profile, 'commercial-parity');
  assert.equal(accessRun.evidence.comparatorVersion, CORPUS_COMPARATOR_VERSION);
  assert.deepEqual(accessRun.evidence.execution, totals);
  assert.equal(report.runMetadata?.accessScan?.profile, 'commercial-parity');
  assert.equal(report.runMetadata?.accessScan?.comparatorVersion, CORPUS_COMPARATOR_VERSION);
  assert.doesNotThrow(() => validateScanReportV2(report));
});

test('V1 projection retains legacy violation fields and adds no breaking removals', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [accessScanViolation()],
    scannerRuns: [scanner.buildAccessScanRun([accessScanViolation()], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
    })],
  }], fixture.context);

  const legacy = projectReportV1(report);
  const violation = legacy.pages[0].violations[0];
  for (const key of REQUIRED_VIOLATION_KEYS) {
    assert.ok(Object.hasOwn(violation, key), `missing legacy violation field ${key}`);
  }
  assert.equal(violation.layer, 'accessScan');
});

test('formatAccessScanProfileLabel distinguishes standards and commercial parity runs', () => {
  assert.match(formatAccessScanProfileLabel('standards'), /standards/i);
  assert.match(formatAccessScanProfileLabel('standards'), /wcag/i);
  assert.match(formatAccessScanProfileLabel('commercial-parity'), /commercial parity/i);
  assert.match(formatAccessScanProfileLabel('commercial-parity'), /oracle/i);
  assert.notEqual(
    formatAccessScanProfileLabel('standards'),
    formatAccessScanProfileLabel('commercial-parity'),
  );
});

test('HTML accessScan section and scanner evidence label the active profile unambiguously', () => {
  const commercialSection = buildAccessScanSection([accessScanViolation()], {
    profile: 'commercial-parity',
    comparatorVersion: CORPUS_COMPARATOR_VERSION,
  });
  const standardsSection = buildAccessScanSection([accessScanViolation({
    evidence: {
      violationType: 'confirmed',
      profile: 'standards',
      checkId: 'lists:list-empty',
    },
  })], {
    profile: 'standards',
    comparatorVersion: CORPUS_COMPARATOR_VERSION,
  });

  assert.match(commercialSection, /commercial parity/i);
  assert.match(standardsSection, /standards/i);
  assert.doesNotMatch(standardsSection, /commercial parity/i);

  const evidenceHtml = buildScannerRunEvidence([{
    name: 'homepage',
    scannerRuns: [{
      layer: 'accessScan',
      status: 'complete',
      pageState: 'initial',
      engine: { name: 'ada-scan accessScan', version: '1.0.1' },
      viewport: { name: 'desktop', width: 1280, height: 900 },
      evidence: {
        profile: 'commercial-parity',
        comparatorVersion: CORPUS_COMPARATOR_VERSION,
        execution: buildAccessScanExecutionTotals(sampleExecutionRecords()),
      },
    }],
  }]);

  assert.match(evidenceHtml, /commercial parity/i);
  assert.match(evidenceHtml, /comparator/i);
  assert.match(evidenceHtml, /lists:list-empty/);
});

test('finding confirmation identity includes frame and shadow scope', () => {
  const base = {
    canonicalRuleId: 'ListEmpty',
    element: {
      selector: '#jobs',
      normalizedHtmlHash: 'sha256:dom',
      framePath: [],
      shadowPath: [],
    },
  };
  const shadowScoped = {
    ...base,
    element: { ...base.element, shadowPath: ['host', 'panel'] },
  };
  const frameScoped = {
    ...base,
    element: { ...base.element, framePath: ['iframe[name=jobs]'] },
  };

  assert.equal(findingConfirmationIdentity(base), findingConfirmationIdentity({ ...base }));
  assert.notEqual(
    findingConfirmationIdentity(base),
    findingConfirmationIdentity(shadowScoped),
  );
  assert.notEqual(
    findingConfirmationIdentity(base),
    findingConfirmationIdentity(frameScoped),
  );
});

test('commercial parity findings stay manual-only without independent standards confirmation', () => {
  const commercial = {
    fixUnitId: 'u-commercial',
    kind: 'accessibility',
    canonicalRuleId: 'ListEmpty',
    findings: [{
      fix: { deterministic: true },
      evidence: {
        violationType: 'commercial-parity',
        profile: 'commercial-parity',
        classification: 'commercial-parity-heuristic',
        fixPolicy: 'mechanically_safe',
      },
      element: { selector: '#jobs', normalizedHtmlHash: 'sha256:dom', framePath: [], shadowPath: [] },
      canonicalRuleId: 'ListEmpty',
    }],
  };

  assert.equal(hasIndependentStandardsConfirmation(commercial), false);
  assert.equal(lookupPolicyDecision(commercial).policy, POLICIES.MANUAL_ONLY);
});

test('commercial findings become mechanically safe only with matching confirmed standards identity', () => {
  const identity = {
    selector: '#jobs',
    normalizedHtmlHash: 'sha256:dom',
    framePath: [],
    shadowPath: [],
  };
  const unit = {
    fixUnitId: 'u-confirmed',
    kind: 'accessibility',
    canonicalRuleId: 'ListEmpty',
    findings: [
      {
        fix: { deterministic: false },
        evidence: { violationType: 'commercial-parity', profile: 'commercial-parity' },
        element: identity,
        canonicalRuleId: 'ListEmpty',
      },
      {
        fix: { deterministic: true },
        evidence: { violationType: 'confirmed', profile: 'standards' },
        element: identity,
        canonicalRuleId: 'ListEmpty',
      },
    ],
  };

  assert.equal(hasIndependentStandardsConfirmation(unit), true);
  assert.equal(lookupPolicyDecision(unit).policy, POLICIES.MECHANICALLY_SAFE);
});

test('dual-profile descriptor membership does not confirm commercial findings on scope mismatch', () => {
  const unit = {
    fixUnitId: 'u-mismatch',
    kind: 'accessibility',
    canonicalRuleId: 'ListEmpty',
    findings: [
      {
        fix: { deterministic: false },
        evidence: {
          violationType: 'commercial-parity',
          profile: 'commercial-parity',
          classification: 'commercial-parity-heuristic',
          checkId: 'lists:list-empty',
        },
        element: {
          selector: '#jobs',
          normalizedHtmlHash: 'sha256:dom',
          framePath: [],
          shadowPath: ['host'],
        },
        canonicalRuleId: 'ListEmpty',
      },
      {
        fix: { deterministic: true },
        evidence: {
          violationType: 'confirmed',
          profile: 'standards',
          checkId: 'lists:list-empty',
        },
        element: {
          selector: '#jobs',
          normalizedHtmlHash: 'sha256:dom',
          framePath: [],
          shadowPath: [],
        },
        canonicalRuleId: 'ListEmpty',
      },
    ],
  };

  assert.equal(hasIndependentStandardsConfirmation(unit), false);
  assert.equal(lookupPolicyDecision(unit).policy, POLICIES.MANUAL_ONLY);
});

test('buildAccessScanExecutionTotals coerces invalid counts and aggregates error and timeout statuses', () => {
  const totals = buildAccessScanExecutionTotals([
    {
      ruleId: 'BrokenRule',
      status: 'error',
      durationMs: 4,
      candidateCount: Number.NaN,
      findingCount: -3,
      checks: [
        {
          checkId: 'broken:check',
          status: 'error',
          durationMs: 4,
          candidateCount: 'bad',
          findingCount: 2.9,
        },
        {
          checkId: 'slow:check',
          status: 'timeout',
          durationMs: 30,
          candidateCount: 1,
          findingCount: 0,
        },
      ],
    },
  ]);

  assert.deepEqual(totals.aggregates.rules, {
    complete: 0,
    inapplicable: 0,
    error: 1,
    timeout: 0,
    skipped: 0,
  });
  assert.deepEqual(totals.aggregates.checks, {
    complete: 0,
    inapplicable: 0,
    error: 1,
    timeout: 1,
    skipped: 0,
    candidates: 1,
    findings: 2,
  });
});

test('buildAccessScanRun records execution totals with error and timeout aggregates', () => {
  const totals = buildAccessScanExecutionTotals([
    {
      ruleId: 'BrokenRule',
      status: 'error',
      durationMs: 4,
      candidateCount: 0,
      findingCount: 0,
      checks: [{
        checkId: 'broken:check',
        status: 'error',
        durationMs: 4,
        candidateCount: 0,
        findingCount: 0,
      }],
    },
  ]);
  const run = scanner.buildAccessScanRun([], {
    engineVersion: '1.0.1',
    profile: PROFILES.STANDARDS,
    executionTotals: totals,
  });

  assert.equal(run.evidence.execution.aggregates.checks.error, 1);
  assert.equal(run.evidence.comparatorVersion, CORPUS_COMPARATOR_VERSION);
});

test('skipRules emit skipped per-check execution records for active-profile checks', async () => {
  const registry = await loadBuiltInRuleRegistry();
  const { executionRecords } = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: { snapshot: { elements: [], diagnostics: [], counts: {} }, session: { metrics: {} } },
    skipRules: ['ListEmpty'],
  });
  const skipped = executionRecords.find((record) => record.ruleId === 'ListEmpty');
  assert.ok(skipped);
  assert.equal(skipped.status, 'skipped');
  assert.ok(skipped.checks.length > 0);
  assert.ok(skipped.checks.every((check) => check.status === 'skipped'));
  const totals = buildAccessScanExecutionTotals(executionRecords);
  assert.equal(totals.aggregates.rules.skipped >= 1, true);
  assert.equal(totals.aggregates.checks.skipped >= skipped.checks.length, true);
});

test('extractAccessScanRunMetadata aggregates execution totals across all accessScan page runs', () => {
  const pageTotals = buildAccessScanExecutionTotals(sampleExecutionRecords());
  const otherTotals = buildAccessScanExecutionTotals([
    {
      ruleId: 'HtmlLang',
      status: 'complete',
      durationMs: 5,
      candidateCount: 1,
      findingCount: 0,
      checks: [{
        checkId: 'document:html-lang',
        status: 'complete',
        durationMs: 5,
        candidateCount: 1,
        findingCount: 0,
      }],
    },
  ]);

  const scanners = [
    {
      layer: 'accessScan',
      evidence: {
        profile: 'commercial-parity',
        includeThirdParty: true,
        comparatorVersion: CORPUS_COMPARATOR_VERSION,
        execution: pageTotals,
      },
    },
    {
      layer: 'accessScan',
      evidence: {
        profile: 'commercial-parity',
        includeThirdParty: true,
        comparatorVersion: CORPUS_COMPARATOR_VERSION,
        execution: otherTotals,
      },
    },
  ];

  const metadata = extractAccessScanRunMetadata(scanners);
  assert.equal(metadata.profile, 'commercial-parity');
  assert.equal(metadata.includeThirdParty, true);
  assert.equal(metadata.pageRunCount, 2);
  assert.equal(metadata.execution.aggregates.checks.candidates, 3);
  assert.equal(metadata.execution.aggregates.rules.complete, 2);
  const listCheck = metadata.execution.perCheck.find((check) => check.checkId === 'lists:list-empty');
  assert.equal(listCheck.status, 'complete');
  assert.equal(listCheck.candidateCount, 2);
});

test('multi-page buildScanReportV2 runMetadata merges execution totals deterministically', () => {
  const homepageTotals = buildAccessScanExecutionTotals(sampleExecutionRecords());
  const jobsTotals = buildAccessScanExecutionTotals([{
    ruleId: 'HtmlLang',
    status: 'skipped',
    durationMs: 0,
    candidateCount: 0,
    findingCount: 0,
    checks: [{
      checkId: 'document:html-lang',
      status: 'skipped',
      durationMs: 0,
      candidateCount: 0,
      findingCount: 0,
    }],
  }]);

  const report = buildScanReportV2([
    {
      page: 'homepage',
      url: 'https://example.test/',
      violations: [accessScanViolation()],
      scannerRuns: [scanner.buildAccessScanRun([accessScanViolation()], {
        includeThirdParty: true,
        engineVersion: '1.0.1',
        profile: PROFILES.COMMERCIAL_PARITY,
        executionTotals: homepageTotals,
      })],
    },
    {
      page: 'jobs',
      url: 'https://example.test/jobs',
      violations: [],
      scannerRuns: [scanner.buildAccessScanRun([], {
        includeThirdParty: true,
        engineVersion: '1.0.1',
        profile: PROFILES.COMMERCIAL_PARITY,
        executionTotals: jobsTotals,
      })],
    },
  ], fixture.context);

  assert.equal(report.runMetadata.accessScan.pageRunCount, 2);
  assert.equal(report.runMetadata.accessScan.execution.aggregates.rules.skipped, 1);
  const htmlLang = report.runMetadata.accessScan.execution.perCheck
    .find((check) => check.checkId === 'document:html-lang');
  assert.equal(htmlLang.status, 'skipped');
  assert.deepEqual(
    report.runMetadata.accessScan.execution,
    mergeAccessScanExecutionTotals([homepageTotals, jobsTotals]),
  );
});

test('validateScanReportV2 rejects tampered runMetadata while reportId stays stable', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [accessScanViolation()],
    scannerRuns: [scanner.buildAccessScanRun([accessScanViolation()], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
      executionTotals: buildAccessScanExecutionTotals(sampleExecutionRecords()),
    })],
  }], fixture.context);

  const originalId = report.reportId;
  report.runMetadata.accessScan.profile = 'standards';
  assert.equal(computeReportId(report), originalId);
  assert.throws(
    () => validateScanReportV2(report),
    /runMetadata\.accessScan must match scanner evidence/i,
  );
});

test('reports without accessScan runs keep optional runMetadata compatibility', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [{
      id: 'runtime-axe',
      ruleId: 'button-name',
      layer: 'axe',
      impact: 'critical',
      element: { selector: '#btn', outerHTML: '<button id="btn"></button>' },
      source: { confidence: 'none', method: 'unresolved' },
      fix: { deterministic: false, hint: 'Needs a name.' },
    }],
    scannerRuns: [scanner.buildAxeScannerRuns({
      summary: { viewports: [{ name: 'desktop', width: 1280, height: 900, issueGroups: 1, affectedNodes: 1 }] },
    })[0]],
  }], fixture.context);

  assert.equal(report.runMetadata, undefined);
  assert.doesNotThrow(() => validateScanReportV2(report));
});

test('shared evidence resolvers read nested observation markers for commercial parity', () => {
  const finding = {
    evidence: {
      message: 'List issue',
      observations: [{
        layer: 'accessScan',
        nativeRuleId: 'ListEmpty',
        evidence: {
          profile: 'commercial-parity',
          classification: 'commercial-parity-heuristic',
        },
        element: {
          selector: '#jobs',
          normalizedHtmlHash: 'sha256:dom',
          framePath: [],
          shadowPath: [],
        },
      }],
    },
  };

  assert.equal(resolveFindingEvidenceSlices(finding).length, 2);
  assert.equal(isCommercialParityFinding(finding), true);
  assert.equal(isStandardsConfirmedFinding(finding), false);
});

test('V1 round-trip commercial-only projected unit stays manual_only', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [accessScanViolation({
      evidence: {
        message: 'List issue',
        observations: [],
        violationType: 'commercial-parity',
        profile: 'commercial-parity',
        classification: 'commercial-parity-heuristic',
      },
    })],
    scannerRuns: [scanner.buildAccessScanRun([accessScanViolation()], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
    })],
  }], fixture.context);

  const legacy = projectReportV1(report);
  const units = buildFixUnitsFromProjectedViolations(legacy.pages[0].violations);
  assert.equal(units.length, 1);
  assert.equal(lookupPolicyDecision(units[0]).policy, POLICIES.MANUAL_ONLY);
});

test('V1 round-trip exact standards twin unlocks mechanically safe without changing violation fields', () => {
  const elementObservation = {
    selector: '#jobs',
    normalizedHtmlHash: 'sha256:dom',
    framePath: [],
    shadowPath: [],
  };
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [
      accessScanViolation({
        ruleId: 'ListEmpty',
        fix: { deterministic: false, hint: 'Parity issue.' },
        evidence: {
          message: 'Parity issue.',
          observations: [{
            layer: 'accessScan',
            nativeRuleId: 'ListEmpty',
            evidence: {
              violationType: 'commercial-parity',
              profile: 'commercial-parity',
            },
            element: elementObservation,
          }],
        },
      }),
      accessScanViolation({
        id: 'runtime-standards',
        ruleId: 'ListEmpty',
        fix: { deterministic: true, hint: 'Standards issue.' },
        evidence: {
          message: 'Standards issue.',
          observations: [{
            layer: 'accessScan',
            nativeRuleId: 'ListEmpty',
            evidence: {
              violationType: 'confirmed',
              profile: 'standards',
            },
            element: elementObservation,
          }],
        },
      }),
    ],
    scannerRuns: [scanner.buildAccessScanRun([], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
    })],
  }], fixture.context);

  const legacy = projectReportV1(report);
  const violationKeys = Object.keys(legacy.pages[0].violations[0]).sort();
  assert.ok(violationKeys.includes('element'));
  assert.ok(!('framePath' in (legacy.pages[0].violations[0].element || {})));

  const units = buildFixUnitsFromProjectedViolations(legacy.pages[0].violations);
  assert.equal(units.length, 1);
  assert.equal(lookupPolicyDecision(units[0]).policy, POLICIES.MECHANICALLY_SAFE);
});

test('V1 round-trip profile or classification spoof does not unlock mechanically safe', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [accessScanViolation({
      fix: { deterministic: true, hint: 'Spoofed.' },
      evidence: {
        message: 'Spoofed.',
        observations: [{
          layer: 'accessScan',
          nativeRuleId: 'ListEmpty',
          evidence: {
            violationType: 'confirmed',
            profile: 'commercial-parity',
            fixPolicy: 'mechanically_safe',
            classification: 'commercial-parity-heuristic',
          },
          element: {
            selector: '#jobs',
            normalizedHtmlHash: 'sha256:dom',
            framePath: [],
            shadowPath: [],
          },
        }],
      },
    })],
    scannerRuns: [scanner.buildAccessScanRun([accessScanViolation()], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
    })],
  }], fixture.context);

  const legacy = projectReportV1(report);
  const units = buildFixUnitsFromProjectedViolations(legacy.pages[0].violations);
  assert.equal(lookupPolicyDecision(units[0]).policy, POLICIES.MANUAL_ONLY);
});

test('V1 round-trip frame and shadow mismatch remains manual_only', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [
      accessScanViolation({
        evidence: {
          message: 'Parity',
          observations: [{
            layer: 'accessScan',
            nativeRuleId: 'ListEmpty',
            evidence: { violationType: 'commercial-parity', profile: 'commercial-parity' },
            element: {
              selector: '#jobs',
              normalizedHtmlHash: 'sha256:dom',
              framePath: [],
              shadowPath: ['host'],
            },
          }],
        },
      }),
      accessScanViolation({
        id: 'runtime-standards',
        evidence: {
          message: 'Standards',
          observations: [{
            layer: 'accessScan',
            nativeRuleId: 'ListEmpty',
            evidence: { violationType: 'confirmed', profile: 'standards' },
            element: {
              selector: '#jobs',
              normalizedHtmlHash: 'sha256:dom',
              framePath: [],
              shadowPath: [],
            },
          }],
        },
      }),
    ],
    scannerRuns: [scanner.buildAccessScanRun([], {
      includeThirdParty: true,
      engineVersion: '1.0.1',
      profile: PROFILES.COMMERCIAL_PARITY,
    })],
  }], fixture.context);

  const legacy = projectReportV1(report);
  const units = buildFixUnitsFromProjectedViolations(legacy.pages[0].violations);
  assert.equal(units.length, 1);
  assert.equal(lookupPolicyDecision(units[0]).policy, POLICIES.MANUAL_ONLY);
});

test('printConsoleSummary includes accessScan profile comparator and execution totals', () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const report = buildScanReportV2([{
      page: 'homepage',
      url: 'https://example.test/',
      violations: [],
      scannerRuns: [scanner.buildAccessScanRun([], {
        includeThirdParty: false,
        engineVersion: '1.0.1',
        profile: PROFILES.STANDARDS,
        executionTotals: buildAccessScanExecutionTotals(sampleExecutionRecords()),
      })],
    }], fixture.context);
    printConsoleSummary(report);
  } finally {
    console.log = original;
  }

  const output = logs.join('\n');
  assert.match(output, /accessScan run metadata/i);
  assert.match(output, /Profile:\s+standards/);
  assert.match(output, /Comparator:\s+1\.0\.0/);
  assert.match(output, /Check totals:/);
});

test('HTML fallback metadata includes includeThirdParty and escapes impact attributes', () => {
  const section = buildAccessScanSection([
    accessScanViolation({ impact: '"><script>alert(1)</script>' }),
  ], {
    profile: 'commercial-parity',
    includeThirdParty: true,
    comparatorVersion: CORPUS_COMPARATOR_VERSION,
  });

  assert.match(section, /Legacy includeThirdParty: true/);
  assert.doesNotMatch(section, /<script>alert\(1\)<\/script>/);
  assert.match(section, /<div class="as-rule-card violation-card" data-impact="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

function injectionViolation(overrides = {}) {
  return {
    id: 'inj-1',
    ruleId: 'button-name',
    impact: '"><script>alert(1)</script>',
    layer: 'axe" onclick="alert(1)" x="',
    category: '"><img onerror=alert(1)>',
    element: { selector: 'button', outerHTML: '<button></button>' },
    fix: { hint: 'Provide discernible text', deterministic: false },
    ...overrides,
  };
}

test('HTML axe violation cards escape data-impact data-layer and data-category', () => {
  const section = buildAxeSection([injectionViolation({ layer: 'axe" onclick="alert(1)" x="' })]);
  const cardTag = section.match(/<div class="violation-card"[^>]*>/)?.[0] || '';

  assert.match(cardTag, /<div class="violation-card" data-impact="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(cardTag, /data-layer="axe&quot; onclick=&quot;alert\(1\)&quot; x=&quot;"/);
  assert.match(cardTag, /data-category="&quot;&gt;&lt;img onerror=alert\(1\)&gt;"/);
  assert.doesNotMatch(cardTag, /onclick="alert\(1\)"/);
});

test('HTML generic violation cards escape data-impact data-layer and data-category', () => {
  const section = buildGenericViolationSection([injectionViolation({
    layer: 'w3c" onclick="alert(2)" x="',
    category: '"><svg onload=alert(2)>',
    ruleId: 'duplicate-id',
  })]);
  const cardTag = section.match(/<div class="violation-card"[^>]*>/)?.[0] || '';

  assert.match(cardTag, /<div class="violation-card" data-impact="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(cardTag, /data-layer="w3c&quot; onclick=&quot;alert\(2\)&quot; x=&quot;"/);
  assert.match(cardTag, /data-category="&quot;&gt;&lt;svg onload=alert\(2\)&gt;"/);
  assert.doesNotMatch(cardTag, /onclick="alert\(2\)"/);
});

test('HTML scanner evidence recognizes skipped run status with matching CSS', () => {
  const evidenceHtml = buildScannerRunEvidence([{
    name: 'homepage',
    scannerRuns: [{
      layer: 'accessScan',
      status: 'skipped',
      pageState: 'initial',
      engine: { name: 'ada-scan accessScan', version: '1.0.1' },
    }],
  }]);

  assert.match(evidenceHtml, /scanner-status scanner-status--skipped/);
  assert.match(evidenceHtml, />skipped</);

  const reportHtml = buildHtml({
    pages: [{
      scannerRuns: [{
        layer: 'axe',
        status: 'skipped',
        pageState: 'initial',
        engine: { name: 'axe-core', version: '4.10' },
      }],
    }],
  });

  assert.match(reportHtml, /\.scanner-status--skipped\s*\{/);
  assert.match(reportHtml, /scanner-status--skipped/);
});
