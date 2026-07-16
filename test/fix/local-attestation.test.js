import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patchScanResultsSources,
  writeHybridAttestationProject,
  writeVerifiedFixtureSources,
  DEPLOYMENT_URL,
  REVISION,
  DIGEST,
} from './helpers/hybrid-fixture.js';
import { loadTrustedLocalAttestation } from '../../src/fix/controller/local-attestation.js';
import { startFixController } from '../../src/fix/controller/index.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8')
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

function writeTempProject(root, options = {}) {
  return writeHybridAttestationProject(root, options);
}

function hybridReport(digest = DIGEST) {
  const sourceMap = {
    'src/partials/jobs/sort.liquid': { line: 12, preimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    'src/pages/index.liquid': { line: 30, preimageSha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
  };
  return buildScanReportV2(patchScanResultsSources(baseFixture.scanResults, sourceMap), {
    ...baseFixture.context,
    target: {
      mode: 'hybrid',
      url: `${DEPLOYMENT_URL}/`,
      buildRevision: REVISION,
      instrumentationDigest: digest,
      deploymentUrl: DEPLOYMENT_URL,
      attestationStatus: 'complete',
      attestationReason: null,
    },
  });
}

test('trusted loader recomputes instrumentation digest from manifest', () => {
  withBuildRevision(REVISION, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
    try {
      const { digest } = writeTempProject(root);
      const loaded = loadTrustedLocalAttestation(root);
      assert.equal(loaded.ok, true);
      assert.equal(loaded.attestation.instrumentationDigest, digest);
      assert.equal(loaded.attestation.buildRevision, REVISION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('trusted loader fails closed on missing manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
  try {
    writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'dist', deploymentUrl: DEPLOYMENT_URL }));
    mkdirSync(join(root, 'dist'), { recursive: true });
    const loaded = loadTrustedLocalAttestation(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'LOCAL_ATTESTATION_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted loader rejects symlinked outDir escaping localRoot', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
  const outside = mkdtempSync(join(tmpdir(), 'ada-attest-out-'));
  try {
    mkdirSync(join(outside, 'dist'), { recursive: true });
    writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'escape-out' }));
    symlinkSync(outside, join(root, 'escape-out'));
    const loaded = loadTrustedLocalAttestation(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'PATH_TRAVERSAL');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('trusted loader rejects symlinked manifest file escaping localRoot', () => {
  withBuildRevision(REVISION, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
    const outside = mkdtempSync(join(tmpdir(), 'ada-attest-out-'));
    try {
      writeTempProject(outside);
      writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'dist', deploymentUrl: DEPLOYMENT_URL }));
      mkdirSync(join(root, 'dist'), { recursive: true });
      symlinkSync(join(outside, 'dist', 'scan-manifest.json'), join(root, 'dist', 'scan-manifest.json'));
      writeFileSync(join(root, 'dist', 'scan-attestation.json'), readFileSync(join(outside, 'dist', 'scan-attestation.json')));
      const loaded = loadTrustedLocalAttestation(root);
      assert.equal(loaded.ok, false);
      assert.equal(loaded.reason, 'PATH_TRAVERSAL');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('trusted loader requires independently derived build revision to match persisted value', () => {
  withBuildRevision('git:current-revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
    try {
      writeTempProject(root, { revision: 'git:stale-revision' });
      const loaded = loadTrustedLocalAttestation(root);
      assert.equal(loaded.ok, false);
      assert.equal(loaded.reason, 'BUILD_REVISION_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('trusted loader fails closed when current build revision is unavailable', () => {
  const previous = process.env.ADA_SCAN_BUILD_REVISION;
  delete process.env.ADA_SCAN_BUILD_REVISION;
  const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
  try {
    writeTempProject(root);
    const loaded = loadTrustedLocalAttestation(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'BUILD_REVISION_MISSING');
  } finally {
    if (previous === undefined) delete process.env.ADA_SCAN_BUILD_REVISION;
    else process.env.ADA_SCAN_BUILD_REVISION = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('caller-supplied attestation options cannot bypass missing local files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
  try {
    const report = hybridReport();
    const result = startFixController({
      report,
      localRoot: root,
      localRevision: REVISION,
      localInstrumentationDigest: DIGEST,
    });
    assert.equal(result.status, 'scan-only');
    assert.equal(result.capability.reason, 'LOCAL_ATTESTATION_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('echoed report attestation cannot bypass mismatched local manifest digest', () => {
  withBuildRevision(REVISION, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
    try {
      const { digest } = writeTempProject(root, {
        manifest: { 'dist/pages/index.html': 'src/pages/index.liquid' },
      });
      const report = hybridReport(DIGEST);
      assert.notEqual(digest, DIGEST);
      const result = startFixController({
        report,
        localRoot: root,
        localRevision: REVISION,
        localInstrumentationDigest: DIGEST,
      });
      assert.equal(result.status, 'scan-only');
      assert.equal(result.reason, undefined);
      assert.equal(result.capability.reason, 'INSTRUMENTATION_DIGEST_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('matching local filesystem attestation enables hybrid fix', () => {
  withBuildRevision(REVISION, () => {
    const root = mkdtempSync(join(tmpdir(), 'ada-attest-'));
    try {
      const { digest } = writeTempProject(root);
      writeVerifiedFixtureSources(root);
      const report = hybridReport(digest);
      const result = startFixController({ report, localRoot: root });
      assert.equal(result.status, 'pending');
      assert.equal(result.capability.mode, 'hybrid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
