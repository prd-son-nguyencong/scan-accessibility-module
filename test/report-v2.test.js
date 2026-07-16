import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSourcePath,
  stableFindingFingerprint,
} from '../src/reporter/fingerprint.js';
import {
  buildScanReportV2,
  projectReportV1,
  validateScanReportV2,
} from '../src/reporter/report-v2.js';
import { buildReportBundle } from '../src/reporter/scan-report.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/fix/report-v2.json', import.meta.url), 'utf8')
);

function fixtureFinding(overrides = {}) {
  return {
    id: 'runtime-id',
    foundAt: '2026-07-15T00:00:00.000Z',
    nativeRuleId: 'select-name',
    canonicalRuleId: 'select-name',
    pageState: 'initial',
    route: '/',
    element: {
      selector: '#sort-select',
      normalizedHtmlHash: 'sha256:dom',
    },
    source: {
      file: 'src/partials/jobs/sort.liquid',
      line: 12,
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: 'sha256:source',
    },
    evidence: {
      observations: [
        { layer: 'axe', nativeRuleId: 'select-name' },
        { layer: 'lighthouse', nativeRuleId: 'select-name' },
      ],
    },
    ...overrides,
  };
}

test('finding identity ignores UUID, timestamp, and scanner order', () => {
  const a = fixtureFinding({
    id: 'one',
    foundAt: '2026-07-15T00:00:00.000Z',
  });
  const b = fixtureFinding({
    id: 'two',
    foundAt: '2026-07-16T00:00:00.000Z',
    evidence: {
      observations: [...a.evidence.observations].reverse(),
    },
  });

  assert.equal(stableFindingFingerprint(a), stableFindingFingerprint(b));
});

test('different source preimages do not collapse', () => {
  const a = fixtureFinding({
    source: {
      ...fixtureFinding().source,
      preimageSha256: 'sha256:a',
    },
  });
  const b = fixtureFinding({
    source: {
      ...fixtureFinding().source,
      preimageSha256: 'sha256:b',
    },
  });

  assert.notEqual(stableFindingFingerprint(a), stableFindingFingerprint(b));
});

test('null source paths stay unresolved instead of becoming the string "null"', () => {
  assert.equal(normalizeSourcePath(null), '');

  const scanResults = structuredClone(fixture.scanResults);
  scanResults[0].violations = [{
    ...scanResults[0].violations[0],
    id: 'runtime-url-only',
    source: {
      mode: 'url',
      file: null,
      line: null,
      confidence: 'none',
      method: 'unresolved',
      preimageSha256: null,
    },
  }];
  const report = buildScanReportV2(scanResults, fixture.context);

  assert.equal(report.pages[0].findings[0].source.file, null);
  assert.deepEqual(report.pages[0].dependencies, []);
});

test('commercial accessScan aliases canonicalize without renaming native rules', () => {
  const scanResults = structuredClone(fixture.scanResults);
  const base = scanResults[0].violations[0];
  scanResults[0].violations = [
    {
      ...base,
      id: 'runtime-focus-header',
      ruleId: 'StickyHeaderObscuresFocus',
      element: {
        ...base.element,
        outerHTML: '<button id="covered">Covered</button>',
        selector: '#covered',
      },
    },
    {
      ...base,
      id: 'runtime-tablist',
      ruleId: 'TablistRole',
      element: {
        ...base.element,
        outerHTML: '<div class="tabs"></div>',
        selector: '.tabs',
      },
    },
  ];
  const report = buildScanReportV2(scanResults, fixture.context);
  const findings = Object.fromEntries(
    report.pages[0].findings.map((finding) => [finding.nativeRuleId, finding])
  );

  assert.equal(findings.StickyHeaderObscuresFocus.canonicalRuleId, 'FocusNotObscuredHeader');
  assert.equal(findings.TablistRole.canonicalRuleId, 'TabListMisMatch');
});

