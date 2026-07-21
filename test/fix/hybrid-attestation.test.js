import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fg from 'fast-glob';
import { scanInstrumentationPlugin, injectScanAttestation } from '../../vite/scan-instrumentation.js';
import {
  ATTESTATION_META,
  aggregatePageAttestations,
  deriveRemoteScanTarget,
  injectAttestationMetaTags,
  validatePageAttestationMetaContents,
} from '../../src/tracer/page-attestation.js';
import {
  canonicalizeDeploymentUrl,
  isUrlWithinDeploymentScope,
} from '../../src/tracer/deployment-url.js';
import { loadTrustedLocalAttestation } from '../../src/fix/controller/local-attestation.js';
import { resolveFixCapability } from '../../src/fix/controller/mode-gate.js';
import { startFixController } from '../../src/fix/controller/index.js';
import { buildScanReportV2, computeReportId } from '../../src/reporter/report-v2.js';
import {
  applyTraceResultsToFindings,
  createSourceTraceInbox,
  traceAllFindings,
} from '../../src/fix/trace/inbox.js';
import {
  attestationMetaHtml,
  DEPLOYMENT_URL,
  DIGEST,
  hybridTarget,
  patchScanResultsSources,
  REVISION,
  writeHybridAttestationProject,
  writeVerifiedFixtureSources,
} from './helpers/hybrid-fixture.js';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

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

function withDeploymentEnv(url, fn) {
  const previous = process.env.ADA_SCAN_DEPLOYMENT_URL;
  process.env.ADA_SCAN_DEPLOYMENT_URL = url;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ADA_SCAN_DEPLOYMENT_URL;
    else process.env.ADA_SCAN_DEPLOYMENT_URL = previous;
  }
}

function buildHybridReport(root, digest = DIGEST, targetOverrides = {}) {
  const sourceMap = writeVerifiedFixtureSources(root);
  const scanResults = patchScanResultsSources(baseFixture.scanResults, sourceMap);
  return buildScanReportV2(scanResults, {
    ...baseFixture.context,
    target: hybridTarget({
      instrumentationDigest: digest,
      ...targetOverrides,
    }),
  });
}

test('plugin sidecar and rendered HTML expose matching immutable attestation markers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-hybrid-plugin-'));
  const previousCwd = process.cwd();
  const previousScanMode = process.env.SCAN_MODE;
  const previousRevision = process.env.ADA_SCAN_BUILD_REVISION;
  try {
    mkdirSync(join(root, 'dist', 'pages'), { recursive: true });
    writeFileSync(join(root, 'dist', 'pages', 'index.html'), '<html><head></head><body></body></html>');
    writeFileSync(join(root, '.scan-config.json'), JSON.stringify({
      outDir: 'dist',
      deploymentUrl: DEPLOYMENT_URL,
      distMap: [{ dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' }],
    }));

    process.chdir(root);
    process.env.SCAN_MODE = 'true';
    process.env.ADA_SCAN_BUILD_REVISION = REVISION;

    const plugin = scanInstrumentationPlugin();
    await plugin.closeBundle.call({});

    const sidecar = JSON.parse(readFileSync(join(root, 'dist', 'scan-attestation.json'), 'utf8'));
    assert.equal(sidecar.schemaVersion, '1.1.0');
    assert.equal(sidecar.buildRevision, REVISION);
    assert.equal(sidecar.deploymentUrl, DEPLOYMENT_URL);
    assert.match(sidecar.instrumentationDigest, /^sha256:[a-f0-9]{64}$/);

    const html = readFileSync(join(root, 'dist', 'pages', 'index.html'), 'utf8');
    assert.match(html, new RegExp(`name="${ATTESTATION_META.BUILD_REVISION}"`));
    assert.match(html, new RegExp(`content="${REVISION}"`));
    assert.match(html, new RegExp(`name="${ATTESTATION_META.INSTRUMENTATION_DIGEST}"`));
    assert.match(html, new RegExp(`content="${sidecar.instrumentationDigest}"`));
    assert.match(html, new RegExp(`name="${ATTESTATION_META.DEPLOYMENT_URL}"`));
    assert.match(html, new RegExp(`content="${DEPLOYMENT_URL}"`));
  } finally {
    process.chdir(previousCwd);
    if (previousScanMode === undefined) delete process.env.SCAN_MODE;
    else process.env.SCAN_MODE = previousScanMode;
    if (previousRevision === undefined) delete process.env.ADA_SCAN_BUILD_REVISION;
    else process.env.ADA_SCAN_BUILD_REVISION = previousRevision;
    rmSync(root, { recursive: true, force: true });
  }
});

