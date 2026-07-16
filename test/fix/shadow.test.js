import {
  existsSync,
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
  createLoopbackSiteAdapter,
  createPassingScanner,
} from './helpers/shadow-adapters.js';
import {
  copyProjectTreeIntoShadow,
  runShadowVerification,
} from '../../src/fix/verify/shadow.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/fix/projects/minimal-liquid-site', import.meta.url));
const EXIT_SCRIPT = fileURLToPath(new URL('../fixtures/fix/scripts/exit-code.js', import.meta.url));
const REPORT_ID = 'sha256:shadow-report';

function cloneFixture(root) {
  cpSync(FIXTURE_ROOT, root, { recursive: true });
}

function candidateFor(root) {
  const rel = 'src/pages/index.liquid';
  const content = readFileSync(join(root, rel), 'utf8');
  const line = 3;
  const preimage = buildSourcePreimage(content, line);
  const candidate = validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: '1',
    edits: [{
      file: rel,
      blockRange: { startLine: line, endLine: line },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText: '<button id="apply">Apply</button>',
      newText: '<button id="apply" aria-label="Apply">Apply</button>',
    }],
  });
  return attachDiffToCandidate(candidate);
}

test('shadow verification makes zero pre-approval writes to user project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 's1');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    cloneFixture(root);
    const rel = 'src/pages/index.liquid';
    const before = readFileSync(join(root, rel), 'utf8');
    const candidate = candidateFor(root);
    const result = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate,
      targetFindingIds: ['f-target'],
      baselineFindings: [{ findingId: 'f-target', impact: 'serious' }],
      manualChecks: ['Confirm announcement'],
      manualChecksAcknowledged: true,
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter(),
      scanner: createPassingScanner(),
    });
    assert.equal(readFileSync(join(root, rel), 'utf8'), before);
    assert.equal(result.ok, true);
    assert.match(result.artifact.status, /passed/);
    assert.equal(result.artifact.environment.psiParity, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shadow copy permits ordinary build assets above the candidate text limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-assets-'));
  const shadowRoot = mkdtempSync(join(tmpdir(), 'ada-shadow-copy-'));
  try {
    mkdirSync(join(root, 'src', 'assets'), { recursive: true });
    const asset = Buffer.alloc(600 * 1024, 0x61);
    writeFileSync(join(root, 'src', 'assets', 'career.webp'), asset);

    copyProjectTreeIntoShadow({ localRoot: root, shadowRoot });

    assert.equal(
      readFileSync(join(shadowRoot, 'src', 'assets', 'career.webp')).equals(asset),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(shadowRoot, { recursive: true, force: true });
  }
});

test('shadow verification fails closed on build failure and regression', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 's2');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    cloneFixture(root);
    const candidate = candidateFor(root);
    const buildFail = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate,
      build: { command: process.execPath, args: [EXIT_SCRIPT, '2'] },
      site: createLoopbackSiteAdapter(),
      scanner: createPassingScanner(),
    });
    assert.equal(buildFail.ok, false);
    assert.equal(buildFail.reason, 'BUILD_FAILED');

    const regression = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate,
      targetFindingIds: ['f-target'],
      baselineFindings: [],
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter(),
      scanner: async () => ({
        findings: [{ findingId: 'f-new', impact: 'critical' }],
        sourceTraceResolved: true,
        executedLayers: ['axe', 'accessScan'],
      }),
    });
    assert.equal(regression.ok, false);
    assert.ok(regression.artifact.newCriticalSerious.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shadow verification requires scanner adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 's3');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    cloneFixture(root);
    await assert.rejects(
      () => runShadowVerification({ localRoot: root, sessionDir, candidate: candidateFor(root) }),
      (error) => error.code === 'SCANNER_REQUIRED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shadow verification keeps manual checks pending unless acknowledged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-shadow-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 's4');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    cloneFixture(root);
    const pending = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate: candidateFor(root),
      targetFindingIds: ['f-target'],
      baselineFindings: [{ findingId: 'f-target', impact: 'serious' }],
      manualChecks: ['Confirm announcement'],
      manualChecksAcknowledged: false,
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter(),
      scanner: createPassingScanner(),
    });
    assert.equal(pending.ok, false);
    const artifactFile = readdirSync(sessionDir).find((name) => name.startsWith('verification-'));
    const files = readFileSync(join(sessionDir, artifactFile), 'utf8');
    assert.doesNotMatch(files, /\/Users\//);
    assert.doesNotMatch(files, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shadow module does not import legacy fixer rollback', () => {
  const source = readFileSync(new URL('../../src/fix/verify/shadow.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fixer\/rollback/);
});