test('ScanReportV2 IDs are deterministic across runtime order and timestamps', () => {
  const context = fixture.context;
  const first = buildScanReportV2(fixture.scanResults, {
    ...context,
    generatedAt: '2026-07-15T00:00:00.000Z',
  });
  const reordered = fixture.scanResults
    .map((page) => ({
      ...page,
      violations: [...page.violations].reverse(),
      scannerRuns: [...page.scannerRuns].reverse(),
    }))
    .reverse();
  const second = buildScanReportV2(reordered, {
    ...context,
    generatedAt: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(first.schemaVersion, '2.0.0');
  assert.equal(first.reportId, second.reportId);
  assert.deepEqual(
    first.pages.flatMap((page) => page.findings.map((finding) => finding.findingId)).sort(),
    second.pages.flatMap((page) => page.findings.map((finding) => finding.findingId)).sort(),
  );
  assert.equal(validateScanReportV2(first), true);
});

test('ScanReportV2 merges duplicate scanner observations without losing provenance', () => {
  const scanResults = structuredClone(fixture.scanResults);
  scanResults[0].violations.push({
    ...structuredClone(scanResults[0].violations[0]),
    id: 'duplicate-runtime-id',
  });
  const report = buildScanReportV2(scanResults, fixture.context);
  const selectFinding = report.pages
    .flatMap((page) => page.findings)
    .find((finding) => finding.nativeRuleId === 'select-name');

  assert.deepEqual(selectFinding.layers, ['axe', 'lighthouse']);
  assert.equal(selectFinding.evidence.observations.length, 2);
  assert.equal(selectFinding.count, 1);
});

test('V1 projection is pure and retains legacy page evidence', () => {
  const scanResults = structuredClone(fixture.scanResults);
  scanResults[0].violations[0].related = ['heading-order'];
  const report = buildScanReportV2(scanResults, fixture.context);
  const before = structuredClone(report);
  const legacy = projectReportV1(report);

  assert.deepEqual(report, before);
  assert.equal(legacy.timestamp, report.generatedAt);
  assert.equal(legacy.pages[0].violations[0].id.startsWith('sha256:'), true);
  assert.equal(legacy.pages[0].scannerRuns.length, fixture.scanResults[0].scannerRuns.length);
  assert.deepEqual(legacy.pages[0].lighthouseScores, fixture.scanResults[0].lighthouseScores);
  assert.equal(legacy.summary.totalViolations, 3);
  assert.deepEqual(
    legacy.pages[0].violations.find((violation) => violation.ruleId === 'select-name').related,
    ['heading-order'],
  );
});

test('V2 validation fails closed when trace confidence is missing', () => {
  const report = buildScanReportV2(fixture.scanResults, fixture.context);
  delete report.pages[0].findings[0].source.confidence;

  assert.throws(
    () => validateScanReportV2(report),
    /source confidence/i,
  );
});

test('report bundle exposes V2 as source of truth and a temporary V1 projection', () => {
  assert.equal(typeof buildReportBundle, 'function');
  const bundle = buildReportBundle(fixture.scanResults, fixture.context);

  assert.equal(bundle.report.schemaVersion, '2.0.0');
  assert.equal(bundle.legacyReport.timestamp, bundle.report.generatedAt);
  assert.equal(bundle.legacyReport.summary.pagesScanned, 1);
  assert.equal(bundle.legacyReport.summary.totalViolations, 3);
  assert.equal(bundle.legacyReport.pages[0].violations.length, 2);
});

test('hybrid reports require revision and instrumentation attestation', () => {
  assert.throws(
    () => buildScanReportV2(fixture.scanResults, {
      ...fixture.context,
      target: {
        ...fixture.context.target,
        mode: 'hybrid',
        buildRevision: null,
        instrumentationDigest: null,
      },
    }),
    /build revision/i,
  );
});

test('local reports preserve an explicit unattested state when instrumentation is absent', () => {
  const report = buildScanReportV2(fixture.scanResults, {
    ...fixture.context,
    target: {
      ...fixture.context.target,
      mode: 'local-only',
      buildRevision: fixture.context.target.buildRevision,
      instrumentationDigest: null,
    },
  });

  assert.equal(report.target.mode, 'local-only');
  assert.equal(report.target.instrumentationDigest, null);
});

test('high-confidence source traces require a source preimage hash', () => {
  const report = buildScanReportV2(fixture.scanResults, fixture.context);
  const finding = report.pages
    .flatMap((page) => page.findings)
    .find((item) => item.source.confidence === 'high');
  finding.source.preimageSha256 = null;

  assert.throws(
    () => validateScanReportV2(report),
    /preimage/i,
  );
});

test('V2 validation rejects dangling scanner-run references', () => {
  const report = buildScanReportV2(fixture.scanResults, fixture.context);
  report.scanners = report.scanners.slice(1);

  assert.throws(
    () => validateScanReportV2(report),
    /scanner run reference/i,
  );
});

test('source preimages are discarded when no source line is attested', () => {
  const scanResults = structuredClone(fixture.scanResults);
  const violation = scanResults[0].violations.find(
    (item) => item.ruleId === 'w3c-duplicate-id'
  );
  violation.source.line = null;
  const report = buildScanReportV2(scanResults, fixture.context);
  const finding = report.pages[0].findings.find(
    (item) => item.nativeRuleId === 'w3c-duplicate-id'
  );

  assert.equal(finding.source.preimageSha256, null);
  assert.equal(finding.source.preimageRange, null);
});