test('injectScanAttestation strips preexisting marker metas before inserting canonical markers', () => {
  const html = injectScanAttestation('<html><head><meta name="ada-scan-build-revision" content="stale"></head><body></body></html>', {
    buildRevision: REVISION,
    instrumentationDigest: DIGEST,
    deploymentUrl: DEPLOYMENT_URL,
  });
  assert.equal((html.match(/ada-scan-build-revision/g) || []).length, 1);
  assert.match(html, new RegExp(`content="${REVISION}"`));
  assert.match(html, new RegExp(`content="${DIGEST}"`));
  assert.match(html, new RegExp(`content="${DEPLOYMENT_URL}"`));
});

test('pure extraction accepts exactly one valid meta value per marker', () => {
  const result = validatePageAttestationMetaContents({
    [ATTESTATION_META.BUILD_REVISION]: [REVISION],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [DIGEST],
    [ATTESTATION_META.DEPLOYMENT_URL]: [DEPLOYMENT_URL],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.attestation, {
    buildRevision: REVISION,
    instrumentationDigest: DIGEST,
    deploymentUrl: DEPLOYMENT_URL,
  });
});

test('pure extraction fails closed on missing malformed and duplicate markers', () => {
  assert.equal(validatePageAttestationMetaContents({}).reason, 'MISSING_BUILD_REVISION');
  assert.equal(validatePageAttestationMetaContents({
    [ATTESTATION_META.BUILD_REVISION]: [REVISION],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [DIGEST],
    [ATTESTATION_META.DEPLOYMENT_URL]: ['not-a-url'],
  }).reason, 'MALFORMED_DEPLOYMENT_URL');
  assert.equal(validatePageAttestationMetaContents({
    [ATTESTATION_META.BUILD_REVISION]: [REVISION, REVISION],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [DIGEST],
    [ATTESTATION_META.DEPLOYMENT_URL]: [DEPLOYMENT_URL],
  }).reason, 'DUPLICATE_META');
});

test('aggregate page attestations rejects inconsistent multi-page values', () => {
  const first = validatePageAttestationMetaContents({
    [ATTESTATION_META.BUILD_REVISION]: [REVISION],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [DIGEST],
    [ATTESTATION_META.DEPLOYMENT_URL]: [DEPLOYMENT_URL],
  });
  const second = validatePageAttestationMetaContents({
    [ATTESTATION_META.BUILD_REVISION]: ['git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [DIGEST],
    [ATTESTATION_META.DEPLOYMENT_URL]: [DEPLOYMENT_URL],
  });
  const aggregated = aggregatePageAttestations([first, second]);
  assert.equal(aggregated.ok, false);
  assert.equal(aggregated.reason, 'BUILD_REVISION_INCONSISTENT');
});

test('exact hybrid attestation match grants fix capability', () => {
  const result = resolveFixCapability({
    url: `${DEPLOYMENT_URL}/jobs`,
    localRoot: '/repo',
    remoteRevision: REVISION,
    localRevision: REVISION,
    remoteInstrumentationDigest: DIGEST,
    localInstrumentationDigest: DIGEST,
    remoteDeploymentUrl: DEPLOYMENT_URL,
    localDeploymentUrl: DEPLOYMENT_URL,
    scannedUrl: `${DEPLOYMENT_URL}/jobs`,
    attestationStatus: 'complete',
  });
  assert.equal(result.canFix, true);
  assert.equal(result.mode, 'hybrid');
});

test('mode gate fails closed for missing markers dirty revision and mismatches', () => {
  const base = {
    url: `${DEPLOYMENT_URL}/`,
    localRoot: '/repo',
    remoteRevision: REVISION,
    localRevision: REVISION,
    remoteInstrumentationDigest: DIGEST,
    localInstrumentationDigest: DIGEST,
    remoteDeploymentUrl: DEPLOYMENT_URL,
    localDeploymentUrl: DEPLOYMENT_URL,
    scannedUrl: `${DEPLOYMENT_URL}/`,
    attestationStatus: 'complete',
  };

  assert.equal(resolveFixCapability({ ...base, remoteRevision: null }).reason, 'BUILD_REVISION_MISSING');
  assert.equal(resolveFixCapability({
    ...base,
    attestationStatus: 'malformed',
    attestationReason: 'DUPLICATE_META',
  }).reason, 'DUPLICATE_META');
  assert.equal(resolveFixCapability({
    ...base,
    remoteRevision: `${REVISION}:dirty`,
    localRevision: `${REVISION}:dirty`,
  }).reason, 'BUILD_REVISION_DIRTY');
  assert.equal(resolveFixCapability({
    ...base,
    remoteRevision: 'git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }).reason, 'BUILD_REVISION_MISMATCH');
  assert.equal(resolveFixCapability({
    ...base,
    localInstrumentationDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }).reason, 'INSTRUMENTATION_DIGEST_MISMATCH');
  assert.equal(resolveFixCapability({
    ...base,
    localDeploymentUrl: 'https://other.test',
  }).reason, 'DEPLOYMENT_URL_MISMATCH');
  assert.equal(resolveFixCapability({
    ...base,
    scannedUrl: 'https://other.test/page',
  }).reason, 'DEPLOYMENT_URL_MISMATCH');
});

test('local sidecar tamper and symlink escapes fail closed', () => {
  withBuildRevision(REVISION, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-hybrid-local-'));
    const outside = mkdtempSync(join(tmpdir(), 'ada-hybrid-out-'));
    try {
      const { digest } = writeHybridAttestationProject(root);
      assert.equal(loadTrustedLocalAttestation(root).ok, true);

      writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({
        buildRevision: REVISION,
        instrumentationDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        deploymentUrl: DEPLOYMENT_URL,
      }));
      const tampered = loadTrustedLocalAttestation(root);
      assert.equal(tampered.ok, true);
      assert.equal(tampered.attestation.instrumentationDigest, digest);
      assert.notEqual(tampered.attestation.instrumentationDigest, 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

      writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'escape-out' }));
      symlinkSync(outside, join(root, 'escape-out'));
      assert.equal(loadTrustedLocalAttestation(root).reason, 'PATH_TRAVERSAL');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('trusted trace rejects stale or missing preimages and ambiguous verified mappings', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-hybrid-trace-'));
  try {
    const sourceMap = writeVerifiedFixtureSources(root);
    const scanResults = patchScanResultsSources(baseFixture.scanResults, sourceMap);
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: hybridTarget(),
    });
    const findings = report.pages.flatMap((page) => page.findings);
    const inbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      candidates: [],
    });

    const traced = traceAllFindings(inbox, findings);
    assert.equal(traced.every((item) => item.verifiedSource), true);

    const staleFindings = structuredClone(findings);
    staleFindings[0].source.preimageSha256 = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const stale = traceAllFindings(inbox, staleFindings);
    assert.equal(stale[0].reason, 'SOURCE_PREIMAGE_MISMATCH');

    const missing = traceAllFindings(createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
    }), [{
      ...findings[0],
      source: {
        ...findings[0].source,
        file: 'src/partials/jobs/missing.liquid',
      },
    }]);
    assert.equal(missing[0].reason, 'SOURCE_PREIMAGE_MISMATCH');

    const ambiguousInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      candidates: [{
        findingId: findings[0].findingId,
        partials: [
          findings[0].source,
          sourceMap['src/pages/index.liquid'] && {
            file: 'src/pages/index.liquid',
            line: 30,
            confidence: 'high',
            method: 'candidate',
            preimageSha256: sourceMap['src/pages/index.liquid'].preimageSha256,
          },
        ].filter(Boolean),
      }],
    });
    const ambiguous = traceAllFindings(ambiguousInbox, [findings[0]]);
    assert.equal(ambiguous[0].reason, 'AMBIGUOUS_MAPPING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping disambiguates verified source ownership for canonicalization', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-hybrid-manual-'));
  try {
    const sourceMap = writeVerifiedFixtureSources(root);
    const scanResults = patchScanResultsSources(baseFixture.scanResults, sourceMap);
    const report = buildScanReportV2(scanResults, {
      ...baseFixture.context,
      target: hybridTarget(),
    });
    const finding = report.pages[0].findings[0];
    const inbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      candidates: [],
    });
    inbox.manualMappings.set(finding.findingId, {
      findingId: finding.findingId,
      file: 'src/partials/jobs/sort.liquid',
      line: 12,
      expectedPreimageSha256: sourceMap['src/partials/jobs/sort.liquid'].preimageSha256,
      computedPreimageSha256: sourceMap['src/partials/jobs/sort.liquid'].preimageSha256,
    });
    const traced = traceAllFindings(inbox, [finding]);
    const sanitized = applyTraceResultsToFindings([finding], traced);
    assert.equal(sanitized[0].source.file, 'src/partials/jobs/sort.liquid');
    assert.equal(sanitized[0].source.preimageSha256, sourceMap['src/partials/jobs/sort.liquid'].preimageSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report identity changes when attestation fields are present', () => {
  const without = buildScanReportV2(baseFixture.scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'url-only',
      url: `${DEPLOYMENT_URL}/`,
      buildRevision: null,
      instrumentationDigest: null,
      deploymentUrl: null,
      attestationStatus: 'missing',
      attestationReason: 'LOCAL_SOURCE_REQUIRED',
    },
  });
  const withAttestation = buildScanReportV2(baseFixture.scanResults, {
    ...baseFixture.context,
    target: hybridTarget(),
  });
  assert.notEqual(without.reportId, withAttestation.reportId);
  assert.notEqual(computeReportId(without), computeReportId(withAttestation));
});

