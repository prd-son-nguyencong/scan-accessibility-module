import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildFixUnits } from '../../src/fix/canonical/fix-unit.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8')
);

const PREIMAGE_A = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PREIMAGE_B = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function axeSelectName(overrides = {}) {
  return {
    findingId: 'sha256:axe-select-name',
    nativeRuleId: 'select-name',
    canonicalRuleId: 'select-name',
    layer: 'axe',
    category: 'accessibility',
    pageState: 'initial',
    route: '/',
    element: {
      selector: '#sort-select',
      normalizedHtmlHash: 'sha256:dom-sort',
    },
    source: {
      file: 'src/partials/jobs/sort.liquid',
      line: 12,
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: PREIMAGE_A,
    },
    evidence: {
      message: 'Select element must have an accessible name.',
      observations: [{ layer: 'axe', nativeRuleId: 'select-name' }],
    },
    ...overrides,
  };
}

function lighthouseSelectName(overrides = {}) {
  return {
    findingId: 'sha256:lighthouse-select-name',
    nativeRuleId: 'select-name',
    canonicalRuleId: 'select-name',
    layer: 'lighthouse',
    category: 'accessibility',
    pageState: 'initial',
    route: '/',
    element: {
      selector: '#sort-select',
      normalizedHtmlHash: 'sha256:dom-sort',
    },
    source: {
      file: 'src/partials/jobs/sort.liquid',
      line: 12,
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: PREIMAGE_A,
    },
    evidence: {
      message: 'Select elements do not have associated label elements.',
      observations: [{ layer: 'lighthouse', nativeRuleId: 'select-name' }],
    },
    ...overrides,
  };
}

test('axe and Lighthouse evidence for one source defect become one unit', () => {
  const units = buildFixUnits([axeSelectName(), lighthouseSelectName()]);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'accessibility');
  assert.deepEqual(
    units[0].evidence.map((item) => item.layer).sort(),
    ['axe', 'lighthouse'],
  );
  assert.equal(units[0].sourceOwner.file, 'src/partials/jobs/sort.liquid');
  assert.equal(units[0].sourceOwner.preimageSha256, PREIMAGE_A);
});

test('every finding belongs to exactly one unit', () => {
  const report = buildScanReportV2(fixture.scanResults, fixture.context);
  const allFindings = report.pages.flatMap((page) => page.findings);
  const units = buildFixUnits(allFindings);
  const ids = units.flatMap((unit) => unit.findingIds);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, allFindings.length);
});

test('different source preimages do not merge into one unit', () => {
  const units = buildFixUnits([
    axeSelectName(),
    axeSelectName({
      findingId: 'sha256:other-select',
      source: {
        file: 'src/partials/jobs/filter.liquid',
        line: 4,
        confidence: 'high',
        method: 'instrumentation-manifest',
        preimageSha256: PREIMAGE_B,
      },
    }),
  ]);
  assert.equal(units.length, 2);
});

test('different page states do not merge into one unit', () => {
  const units = buildFixUnits([
    axeSelectName(),
    axeSelectName({
      findingId: 'sha256:modal-select',
      pageState: 'modal-open',
    }),
  ]);
  assert.equal(units.length, 2);
});

test('repeated routes merge only when source preimage matches', () => {
  const units = buildFixUnits([
    axeSelectName({ route: '/' }),
    axeSelectName({
      findingId: 'sha256:jobs-select',
      route: '/jobs',
    }),
    axeSelectName({
      findingId: 'sha256:about-select',
      route: '/about',
      source: {
        file: 'src/partials/jobs/filter.liquid',
        line: 4,
        confidence: 'high',
        method: 'instrumentation-manifest',
        preimageSha256: PREIMAGE_B,
      },
    }),
  ]);
  assert.equal(units.length, 2);
  const sharedUnit = units.find((unit) => unit.findingIds.length === 2);
  assert.ok(sharedUnit);
  assert.deepEqual(sharedUnit.affectedRoutes.sort(), ['/', '/jobs']);
});

test('evidence from merged scanners is preserved', () => {
  const units = buildFixUnits([axeSelectName(), lighthouseSelectName()]);
  const layers = units[0].evidence.map((item) => item.layer);
  assert.deepEqual(layers.sort(), ['axe', 'lighthouse']);
  assert.ok(units[0].evidence.some((item) => item.nativeRuleId === 'select-name'));
});

