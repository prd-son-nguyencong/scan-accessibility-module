import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patchScanResultsSources,
  writeHybridAttestationProject,
  writeVerifiedFixtureSources,
} from './helpers/hybrid-fixture.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import {
  collectVerificationBaseline,
  startFixController,
} from '../../src/fix/controller/index.js';
import { FixControllerError, SESSION_STATES } from '../../src/fix/controller/session.js';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVISION = 'git:abc123def4567890123456789012345678901234';
const DEPLOYMENT_URL = 'https://example.test';

function withBuildRevision(revision, fn) {
  const previous = process.env.ADA_SCAN_BUILD_REVISION;
  process.env.ADA_SCAN_BUILD_REVISION = revision;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ADA_SCAN_BUILD_REVISION;
    else process.env.ADA_SCAN_BUILD_REVISION = previous;
  }
}

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8')
);

function writeTempProject(root, {
  revision = REVISION,
  manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' },
} = {}) {
  return writeHybridAttestationProject(root, { revision, manifest });
}

function patchFixtureScanResults(root) {
  const sourceMap = writeVerifiedFixtureSources(root);
  return patchScanResultsSources(baseFixture.scanResults, sourceMap);
}

function buildFixtureReport(target) {
  const sourceMap = {
    'src/partials/jobs/sort.liquid': { line: 12, preimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    'src/pages/index.liquid': { line: 30, preimageSha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
  };
  return buildScanReportV2(patchScanResultsSources(baseFixture.scanResults, sourceMap), {
    ...baseFixture.context,
    target,
  });
}

function localReport(digest = DIGEST, overrides = {}) {
  return buildFixtureReport({
    mode: 'local-only',
    url: 'http://localhost:1234/',
    buildRevision: REVISION,
    instrumentationDigest: digest,
    deploymentUrl: null,
    attestationStatus: null,
    attestationReason: null,
    ...overrides.target,
  });
}

function hybridReport(digest = DIGEST) {
  return buildFixtureReport({
    mode: 'hybrid',
    url: `${DEPLOYMENT_URL}/`,
    buildRevision: REVISION,
    instrumentationDigest: digest,
    deploymentUrl: DEPLOYMENT_URL,
    attestationStatus: 'complete',
    attestationReason: null,
  });
}

function manualOnlyReport(digest = DIGEST) {
  const scanResults = structuredClone(baseFixture.scanResults);
  scanResults[0].violations = scanResults[0].violations.map((violation) => ({
    ...violation,
    ruleId: 'color-contrast',
    nativeRuleId: 'color-contrast',
    canonicalRuleId: 'color-contrast',
    layer: 'axe',
  }));
  return buildScanReportV2(scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://localhost:1234/',
      buildRevision: REVISION,
      instrumentationDigest: digest,
    },
  });
}