test('remote URL with source derives hybrid only for complete URL-matching attestation', () => {
  const attestation = {
    buildRevision: REVISION,
    instrumentationDigest: DIGEST,
    deploymentUrl: DEPLOYMENT_URL,
  };
  const page = validatePageAttestationMetaContents({
    [ATTESTATION_META.BUILD_REVISION]: [attestation.buildRevision],
    [ATTESTATION_META.INSTRUMENTATION_DIGEST]: [attestation.instrumentationDigest],
    [ATTESTATION_META.DEPLOYMENT_URL]: [attestation.deploymentUrl],
  });

  const hybrid = deriveRemoteScanTarget({
    scannedUrl: `${DEPLOYMENT_URL}/jobs`,
    sourceRoot: '/repo',
    pageAttestations: [page],
  });
  assert.equal(hybrid.mode, 'hybrid');
  assert.equal(hybrid.attestationStatus, 'complete');

  const urlOnly = deriveRemoteScanTarget({
    scannedUrl: `${DEPLOYMENT_URL}/jobs`,
    sourceRoot: null,
    pageAttestations: [page],
  });
  assert.equal(urlOnly.mode, 'url-only');

  const mismatch = deriveRemoteScanTarget({
    scannedUrl: 'https://other.test/jobs',
    sourceRoot: '/repo',
    pageAttestations: [page],
  });
  assert.equal(mismatch.mode, 'url-only');
  assert.equal(mismatch.attestationReason, 'DEPLOYMENT_URL_MISMATCH');
});

