import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTESTATION_META,
  aggregatePageAttestations,
  deriveRemoteScanTarget,
  extractPageAttestationFromPage,
  validateAttestationForInjection,
} from '../../src/tracer/page-attestation.js';
import { sanitizeAttestationReason } from '../../src/tracer/attestation-reasons.js';
import { canonicalizeDeploymentUrl } from '../../src/tracer/deployment-url.js';
import {
  applyRemoteHintAttribution,
  searchLiquidHintMatches,
} from '../../src/tracer/remote-hint-trace.js';
import { deriveScanTargetAndTrace } from '../../src/tracer/scan-target.js';
import { loadTrustedLocalAttestation } from '../../src/fix/controller/local-attestation.js';
import { resolveFixCapability } from '../../src/fix/controller/mode-gate.js';
import { buildScanReportV2, validateScanReportV2 } from '../../src/reporter/report-v2.js';
import {
  createSourceTraceInbox,
  traceAllFindings,
} from '../../src/fix/trace/inbox.js';
import {
  loadHostScanConfig,
  resolveSafeOutDir,
  scanInstrumentationPlugin,
} from '../../vite/scan-instrumentation.js';
import {
  DEPLOYMENT_URL,
  DIGEST,
  REVISION,
  writeHybridAttestationProject,
  writeVerifiedFixtureSources,
} from './helpers/hybrid-fixture.js';

function attestationTriple() {
  return {
    [ATTESTATION_META.BUILD_REVISION]: [REVISION],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [DIGEST],
    [ATTESTATION_META.DEPLOYMENT_URL]: [DEPLOYMENT_URL],
  };
}

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

test('canonicalizeDeploymentUrl rejects query and hash instead of stripping them', () => {
  assert.equal(canonicalizeDeploymentUrl('https://example.test/careers/?utm=1'), null);
  assert.equal(canonicalizeDeploymentUrl('https://example.test/careers#hash'), null);
  assert.equal(canonicalizeDeploymentUrl('https://Example.test/careers'), 'https://example.test/careers');
});

test('sanitizeAttestationReason maps unknown values to REMOTE_ATTESTATION_INVALID', () => {
  assert.equal(sanitizeAttestationReason('DEPLOYMENT_URL_MISMATCH'), 'DEPLOYMENT_URL_MISMATCH');
  assert.equal(sanitizeAttestationReason('totally-unknown'), 'REMOTE_ATTESTATION_INVALID');
});

test('deriveRemoteScanTarget uses precise reasons for malformed and scope failures', () => {
  const complete = deriveRemoteScanTarget({
    scannedUrl: `${DEPLOYMENT_URL}/jobs`,
    sourceRoot: '/repo',
    pageEntries: [{
      attestationResult: {
        ok: true,
        attestation: { buildRevision: REVISION, instrumentationDigest: DIGEST, deploymentUrl: DEPLOYMENT_URL },
      },
      pageUrl: `${DEPLOYMENT_URL}/jobs`,
    }],
  });
  assert.equal(complete.mode, 'hybrid');
  assert.equal(complete.attestationReason, null);

  const duplicate = deriveRemoteScanTarget({
    scannedUrl: `${DEPLOYMENT_URL}/`,
    sourceRoot: '/repo',
    pageEntries: [{
      attestationResult: {
        ok: false,
        reason: 'DUPLICATE_META',
      },
      pageUrl: `${DEPLOYMENT_URL}/`,
    }],
  });
  assert.equal(duplicate.attestationReason, 'DUPLICATE_META');

  const pageFailure = deriveRemoteScanTarget({
    scannedUrl: `${DEPLOYMENT_URL}/`,
    sourceRoot: '/repo',
    pageEntries: [{
      attestationResult: { ok: false, reason: 'PAGE_ATTESTATION_UNAVAILABLE' },
      pageUrl: `${DEPLOYMENT_URL}/`,
      scanFailed: true,
    }],
  });
  assert.equal(pageFailure.attestationReason, 'PAGE_ATTESTATION_UNAVAILABLE');
  assert.equal(pageFailure.attestationStatus, 'unavailable');
});

