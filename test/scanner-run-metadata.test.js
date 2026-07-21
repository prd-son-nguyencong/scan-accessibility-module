import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as scanner from '../src/index.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';

test('buildAxeScannerRuns preserves engine, viewport, state, and raw counts', () => {
  assert.equal(typeof scanner.buildAxeScannerRuns, 'function');
  const runs = scanner.buildAxeScannerRuns({
    testEngine: { name: 'axe-core', version: '4.12.1' },
    tags: ['wcag2a', 'wcag2aa'],
    summary: {
      viewports: [{
        name: 'mobile',
        width: 390,
        height: 844,
        issueGroups: 7,
        affectedNodes: 7,
        incomplete: 3,
      }],
    },
  });

  assert.deepEqual(runs, [{
    layer: 'axe',
    engine: { name: 'axe-core', version: '4.12.1' },
    viewport: { name: 'mobile', width: 390, height: 844 },
    pageState: 'initial',
    status: 'complete',
    evidence: {
      issueGroups: 7,
      affectedNodes: 7,
      incomplete: 3,
      tags: ['wcag2a', 'wcag2aa'],
    },
  }]);
});

test('buildAccessScanRun records internal engine version and occurrence counts', () => {
  assert.equal(typeof scanner.buildAccessScanRun, 'function');
  const run = scanner.buildAccessScanRun([
    { ruleId: 'StrongMismatch', count: 3 },
    { ruleId: 'RegionMainContentSingle', count: 1 },
  ], {
    includeThirdParty: true,
    engineVersion: '1.0.1',
  });

  assert.deepEqual(run, {
    layer: 'accessScan',
    engine: { name: 'ada-scan accessScan', version: '1.0.1' },
    viewport: { name: 'desktop', width: 1280, height: 900 },
    pageState: 'initial',
    status: 'complete',
    evidence: {
      ruleGroups: 2,
      findingOccurrences: 4,
      fixUnits: 2,
      includeThirdParty: true,
      profile: 'commercial-parity',
      comparatorVersion: '1.0.0',
    },
  });
});

test('buildLighthouseScannerRuns keeps device engine and PSI provenance separate', () => {
  assert.equal(typeof scanner.buildLighthouseScannerRuns, 'function');
  const provenance = {
    requestedSource: 'psi-api',
    actualSource: 'local',
    comparableToPsi: false,
    fallbackReason: { code: 'quota-exceeded', status: 429 },
  };
  const runs = scanner.buildLighthouseScannerRuns({
    source: 'local-fallback',
    provenance,
    lighthouse: {
      mobile: {
        device: 'mobile',
        engineVersion: '13.1.0',
        viewport: { width: 412, height: 823 },
        scores: { performance: 60 },
        fetchTime: '2026-07-15T00:00:00.000Z',
        accessibility: {
          summary: {
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
    },
  });

  assert.deepEqual(runs, [{
    layer: 'lighthouse',
    engine: { name: 'Lighthouse', version: '13.1.0' },
    viewport: { name: 'mobile', width: 412, height: 823 },
    pageState: 'initial',
    status: 'fallback',
    source: 'local-fallback',
    provenance,
    evidence: {
      scores: { performance: 60 },
      fetchTime: '2026-07-15T00:00:00.000Z',
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
  }]);
});

test('buildInternalScannerRun records versioned totals and sanitized failures', () => {
  assert.equal(typeof scanner.buildInternalScannerRun, 'function');
  assert.deepEqual(
    scanner.buildInternalScannerRun('links', [
      { ruleId: 'dead-link', count: 2 },
    ], {
      engineVersion: '1.0.1',
      status: 'complete',
    }),
    {
      layer: 'links',
      engine: { name: 'ada-scan links', version: '1.0.1' },
      viewport: { name: 'desktop', width: 1280, height: 900 },
      pageState: 'initial',
      status: 'complete',
      evidence: {
        ruleGroups: 1,
        findingOccurrences: 2,
        fixUnits: 1,
        errorCode: null,
      },
    },
  );
  assert.equal(
    scanner.buildInternalScannerRun('keyboard', [], {
      engineVersion: '1.0.1',
      status: 'error',
      errorCode: 'scan-failed',
    }).evidence.errorCode,
    'scan-failed',
  );
});

test('missing third-party engine versions remain valid explicit unknowns', () => {
  const axeRun = scanner.buildAxeScannerRuns({
    summary: {
      viewports: [{
        name: 'desktop',
        width: 1280,
        height: 900,
      }],
    },
  })[0];
  const lighthouseRun = scanner.buildLighthouseScannerRuns({
    source: 'local-fallback',
  })[0];

  assert.equal(axeRun.engine.version, 'unknown');
  assert.equal(lighthouseRun.engine.version, 'unknown');
  assert.doesNotThrow(() => buildScanReportV2([{
    page: 'homepage',
    url: 'https://example.test/',
    violations: [],
    scannerRuns: [axeRun, lighthouseRun],
  }], {
    producer: { version: '1.0.1' },
    target: { mode: 'url-only', url: 'https://example.test/' },
  }));
});
