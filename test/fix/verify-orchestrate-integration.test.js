import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInstrumentationDigest } from '../../src/tracer/build-instrumented.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { hashFileContent } from '../../src/fix/candidate/intent.js';
import {
  runTrustedFixCli,
  verifyAndRegisterCandidate,
} from '../../src/fix/controller/index.js';
import {
  createLoopbackSiteAdapter,
  createPassingScanner,
} from './helpers/shadow-adapters.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/fix/projects/minimal-liquid-site', import.meta.url));
const EXIT_SCRIPT = fileURLToPath(new URL('../fixtures/fix/scripts/exit-code.js', import.meta.url));
const REVISION = 'git:abc123';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

function writeAttestation(root) {
  writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'dist' }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  const manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' };
  writeFileSync(join(root, 'dist', 'scan-manifest.json'), JSON.stringify(manifest));
  const digest = computeInstrumentationDigest(manifest);
  writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({
    buildRevision: REVISION,
    instrumentationDigest: digest,
  }));
  return digest;
}

function buildButtonReport(root, digest) {
  const rel = 'src/pages/index.liquid';
  const content = readFileSync(join(root, rel), 'utf8');
  const preimage = buildSourcePreimage(content, 3);
  const scanResults = structuredClone(baseFixture.scanResults);
  scanResults[0].url = 'http://127.0.0.1:8765/';
  scanResults[0].violations = [{
    id: 'runtime-axe',
    ruleId: 'button-name',
    layer: 'axe',
    category: 'accessibility',
    wcagRef: 'wcag2a',
    impact: 'critical',
    priority: 1,
    count: 1,
    foundAt: '2026-07-15T00:01:00.000Z',
    element: { outerHTML: '<button id="apply">Apply</button>', selector: '#apply' },
    source: {
      mode: 'url',
      file: rel,
      line: 3,
      snippet: 'apply',
      url: 'http://127.0.0.1:8765/',
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: preimage.preimageSha256,
    },
    fix: { deterministic: true, hint: 'Button needs accessible name.', patch: null },
    evidence: { tags: ['wcag2a'], viewports: [{ name: 'mobile', width: 390, height: 844 }] },
  }];
  return buildScanReportV2(scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://127.0.0.1:8765/',
      buildRevision: REVISION,
      instrumentationDigest: digest,
    },
  });
}

function trustedVerificationOptions(root) {
  return {
    build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
    site: createLoopbackSiteAdapter('http://127.0.0.1:8765'),
    scanner: createPassingScanner(),
  };
}

function editIntentsFor(root) {
  const rel = 'src/pages/index.liquid';
  const content = readFileSync(join(root, rel), 'utf8');
  const preimage = buildSourcePreimage(content, 3);
  return [{
    file: rel,
    blockRange: { startLine: 3, endLine: 3 },
    expectedBlockSha256: preimage.preimageSha256,
    expectedFileSha256: hashFileContent(content),
    oldText: '<button id="apply">Apply</button>',
    newText: '<button id="apply" aria-label="Apply">Apply</button>',
  }];
}

test('verifyAndRegisterCandidate is exported from trusted controller API', () => {
  assert.equal(typeof verifyAndRegisterCandidate, 'function');
});

test('runTrustedFixCli reportPath-only useUI binds verifyCandidate from trusted Node options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-verify-cli-'));
  let reviewServer = null;
  try {
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const digest = writeAttestation(root);
    const report = buildButtonReport(root, digest);
    const reportPath = join(root, 'scan-reports', 'verify-report.json');
    mkdirSync(join(root, 'scan-reports'), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

    const result = await runTrustedFixCli({
      reportPath,
      localRoot: root,
      useUI: true,
      verification: trustedVerificationOptions(root),
    });
    reviewServer = result.reviewServer;

    assert.equal(result.status, 'review');
    assert.equal(result.reviewState.reportId, report.reportId);
    assert.equal(typeof result.verifyCandidate, 'function');
    assert.equal(result.proposable.length, 1);

    const unitId = result.fixUnits[0].fixUnitId;
    const verified = await result.verifyCandidate(unitId, {
      edits: editIntentsFor(root),
      policyVersion: '1',
      targetFindingIds: result.fixUnits[0].findingIds,
      baselineFindings: result.fixUnits[0].findingIds.map((id) => ({ findingId: id, impact: 'critical' })),
      replace: true,
    });
    assert.equal(verified.ok, true);

    result.reviewState.accept(unitId, verified.candidate.candidateHash);
    result.reviewState.approveExactDiff(unitId, verified.candidate.candidateHash, verified.candidate.diffHash);
    assert.equal(result.reviewState.getSnapshot().applyGate.blocked, false);
  } finally {
    if (reviewServer) await reviewServer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyCandidate uses CLI-bound trusted config and ignores caller adapter overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-verify-trusted-'));
  let reviewServer = null;
  try {
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const digest = writeAttestation(root);
    const report = buildButtonReport(root, digest);
    let trustedScannerCalls = 0;
    const trustedScanner = async () => {
      trustedScannerCalls += 1;
      return { findings: [], sourceTraceResolved: true, executedLayers: ['axe', 'accessScan'] };
    };

    const result = await runTrustedFixCli({
      report,
      localRoot: root,
      useUI: true,
      verification: {
        ...trustedVerificationOptions(root),
        scanner: trustedScanner,
      },
    });
    reviewServer = result.reviewServer;

    await result.verifyCandidate(result.fixUnits[0].fixUnitId, {
      edits: editIntentsFor(root),
      policyVersion: '1',
      scanner: async () => ({ findings: [{ findingId: 'evil', impact: 'critical' }], sourceTraceResolved: true, executedLayers: ['axe', 'accessScan'] }),
      build: { command: process.execPath, args: [EXIT_SCRIPT, '99'] },
      replace: true,
    });

    assert.equal(trustedScannerCalls, 1);
  } finally {
    if (reviewServer) await reviewServer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