test('aggregatePageAttestations scope-checks every page URL against deployment URL', () => {
  const attestation = {
    buildRevision: REVISION,
    instrumentationDigest: DIGEST,
    deploymentUrl: `${DEPLOYMENT_URL}/careers`,
  };
  const ok = aggregatePageAttestations([
    {
      attestationResult: { ok: true, attestation },
      pageUrl: `${DEPLOYMENT_URL}/careers`,
    },
    {
      attestationResult: { ok: true, attestation },
      pageUrl: `${DEPLOYMENT_URL}/careers/jobs`,
    },
  ]);
  assert.equal(ok.ok, true);

  const mismatch = aggregatePageAttestations([
    {
      attestationResult: { ok: true, attestation },
      pageUrl: `${DEPLOYMENT_URL}/careers/jobs`,
    },
    {
      attestationResult: { ok: true, attestation },
      pageUrl: 'https://other.test/jobs',
    },
  ]);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'DEPLOYMENT_URL_MISMATCH');
});

test('extractPageAttestationFromPage uses injected evaluate stub without live browser', async () => {
  const meta = attestationTriple();
  const result = await extractPageAttestationFromPage({}, {
    evaluate: async (_handler, metaNames) => {
      const payload = {};
      for (const name of metaNames) payload[name] = meta[name];
      return payload;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attestation.deploymentUrl, DEPLOYMENT_URL);
});

test('resolveFixCapability forwards attestationReason for incomplete remote attestation', () => {
  const result = resolveFixCapability({
    url: `${DEPLOYMENT_URL}/`,
    localRoot: '/repo',
    remoteRevision: REVISION,
    localRevision: REVISION,
    remoteInstrumentationDigest: DIGEST,
    localInstrumentationDigest: DIGEST,
    remoteDeploymentUrl: DEPLOYMENT_URL,
    localDeploymentUrl: DEPLOYMENT_URL,
    attestationStatus: 'malformed',
    attestationReason: 'DUPLICATE_META',
  });
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'DUPLICATE_META');
});

test('remote hint search assigns only a unique file+line match under resolved source root', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-hint-unique-'));
  try {
    const partialDir = join(root, 'src', 'partials', 'jobs');
    mkdirSync(partialDir, { recursive: true });
    writeFileSync(join(partialDir, 'sort.liquid'), '<select id="sort-select"></select>\n');

    const violation = {
      element: { outerHTML: '<select id="sort-select"></select>' },
      source: { mode: 'url', confidence: 'none', method: 'unresolved' },
    };
    const traced = applyRemoteHintAttribution(violation, root);
    assert.equal(traced.source.file, 'src/partials/jobs/sort.liquid');
    assert.equal(traced.source.method, 'hybrid-verified-unique-hint');
    assert.equal(traced.source.confidence, 'medium');
    assert.match(traced.source.preimageSha256, /^sha256:[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote hint search marks ambiguous matches as trace-required candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-hint-ambiguous-'));
  try {
    for (const rel of ['src/partials/a.liquid', 'src/pages/b.liquid']) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, '<button id="apply-now">Apply</button>\n');
    }

    const matches = searchLiquidHintMatches(root, 'apply-now');
    assert.equal(matches.length, 2);

    const violation = applyRemoteHintAttribution({
      element: { outerHTML: '<button id="apply-now">Apply</button>' },
      source: { mode: 'url', confidence: 'none', method: 'unresolved' },
    }, root);
    assert.equal(violation.source.file, null);
    assert.equal(violation.source.method, 'hybrid-ambiguous-hint');
    assert.equal(violation.sourceCandidates.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deriveScanTargetAndTrace attributes remote findings only after hybrid capability passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-scan-target-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'ada-scan-target-other-'));
  try {
    withBuildRevision(REVISION, () => {
      const { digest } = writeHybridAttestationProject(root);
      mkdirSync(join(otherRoot, 'src', 'partials', 'jobs'), { recursive: true });
      writeFileSync(join(otherRoot, 'src', 'partials', 'jobs', 'sort.liquid'), '<select id="sort-select"></select>\n');

      const unattested = deriveScanTargetAndTrace({
        isUrlMode: true,
        sourceRoot: root,
        pages: [{ url: `${DEPLOYMENT_URL}/` }],
        pageResults: [{
          name: 'homepage',
          url: `${DEPLOYMENT_URL}/`,
          violations: [{
            element: { outerHTML: '<select id="sort-select"></select>' },
            source: { mode: 'url', confidence: 'none', method: 'unresolved' },
          }],
          pageAttestation: { ok: false, reason: 'MISSING_BUILD_REVISION' },
        }],
        loadLocalAttestation: () => ({ ok: false, reason: 'LOCAL_ATTESTATION_MISSING' }),
      });
      assert.equal(unattested.targetFields.mode, 'url-only');
      assert.equal(unattested.pageResults[0].violations[0].source?.file, undefined);

      const attested = deriveScanTargetAndTrace({
        isUrlMode: true,
        sourceRoot: root,
        pages: [{ url: `${DEPLOYMENT_URL}/` }],
        pageResults: [{
          name: 'homepage',
          url: `${DEPLOYMENT_URL}/`,
          violations: [{
            element: { outerHTML: '<select id="sort-select"></select>' },
            source: { mode: 'url', confidence: 'none', method: 'unresolved' },
          }],
          pageAttestation: {
            ok: true,
            attestation: {
              buildRevision: REVISION,
              instrumentationDigest: digest,
              deploymentUrl: DEPLOYMENT_URL,
            },
          },
        }],
      });
      assert.equal(attested.targetFields.mode, 'hybrid');
      assert.equal(attested.capability.canFix, true);
      assert.equal(attested.pageResults[0].violations[0].source.file, 'src/partials/jobs/sort.liquid');

      const wrongRoot = deriveScanTargetAndTrace({
        isUrlMode: true,
        sourceRoot: otherRoot,
        pages: [{ url: `${DEPLOYMENT_URL}/` }],
        pageResults: [{
          name: 'homepage',
          url: `${DEPLOYMENT_URL}/`,
          violations: [{
            element: { outerHTML: '<select id="sort-select"></select>' },
            source: { mode: 'url', confidence: 'none', method: 'unresolved' },
          }],
          pageAttestation: {
            ok: true,
            attestation: {
              buildRevision: REVISION,
              instrumentationDigest: DIGEST,
              deploymentUrl: DEPLOYMENT_URL,
            },
          },
        }],
        loadLocalAttestation: () => ({ ok: false, reason: 'LOCAL_ATTESTATION_MISSING' }),
      });
      assert.notEqual(wrongRoot.capability?.canFix, true);
      assert.equal(wrongRoot.pageResults[0].violations[0].source?.file, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test('loadTrustedLocalAttestation rejects dirty revision and sidecar deployment URL drift', () => {
  withBuildRevision(`${REVISION}:dirty`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-local-dirty-'));
    try {
      writeHybridAttestationProject(root);
      const dirty = loadTrustedLocalAttestation(root);
      assert.equal(dirty.ok, false);
      assert.equal(dirty.reason, 'BUILD_REVISION_DIRTY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  withBuildRevision(REVISION, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-local-sidecar-'));
    try {
      const { digest } = writeHybridAttestationProject(root);
      writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({
        schemaVersion: '1.1.0',
        buildRevision: REVISION,
        instrumentationDigest: digest,
        deploymentUrl: 'https://other.test',
        entryCount: 1,
      }));
      const drift = loadTrustedLocalAttestation(root);
      assert.equal(drift.ok, false);
      assert.equal(drift.reason, 'ATTESTATION_SIDECAR_STALE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('plugin config loader rejects symlinked outDir escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-plugin-escape-'));
  const outside = mkdtempSync(join(tmpdir(), 'ada-plugin-out-'));
  try {
    writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'escape-out' }));
    symlinkSync(outside, join(root, 'escape-out'));
    assert.throws(() => resolveSafeOutDir(root, 'escape-out'), /PATH_TRAVERSAL/);
    assert.deepEqual(loadHostScanConfig(root), { outDir: 'escape-out' });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('validateAttestationForInjection rejects dirty revision and malformed digest', () => {
  assert.equal(
    validateAttestationForInjection({
      buildRevision: `${REVISION}:dirty`,
      instrumentationDigest: DIGEST,
      deploymentUrl: DEPLOYMENT_URL,
    }).reason,
    'BUILD_REVISION_DIRTY',
  );
  assert.equal(
    validateAttestationForInjection({
      buildRevision: REVISION,
      instrumentationDigest: 'not-a-digest',
      deploymentUrl: DEPLOYMENT_URL,
    }).reason,
    'MALFORMED_INSTRUMENTATION_DIGEST',
  );
});

test('manual mapping overrides two otherwise valid verified candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-manual-override-'));
  try {
    const sourceMap = writeVerifiedFixtureSources(root);
    const finding = {
      findingId: 'sha256:finding',
      route: '/',
      source: {
        file: 'src/partials/jobs/sort.liquid',
        line: 12,
        confidence: 'high',
        method: 'attested-source',
        preimageSha256: sourceMap['src/partials/jobs/sort.liquid'].preimageSha256,
      },
    };
    const inbox = createSourceTraceInbox({
      reportId: 'sha256:report',
      localRoot: root,
      candidates: [{
        findingId: finding.findingId,
        partials: [
          finding.source,
          {
            file: 'src/pages/index.liquid',
            line: 30,
            confidence: 'high',
            method: 'candidate',
            preimageSha256: sourceMap['src/pages/index.liquid'].preimageSha256,
          },
        ],
      }],
    });
    inbox.manualMappings.set(finding.findingId, {
      findingId: finding.findingId,
      file: 'src/pages/index.liquid',
      line: 30,
      expectedPreimageSha256: sourceMap['src/pages/index.liquid'].preimageSha256,
      computedPreimageSha256: sourceMap['src/pages/index.liquid'].preimageSha256,
    });
    const traced = traceAllFindings(inbox, [finding]);
    assert.equal(traced[0].verifiedSource.file, 'src/pages/index.liquid');
    assert.equal(traced[0].reason, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateScanReportV2 accepts hybrid target with complete attestation and known reason null', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: `${DEPLOYMENT_URL}/`,
    violations: [],
    scannerRuns: [{
      route: '/',
      layer: 'axe',
      engine: { name: 'axe-core', version: '4.0.0' },
      viewport: { name: 'desktop', width: 1280, height: 900 },
      pageState: 'initial',
      status: 'complete',
      evidence: {},
    }],
  }], {
    producer: { name: 'ada-scan', version: '1.0.1', nodeVersion: process.versions.node },
    target: {
      mode: 'hybrid',
      url: `${DEPLOYMENT_URL}/`,
      buildRevision: REVISION,
      instrumentationDigest: DIGEST,
      deploymentUrl: DEPLOYMENT_URL,
      attestationStatus: 'complete',
      attestationReason: null,
    },
  });
  assert.doesNotThrow(() => validateScanReportV2(report));
});

test('validateScanReportV2 sanitizes unknown attestation reason codes at build time', () => {
  const report = buildScanReportV2([{
    page: 'homepage',
    url: `${DEPLOYMENT_URL}/`,
    violations: [],
    scannerRuns: [{
      route: '/',
      layer: 'axe',
      engine: { name: 'axe-core', version: '4.0.0' },
      viewport: { name: 'desktop', width: 1280, height: 900 },
      pageState: 'initial',
      status: 'complete',
      evidence: {},
    }],
  }], {
    producer: { name: 'ada-scan', version: '1.0.1', nodeVersion: process.versions.node },
    target: {
      mode: 'url-only',
      url: `${DEPLOYMENT_URL}/`,
      attestationStatus: 'malformed',
      attestationReason: 'NOT_A_REAL_REASON',
    },
  });
  assert.equal(report.target.attestationReason, 'REMOTE_ATTESTATION_INVALID');
  assert.doesNotThrow(() => validateScanReportV2(report));
});