test('label and select-name alias merge into one unit when root cause matches', () => {
  const units = buildFixUnits([
    axeSelectName({
      findingId: 'sha256:label-alias',
      nativeRuleId: 'label',
      canonicalRuleId: 'label',
      layer: 'axe',
      evidence: {
        message: 'Form element does not have an associated label.',
        observations: [{ layer: 'axe', nativeRuleId: 'label' }],
      },
    }),
    axeSelectName({
      findingId: 'sha256:select-alias',
      nativeRuleId: 'select-name',
      canonicalRuleId: 'select-name',
      layer: 'lighthouse',
      evidence: {
        message: 'Select element must have an accessible name.',
        observations: [{ layer: 'lighthouse', nativeRuleId: 'select-name' }],
      },
    }),
  ]);
  assert.equal(units.length, 1);
  assert.deepEqual(
    units[0].evidence.map((item) => item.nativeRuleId).sort(),
    ['label', 'select-name'],
  );
});

test('authoritative report canonicalRuleId is preserved for grouping', () => {
  const units = buildFixUnits([
    axeSelectName({
      findingId: 'sha256:auth-a',
      nativeRuleId: 'foo-rule',
      canonicalRuleId: 'report-canonical-group',
    }),
    axeSelectName({
      findingId: 'sha256:auth-b',
      nativeRuleId: 'bar-rule',
      canonicalRuleId: 'report-canonical-group',
      layer: 'lighthouse',
    }),
  ]);
  assert.equal(units.length, 1);
  assert.equal(units[0].canonicalRuleId, 'report-canonical-group');
});

test('alias merge does not combine different source preimages or page states', () => {
  const units = buildFixUnits([
    axeSelectName({
      findingId: 'sha256:label-a',
      nativeRuleId: 'label',
      pageState: 'initial',
    }),
    axeSelectName({
      findingId: 'sha256:select-b',
      nativeRuleId: 'select-name',
      pageState: 'modal-open',
    }),
  ]);
  assert.equal(units.length, 2);
});

function performanceFinding(overrides = {}) {
  return {
    findingId: overrides.findingId || 'sha256:perf',
    nativeRuleId: overrides.nativeRuleId || 'largest-contentful-paint',
    canonicalRuleId: overrides.canonicalRuleId || 'largest-contentful-paint',
    category: 'performance',
    layer: 'lighthouse',
    pageState: 'initial',
    route: overrides.route || '/',
    metric: overrides.metric || 'largest-contentful-paint',
    device: overrides.device || 'mobile',
    affectedResources: overrides.affectedResources || ['https://example.test/hero.webp'],
    source: {
      file: overrides.file || 'src/partials/hero.liquid',
      line: 4,
      confidence: 'medium',
      method: 'hint-search',
      preimageSha256: overrides.preimageSha256 || PREIMAGE_A,
    },
    evidence: {
      message: 'LCP element is slow.',
      device: overrides.device || 'mobile',
      affectedResources: overrides.affectedResources || ['https://example.test/hero.webp'],
    },
    ...overrides,
  };
}

test('performance units merge by metric, route, device, and affected resources', () => {
  const units = buildFixUnits([
    performanceFinding({ findingId: 'sha256:perf-a' }),
    performanceFinding({ findingId: 'sha256:perf-b' }),
  ]);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'performance');
  assert.equal(units[0].findingIds.length, 2);
});

test('performance units split when route, device, or resources differ', () => {
  const units = buildFixUnits([
    performanceFinding({ findingId: 'sha256:perf-route', route: '/' }),
    performanceFinding({
      findingId: 'sha256:perf-device',
      route: '/',
      device: 'desktop',
      evidence: {
        message: 'LCP element is slow.',
        device: 'desktop',
        affectedResources: ['https://example.test/hero.webp'],
      },
    }),
    performanceFinding({
      findingId: 'sha256:perf-resource',
      route: '/',
      affectedResources: ['https://example.test/other.webp'],
      evidence: {
        message: 'LCP element is slow.',
        device: 'mobile',
        affectedResources: ['https://example.test/other.webp'],
      },
    }),
  ]);
  assert.equal(units.length, 3);
});
