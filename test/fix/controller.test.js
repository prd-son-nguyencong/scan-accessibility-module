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
  runTrustedFixCli,
  startFixController,
} from '../../src/fix/controller/index.js';
import { hashFileContent } from '../../src/fix/candidate/intent.js';
import { FixControllerError, SESSION_STATES } from '../../src/fix/controller/session.js';
import { compareVerificationFindings } from '../../src/fix/verify/verification-key.js';
import { insecureDevEnv, trustedCisTestEnv } from './helpers/cis-ca-fixture.js';

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

function withCisEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test('runTrustedFixCli exposes insecure-dev cisConfig and review snapshot labels without secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-cis-insecure-'));
  let reviewServer = null;
  await withCisEnv(insecureDevEnv(), async () => {
    try {
      const { digest } = writeTempProject(root);
      const report = localReport(digest);
      const result = await runTrustedFixCli({
        report,
        localRoot: root,
        useUI: true,
        cisTransport: {
          transportSecurity: 'insecure-dev',
          async chatCompletion() {
            return { content: '{}', status: 200, elapsedMs: 0 };
          },
          async close() {},
        },
      });
      reviewServer = result.reviewServer;

      assert.equal(result.cisConfig.ok, true);
      assert.equal(result.cisConfig.transportSecurity, 'insecure-dev');
      const snapshot = result.reviewState.getSnapshot();
      assert.equal(snapshot.transportSecurity, 'insecure-dev');
      assert.equal(snapshot.devAuthBypass, true);

      result.reviewState.setPreferences({ search: 'probe' });
      const sessionJson = readFileSync(join(result.sessionDir, 'session.json'), 'utf8');
      assert.equal(sessionJson.includes('CIS_PROXY_URL'), false);
      assert.equal(sessionJson.includes('CIS_AUTH_TOKEN'), false);
      assert.equal(sessionJson.includes('ALLOW_UNVERIFIED_CIS_TLS'), false);
      assert.equal(sessionJson.includes('transportSecurity'), false);
    } finally {
      if (reviewServer) await reviewServer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('runTrustedFixCli trusted defaults keep transportSecurity trusted in snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-cis-trusted-'));
  let reviewServer = null;
  await withCisEnv(trustedCisTestEnv(), async () => {
    try {
      const { digest } = writeTempProject(root);
      const report = localReport(digest);
      const result = await runTrustedFixCli({
        report,
        localRoot: root,
        useUI: true,
        cisTransport: {
          transportSecurity: 'trusted',
          async chatCompletion() {
            return { content: '{}', status: 200, elapsedMs: 0 };
          },
          async close() {},
        },
      });
      reviewServer = result.reviewServer;

      assert.equal(result.cisConfig.ok, true);
      assert.equal(result.cisConfig.transportSecurity, 'trusted');
      const snapshot = result.reviewState.getSnapshot();
      assert.equal(snapshot.transportSecurity, 'trusted');
      assert.equal(snapshot.devAuthBypass, false);
    } finally {
      if (reviewServer) await reviewServer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('runTrustedFixCli disabled CIS config yields disabled snapshot labels', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-cis-disabled-'));
  let reviewServer = null;
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(digest);
    const result = await runTrustedFixCli({
      report,
      localRoot: root,
      useUI: true,
    });
    reviewServer = result.reviewServer;

    assert.equal(result.cisConfig.ok, false);
    const snapshot = result.reviewState.getSnapshot();
    assert.equal(snapshot.transportSecurity, 'disabled');
    assert.equal(snapshot.devAuthBypass, false);
  } finally {
    if (reviewServer) await reviewServer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session metadata derives from sessionRoot while trace uses sandbox localRoot', () => {
  const originalRoot = mkdtempSync(join(tmpdir(), 'ada-controller-session-root-'));
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'ada-controller-sandbox-root-'));
  try {
    writeTempProject(originalRoot);
    const { digest } = writeTempProject(sandboxRoot);
    const report = localReport(digest);
    const result = startFixController({
      report,
      localRoot: sandboxRoot,
      sessionRoot: originalRoot,
      sessionId: 'demo-session-root',
    });
    assert.equal(result.status, 'pending');
    assert.ok(result.sessionDir.startsWith(realpathSync(originalRoot)));
    assert.equal(realpathSync(result.traceInbox.localRoot), realpathSync(sandboxRoot));
  } finally {
    rmSync(originalRoot, { recursive: true, force: true });
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('targetSourceFile retains only exact normalized source matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-target-file-'));
  try {
    const { digest } = writeTempProject(root);
    const sourceMap = writeVerifiedFixtureSources(root);
    const scanResults = patchScanResultsSources(structuredClone(baseFixture.scanResults), sourceMap);
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
      },
    });
    const all = startFixController({ report, localRoot: root });
    const filtered = startFixController({
      report,
      localRoot: root,
      targetSourceFile: 'src/partials/jobs/sort.liquid',
    });
    assert.ok(all.fixUnits.length > filtered.fixUnits.length);
    assert.ok(filtered.fixUnits.every((unit) => unit.sourceOwner?.file === 'src/partials/jobs/sort.liquid'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('target-file verification receives an immutable full-report cross-layer baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-full-baseline-'));
  let reviewServer = null;
  try {
    const { digest } = writeTempProject(root);
    const sourceMap = writeVerifiedFixtureSources(root);
    const scanResults = patchScanResultsSources(structuredClone(baseFixture.scanResults), sourceMap);
    const targetFile = 'src/partials/jobs/sort.liquid';
    const unrelatedFile = 'src/pages/index.liquid';
    const targetViolation = {
      ...structuredClone(scanResults[0].violations[0]),
      id: 'accessscan-link-new-window',
      ruleId: 'LinkOpensNewWindow',
      canonicalRuleId: 'LinkOpensNewWindow',
      layer: 'accessScan',
      impact: 'serious',
      element: {
        outerHTML: '<a id="target-link" target="_blank">Jobs</a>',
        selector: '#target-link',
      },
      fix: {
        deterministic: false,
        hint: 'Link opens a new window without warning.',
        patch: null,
      },
    };
    const unrelatedViolation = {
      ...structuredClone(scanResults[0].violations[2]),
      id: 'axe-button-name',
      ruleId: 'button-name',
      canonicalRuleId: 'button-name',
      layer: 'axe',
      impact: 'critical',
      count: 1,
      element: {
        outerHTML: '<button id="unrelated-button"></button>',
        selector: '#unrelated-button',
      },
      fix: {
        deterministic: false,
        hint: 'Button must have discernible text.',
        patch: null,
      },
    };
    scanResults[0].violations = [targetViolation, unrelatedViolation];
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: {
        mode: 'local-only',
        url: 'http://localhost:1234/',
        buildRevision: REVISION,
        instrumentationDigest: digest,
      },
    });
    const expectedBaseline = structuredClone(
      report.pages.flatMap((page) => page.findings),
    );
    assert.equal(expectedBaseline.length, 2);
    assert.deepEqual(
      expectedBaseline.reduce((counts, finding) => ({
        ...counts,
        [finding.layer]: (counts[finding.layer] || 0) + 1,
      }), {}),
      { accessScan: 1, axe: 1 },
    );
    const targetFinding = expectedBaseline.find((finding) => finding.source.file === targetFile);
    const unrelatedFinding = expectedBaseline.find((finding) => finding.source.file === unrelatedFile);
    assert.ok(targetFinding);
    assert.ok(unrelatedFinding);
    const buildScript = join(root, 'build-ok.js');
    writeFileSync(buildScript, 'process.exit(0);\n');

    let receivedBaseline = null;
    const scanner = async () => ({
      findings: [structuredClone(unrelatedFinding)],
      sourceTraceResolved: true,
      sourceTraceByTarget: [],
      executedLayers: ['axe', 'accessScan'],
      compareFindings(baselineFindings, afterFindings, targetFindingIds) {
        receivedBaseline = baselineFindings;
        return compareVerificationFindings(
          baselineFindings,
          afterFindings,
          targetFindingIds,
        );
      },
    });
    scanner.ownsSiteLifecycle = true;

    const result = await runTrustedFixCli({
      report,
      localRoot: root,
      targetSourceFile: targetFile,
      useUI: true,
      verification: {
        build: {
          command: process.execPath,
          args: [buildScript],
        },
        scanner,
      },
      cisTransport: {
        async chatCompletion() {
          throw new Error('CIS transport must not be called by this test.');
        },
        async close() {},
      },
    });
    reviewServer = result.reviewServer;

    assert.deepEqual(
      report.pages.flatMap((page) => page.findings),
      expectedBaseline,
    );
    assert.equal(result.fixUnits.length, 1);
    assert.ok(result.fixUnits.every((unit) => unit.sourceOwner.file === targetFile));
    assert.equal(result.reviewState.fixUnits.length, 1);
    assert.ok(result.reviewState.fixUnits.every((unit) => unit.sourceOwner.file === targetFile));
    const reviewSnapshot = result.reviewState.getSnapshot();
    assert.equal(reviewSnapshot.units.length, 1);
    assert.equal(reviewSnapshot.units[0].sourceFile, targetFile);
    assert.equal(
      reviewSnapshot.units.some((unit) => unit.sourceFile === unrelatedFile),
      false,
    );

    const targetContent = readFileSync(join(root, targetFile), 'utf8');
    const registered = result.reviewState.registerCandidate(result.fixUnits[0].fixUnitId, {
      policyVersion: '1',
      promptVersion: 'controller-baseline-test',
      modelId: 'deterministic-stub',
      editIntents: [{
        file: targetFile,
        blockRange: { startLine: 12, endLine: 12 },
        expectedBlockSha256: sourceMap[targetFile].preimageSha256,
        expectedFileSha256: hashFileContent(targetContent),
        oldText: '<select id="sort-select"></select>',
        newText: '<select id="sort-select" aria-label="Sort jobs"></select>',
      }],
      manualChecks: [],
    });
    assert.ok(registered.candidateHash);

    report.pages[0].findings[0].layer = 'mutated-report-layer';
    report.pages[0].findings[0].source.file = 'src/pages/mutated.liquid';
    result.fixUnits[0].findings[0].layer = 'mutated-fix-unit-layer';

    const verified = await result.verifyRegisteredCandidate(result.fixUnits[0].fixUnitId);

    assert.deepEqual(receivedBaseline, expectedBaseline);
    assert.equal(Object.isFrozen(receivedBaseline), true);
    assert.ok(receivedBaseline.every((finding) => Object.isFrozen(finding)));
    assert.ok(receivedBaseline.every((finding) => Object.isFrozen(finding.source)));
    assert.throws(
      () => receivedBaseline.push(structuredClone(unrelatedFinding)),
      TypeError,
    );
    assert.throws(
      () => {
        receivedBaseline[0].source.file = 'src/pages/injected.liquid';
      },
      TypeError,
    );
    assert.equal(verified.ok, true);
  } finally {
    if (reviewServer) await reviewServer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('targetSourceFile with no matching findings returns NO_TARGET_FINDINGS', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-no-target-'));
  try {
    const { digest } = writeTempProject(root);
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'src', 'pages', 'other.liquid'), '<div>Other</div>\n');
    const report = localReport(digest);
    const result = startFixController({
      report,
      localRoot: root,
      targetSourceFile: 'src/pages/other.liquid',
    });
    assert.equal(result.status, 'no-findings');
    assert.equal(result.reason, 'NO_TARGET_FINDINGS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('targetSourceFile rejects traversal paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-target-traversal-'));
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(digest);
    assert.throws(
      () => startFixController({
        report,
        localRoot: root,
        targetSourceFile: '../escape.liquid',
      }),
      (error) => error instanceof FixControllerError && error.code === 'PATH_TRAVERSAL',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default controller behavior unchanged without sessionRoot or targetSourceFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-controller-defaults-'));
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(digest);
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.status, 'pending');
    assert.ok(result.sessionDir.startsWith(realpathSync(root)));
    assert.equal(realpathSync(result.traceInbox.localRoot), realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