test('hybrid report with remote attestation but no local attestation is scan-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const report = hybridReport();
    const result = startFixController({
      report,
      localRoot: root,
      localRevision: REVISION,
      localInstrumentationDigest: DIGEST,
    });
    assert.equal(result.status, 'scan-only');
    assert.equal(result.capability.canFix, false);
    assert.equal(result.capability.reason, 'LOCAL_ATTESTATION_MISSING');
    assert.equal(result.session, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan-only short circuit does not create a session', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const result = startFixController({
      report: hybridReport(),
      localRoot: root,
    });
    assert.equal(result.status, 'scan-only');
    assert.equal(result.session, null);
    assert.equal(result.traceInbox, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful startup returns REVIEW_UI_PENDING with trace inbox and bulk trace results', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(digest);
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'REVIEW_UI_PENDING');
    assert.ok(result.traceInbox);
    assert.ok(Array.isArray(result.traceResults));
    assert.equal(result.traceResults.length, report.pages[0].findings.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller uses an explicit session id for resumable review state', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const result = startFixController({
      report: localReport(digest),
      localRoot: root,
      sessionId: 'resume-review-1',
    });
    assert.equal(result.session.sessionId, 'resume-review-1');
    assert.equal(result.sessionDir, realpathSync(join(root, 'scan-reports', 'fix-sessions', 'resume-review-1')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller rejects unsafe explicit session ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    assert.throws(
      () => startFixController({
        report: localReport(digest),
        localRoot: root,
        sessionId: '../escape',
      }),
      (error) => error instanceof FixControllerError && error.code === 'INVALID_SESSION_ID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller-started audit event is recorded on startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(digest);
    const result = startFixController({ report, localRoot: root });
    const started = result.session.auditLog.find((event) => event.type === 'controller_started');
    assert.ok(started);
    assert.equal(started.reportId, report.reportId);
    assert.equal(started.fixUnitCount, result.fixUnits.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ready units start in READY_FOR_POLICY', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const sourceMap = writeVerifiedFixtureSources(root);
    const scanResults = patchScanResultsSources(structuredClone(baseFixture.scanResults), sourceMap);
    scanResults[0].violations = scanResults[0].violations.map((violation) => ({
      ...violation,
      fix: { ...violation.fix, deterministic: true },
    }));
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
        deploymentUrl: null,
        attestationStatus: null,
        attestationReason: null,
      },
    });
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.session.state, SESSION_STATES.READY_FOR_POLICY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all-blocked policies start in MANUAL_ONLY', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const sourceMap = writeVerifiedFixtureSources(root);
    const scanResults = patchScanResultsSources(structuredClone(baseFixture.scanResults), sourceMap);
    scanResults[0].violations = scanResults[0].violations.map((violation) => ({
      ...violation,
      ruleId: 'color-contrast',
      nativeRuleId: 'color-contrast',
      canonicalRuleId: 'color-contrast',
      layer: 'axe',
    }));
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
        deploymentUrl: null,
        attestationStatus: null,
        attestationReason: null,
      },
    });
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.session.state, SESSION_STATES.MANUAL_ONLY);
    assert.equal(result.proposable.length, 0);
    assert.ok(result.blocked.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unresolved source units start in TRACE_REQUIRED', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const scanResults = structuredClone(baseFixture.scanResults);
    scanResults[0].violations = [{
      ...scanResults[0].violations[0],
      source: {
        mode: 'url',
        file: null,
        line: null,
        confidence: 'none',
        method: 'unresolved',
        preimageSha256: null,
      },
    }];
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
      },
    });
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.session.state, SESSION_STATES.TRACE_REQUIRED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty report returns structured no-findings without creating session directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const scanResults = structuredClone(baseFixture.scanResults);
    scanResults[0].violations = [];
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
      },
    });
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.status, 'no-findings');
    assert.equal(result.reason, 'NO_FINDINGS');
    assert.equal(result.session, null);
    assert.equal(result.traceInbox, null);
    assert.equal(result.fixUnits.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caller-supplied sessionDir override is ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-'));
  try {
    const { digest } = writeTempProject(root);
    const scanResults = structuredClone(baseFixture.scanResults);
    scanResults[0].violations = scanResults[0].violations.map((violation) => ({
      ...violation,
      fix: { ...violation.fix, deterministic: true },
    }));
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
      },
    });
    const escapeDir = mkdtempSync(join(tmpdir(), 'ada-controller-escape-'));
    try {
      const result = startFixController({
        report,
        localRoot: root,
        sessionDir: escapeDir,
      });
      assert.equal(result.status, 'pending');
      const trustedRoot = realpathSync(root);
      assert.ok(result.traceInbox.sessionDir.startsWith(trustedRoot));
      assert.ok(result.traceInbox.sessionDir.includes('scan-reports/fix-sessions/'));
      assert.notEqual(result.traceInbox.sessionDir, escapeDir);
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification baseline includes every fix-unit finding with selector and count evidence', () => {
  const baseline = collectVerificationBaseline([
    {
      findings: [{
        findingId: 'sha256:first',
        canonicalRuleId: 'button-name',
        impact: 'critical',
        count: 1,
        element: { selector: '.hamburger' },
      }],
    },
    {
      findings: [{
        findingId: 'sha256:second',
        canonicalRuleId: 'ButtonMismatch',
        impact: 'serious',
        count: 2,
        element: { selector: 'main>section>a' },
      }],
    },
  ]);

  assert.deepEqual(
    baseline.map((finding) => ({
      findingId: finding.findingId,
      count: finding.count,
      selector: finding.element?.selector,
    })),
    [
      { findingId: 'sha256:first', count: 1, selector: '.hamburger' },
      { findingId: 'sha256:second', count: 2, selector: 'main>section>a' },
    ],
  );
});