test('exact hybrid attestation reaches controller fix workflow', () => {
  withBuildRevision(REVISION, () => withDeploymentEnv(DEPLOYMENT_URL, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-hybrid-controller-'));
    try {
      const { digest } = writeHybridAttestationProject(root);
      const report = buildHybridReport(root, digest);
      const result = startFixController({ report, localRoot: root });
      assert.equal(result.status, 'pending');
      assert.equal(result.capability.mode, 'hybrid');
      assert.equal(result.capability.canFix, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));
});

test('deployment URL canonicalization enforces origin and base-path scope', () => {
  assert.equal(canonicalizeDeploymentUrl('https://Example.test/careers'), 'https://example.test/careers');
  assert.equal(canonicalizeDeploymentUrl('https://example.test/careers/?utm=1'), null);
  assert.equal(canonicalizeDeploymentUrl('https://example.test/careers#hash'), null);
  assert.equal(isUrlWithinDeploymentScope('https://example.test/careers/jobs', 'https://example.test/careers'), true);
  assert.equal(isUrlWithinDeploymentScope('https://other.test/careers/jobs', 'https://example.test/careers'), false);
});

test('hybrid incomplete attestation forwards attestationReason', () => {
  const result = resolveFixCapability({
    url: `${DEPLOYMENT_URL}/`,
    localRoot: '/repo',
    remoteRevision: REVISION,
    localRevision: REVISION,
    remoteInstrumentationDigest: DIGEST,
    localInstrumentationDigest: DIGEST,
    remoteDeploymentUrl: DEPLOYMENT_URL,
    localDeploymentUrl: DEPLOYMENT_URL,
    attestationStatus: 'scope-mismatch',
    attestationReason: 'DEPLOYMENT_URL_MISMATCH',
  });
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'DEPLOYMENT_URL_MISMATCH');
});

test('attestation meta HTML fixture contains exactly one marker each', () => {
  const html = attestationMetaHtml({
    buildRevision: REVISION,
    instrumentationDigest: DIGEST,
    deploymentUrl: DEPLOYMENT_URL,
  });
  for (const name of Object.values(ATTESTATION_META)) {
    assert.equal((html.match(new RegExp(`name="${name}"`, 'g')) || []).length, 1);
  }
});
