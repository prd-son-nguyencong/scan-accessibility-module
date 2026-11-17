import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as html from '../src/reporter/html.js';
import { getAccessScanRuleRequirement } from '../src/scanner/access-scan/engine/public-catalog.js';

function assertRequirement(ruleId) {
  const copy = html.getAccessScanRuleRequirement(ruleId);
  const registry = getAccessScanRuleRequirement(ruleId);
  assert.deepEqual(copy, registry);
  assert.equal(typeof copy.title, 'string');
  assert.equal(typeof copy.requirement, 'string');
  assert.equal(typeof copy.recommendation, 'string');
}

test('accessScan rule copy preserves commercial ARIA wording', () => {
  assert.equal(typeof html.getAccessScanRuleRequirement, 'function');
  assertRequirement('VisibleTextPartOfAccessibleName');
});

test('accessScan main-landmark copy matches the commercial requirements', () => {
  assertRequirement('RegionMainContentMismatch');
  assertRequirement('RegionMainContentMisuse');
  assertRequirement('RegionMainContentSingle');
});

test('accessScan credential-gate copy matches the commercial requirements', () => {
  assertRequirement('VisibilityMisuse');
  assertRequirement('PageTitleDescriptive');
  assertRequirement('ImageDiscernible');
});

test('accessScan form and navigation copy matches the commercial requirements', () => {
  assertRequirement('RequiredFormFieldAriaRequired');
  assertRequirement('NavigationMisuse');
});

test('accessScan button copy matches the commercial requirement', () => {
  assertRequirement('ButtonMismatch');
});

test('accessScan rule cards render failed and successful element snapshots', () => {
  assert.equal(typeof html.buildAccessScanRuleCard, 'function');
  const markup = html.buildAccessScanRuleCard('RegionMainContentMisuse', [{
    id: 'finding-1',
    wcagRef: 'WCAG 2.0 A 1.3.1',
    impact: 'moderate',
    element: {
      outerHTML: '<main id="jobs-main"><h2>Jobs</h2></main>',
      selector: '#jobs-main',
    },
    evidence: {
      observations: [{
        evidence: {
          successfulElements: [{
            outerHTML: '<main><h1>Page</h1></main>',
            selector: 'main',
          }],
        },
      }],
    },
    fix: { deterministic: false, hint: 'Keep a single main landmark.' },
  }]);

  assert.match(markup, /1 code snapshot of failed element/);
  assert.match(markup, /1 code snapshot of successful element/);
  assert.match(markup, /&lt;main id=&quot;jobs-main&quot;&gt;/);
  assert.match(markup, /&lt;main&gt;/);
});

test('buildPerformanceProvenance warns when PSI falls back to local Lighthouse', () => {
  assert.equal(typeof html.buildPerformanceProvenance, 'function');
  const markup = html.buildPerformanceProvenance({
    source: 'local-fallback',
    provenance: {
      requestedSource: 'psi-api',
      actualSource: 'local',
      comparableToPsi: false,
      fallbackReason: { code: 'quota-exceeded', status: 429 },
    },
  });

  assert.match(markup, /Local Lighthouse fallback/);
  assert.match(markup, /not comparable to a PageSpeed Insights baseline/);
  assert.match(markup, /quota exceeded/i);
});

test('buildPerformanceProvenance identifies comparable PSI API evidence', () => {
  const markup = html.buildPerformanceProvenance({
    source: 'psi-api',
    provenance: {
      requestedSource: 'psi-api',
      actualSource: 'psi-api',
      comparableToPsi: true,
      fallbackReason: null,
    },
  });

  assert.match(markup, /PageSpeed Insights API/);
  assert.match(markup, /comparable to PSI baselines/);
});

test('buildPerformanceProvenance recognizes legacy local-fallback source', () => {
  const markup = html.buildPerformanceProvenance({
    source: 'local-fallback',
  });

  assert.match(markup, /Local Lighthouse fallback/);
  assert.match(markup, /not comparable to a PageSpeed Insights baseline/);
});

test('buildPerformanceDashboard renders provenance when scores are unavailable', () => {
  assert.equal(typeof html.buildPerformanceDashboard, 'function');
  const markup = html.buildPerformanceDashboard({
    remote: {
      source: 'error',
      lighthouse: null,
      provenance: {
        requestedSource: 'psi-api',
        actualSource: 'error',
        comparableToPsi: false,
        fallbackReason: { code: 'quota-exceeded', status: 429 },
      },
    },
  });

  assert.match(markup, /PageSpeed Insights unavailable/);
  assert.match(markup, /No performance scores were produced/);
});

test('buildScannerRunEvidence renders engine, state, viewport, and raw totals', () => {
  assert.equal(typeof html.buildScannerRunEvidence, 'function');
  const markup = html.buildScannerRunEvidence([
    {
      name: 'HIT-01 Homepage',
      url: 'https://example.test/',
      scannerRuns: [
        {
          layer: 'w3c',
          engine: { name: 'Nu Html Checker', version: '26.7.15' },
          viewport: null,
          pageState: 'initial',
          status: 'complete',
          raw: { messageCount: 35, errors: 21, warnings: 14, artifactFilteredCount: 0 },
          supplemental: { candidateCount: 63, addedCount: 50, suppressedCount: 13 },
          emitted: { actionableOccurrences: 35, actionableFixUnits: 31, infoFixUnits: 50 },
        },
        {
          layer: 'axe',
          engine: { name: 'axe-core', version: '4.10.3' },
          viewport: { name: 'desktop', width: 1280, height: 900 },
          pageState: 'initial',
          status: 'complete',
          evidence: { issueGroups: 7, affectedNodes: 11, incomplete: 2 },
        },
        {
          layer: 'lighthouse',
          engine: { name: 'Lighthouse', version: '13.1.0' },
          viewport: { name: 'mobile', width: 412, height: 823 },
          pageState: 'initial',
          status: 'fallback',
          source: 'local-fallback',
          evidence: {
            accessibility: {
              rawAuditCount: 54,
              issueGroups: 7,
              affectedNodes: 11,
              passed: 37,
              manual: 5,
              notApplicable: 5,
              incomplete: 0,
            },
          },
        },
      ],
    },
  ]);

  assert.match(markup, /Scan evidence/);
  assert.match(markup, /Nu Html Checker/);
  assert.match(markup, /26\.7\.15/);
  assert.match(markup, /Initial state/);
  assert.match(markup, /35 raw messages/);
  assert.match(markup, /21 errors/);
  assert.match(markup, /31 fix units/);
  assert.match(markup, /1280.*900/);
  assert.match(markup, /7 issue groups/);
  assert.match(markup, /2 incomplete/);
  assert.match(markup, /54 accessibility audits/);
  assert.match(markup, /5 manual checks/);
});
