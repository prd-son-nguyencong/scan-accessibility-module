import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { hashFileContent, validateAndBuildCandidate } from '../../src/fix/candidate/intent.js';
import { attachDiffToCandidate } from '../../src/fix/candidate/diff.js';
import {
  assertLoopbackSiteUrl,
  runShadowVerification,
  ShadowVerificationError,
} from '../../src/fix/verify/shadow.js';
import {
  createLoopbackSiteAdapter,
  createPassingScanner,
  createScannerWithOwnedSiteLifecycle,
} from './helpers/shadow-adapters.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/fix/projects/minimal-liquid-site', import.meta.url));
const EXIT_SCRIPT = fileURLToPath(new URL('../fixtures/fix/scripts/exit-code.js', import.meta.url));

function cloneFixture(root) {
  cpSync(FIXTURE_ROOT, root, { recursive: true });
}

function candidateFor(root) {
  const rel = 'src/pages/index.liquid';
  const content = readFileSync(join(root, rel), 'utf8');
  const line = 3;
  const preimage = buildSourcePreimage(content, line);
  return attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: root,
    reportId: 'sha256:shadow-site',
    policyVersion: '1',
    edits: [{
      file: rel,
      blockRange: { startLine: line, endLine: line },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText: '<button id="apply">Apply</button>',
      newText: '<button id="apply" aria-label="Apply">Apply</button>',
    }],
  }));
}

function baseShadowOptions(root, sessionDir, { site, scanner } = {}) {
  return {
    localRoot: root,
    sessionDir,
    candidate: candidateFor(root),
    build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
    site: site || createLoopbackSiteAdapter(),
    scanner: scanner || createPassingScanner(),
  };
}

test('assertLoopbackSiteUrl rejects non-loopback hosts', () => {
  assert.throws(
    () => assertLoopbackSiteUrl('http://example.test/'),
    (error) => error instanceof ShadowVerificationError && error.code === 'SITE_URL_NOT_LOOPBACK',
  );
  assert.equal(assertLoopbackSiteUrl('http://127.0.0.1:4321/'), 'http://127.0.0.1:4321/');
});

test('runShadowVerification starts site after build and stops it on success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-site-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'site-ok');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const site = createLoopbackSiteAdapter();
  let seenSiteUrl = null;
  const scanner = async ({ siteUrl }) => {
    seenSiteUrl = siteUrl;
    return { findings: [], sourceTraceResolved: true, executedLayers: ['axe', 'accessScan'] };
  };
  try {
    cloneFixture(root);
    const result = await runShadowVerification(baseShadowOptions(root, sessionDir, { site, scanner }));
    assert.equal(result.ok, true);
    assert.equal(site.started, 1);
    assert.equal(site.stopped, 1);
    assert.equal(seenSiteUrl, 'http://127.0.0.1:8765/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runShadowVerification stops site when scanner fails validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-site-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'site-fail');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const site = createLoopbackSiteAdapter();
  try {
    cloneFixture(root);
    await assert.rejects(
      () => runShadowVerification(baseShadowOptions(root, sessionDir, {
        site,
        scanner: async () => ({ findings: [], sourceTraceResolved: false }),
      })),
      (error) => error.code === 'SOURCE_TRACE_UNRESOLVED',
    );
    assert.equal(site.started, 1);
    assert.equal(site.stopped, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runShadowVerification does not start site when build fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-site-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'site-build-fail');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const site = createLoopbackSiteAdapter();
  try {
    cloneFixture(root);
    const result = await runShadowVerification({
      ...baseShadowOptions(root, sessionDir, { site }),
      build: { command: process.execPath, args: [EXIT_SCRIPT, '3'] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'BUILD_FAILED');
    assert.equal(site.started, 0);
    assert.equal(site.stopped, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanner declaring ownsSiteLifecycle skips separate site adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-site-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'site-owned');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const site = createLoopbackSiteAdapter();
  const scanner = createScannerWithOwnedSiteLifecycle(async ({ siteUrl }) => {
    assert.equal(siteUrl, null);
    return { findings: [], sourceTraceResolved: true, executedLayers: ['axe', 'accessScan'] };
  });
  try {
    cloneFixture(root);
    const result = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate: candidateFor(root),
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      scanner,
    });
    assert.equal(result.ok, true);
    assert.equal(site.started, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runShadowVerification requires site adapter when scanner does not own lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-site-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'site-required');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    cloneFixture(root);
    await assert.rejects(
      () => runShadowVerification({
        localRoot: root,
        sessionDir,
        candidate: candidateFor(root),
        build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
        scanner: createPassingScanner(),
      }),
      (error) => error.code === 'SITE_REQUIRED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
