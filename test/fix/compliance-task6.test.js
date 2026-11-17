import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import {
  CandidateIntentError,
  hashFileContent,
  validateAndBuildCandidate,
} from '../../src/fix/candidate/intent.js';
import { attachDiffToCandidate } from '../../src/fix/candidate/diff.js';
import {
  VerificationArtifactError,
  persistVerificationArtifact,
  readAndVerifyArtifact,
} from '../../src/fix/verify/artifact.js';
import { runManagedCommand, runShadowVerification } from '../../src/fix/verify/shadow.js';
import { buildCommandEnvironment } from '../../src/fix/verify/process-env.js';
import { applyBatchTransaction, applyTransaction } from '../../src/fix/apply/transaction.js';
import { parseJournal, restoreTransactionFiles } from '../../src/fix/apply/rollback.js';
import {
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  WorkspaceLockError,
} from '../../src/fix/apply/lock.js';
import { persistPassedVerificationArtifact } from './helpers/candidate-fixture.js';
import { createLoopbackSiteAdapter } from './helpers/shadow-adapters.js';

const REPORT_ID = 'sha256:compliance-task6';
const HANG_SCRIPT = fileURLToPath(new URL('../fixtures/fix/scripts/hang.js', import.meta.url));

function writeFile(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function buildCandidate(root, rel, oldText, newText, line = 1, fileContent = null) {
  const content = fileContent ?? `${oldText}tail\n`;
  writeFile(root, rel, content);
  const readContent = readFileSync(join(root, rel), 'utf8');
  const preimage = buildSourcePreimage(readContent, line);
  return attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: '1',
    edits: [{
      file: rel,
      blockRange: { startLine: line, endLine: line },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(readContent),
      oldText,
      newText,
    }],
  }));
}

function entryFor(sessionDir, candidate, fixUnitId = 'u1') {
  return {
    fixUnitId,
    candidate,
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    verificationArtifactId: persistPassedVerificationArtifact(sessionDir, {
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
    }),
  };
}

test('readAndVerifyArtifact rejects missing failed mismatch and tampered artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-artifact-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'artifact');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidate = buildCandidate(root, 'src/a.liquid', 'alpha', 'beta');
    assert.throws(
      () => readAndVerifyArtifact(sessionDir, 'verification-test', {
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
      }),
      (error) => error instanceof VerificationArtifactError && error.code === 'ARTIFACT_ID_INVALID',
    );
    const failed = persistVerificationArtifact(sessionDir, {
      status: 'failed',
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
      targetFindingIds: [],
      removedTargets: [],
      newCriticalSerious: [],
      sourceTraceResolved: true,
      manualChecks: [],
      manualChecksAcknowledged: true,
    });
    assert.throws(
      () => readAndVerifyArtifact(sessionDir, failed.artifactId, {
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
      }),
      (error) => error.code === 'ARTIFACT_NOT_PASSED',
    );
    const passed = persistPassedVerificationArtifact(sessionDir, {
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
    });
    assert.throws(
      () => readAndVerifyArtifact(sessionDir, passed, {
        candidateHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        diffHash: candidate.diffHash,
      }),
      (error) => error.code === 'ARTIFACT_HASH_BINDING_MISMATCH',
    );
    const tamperedPath = join(sessionDir, `${passed}.json`);
    const parsed = JSON.parse(readFileSync(tamperedPath, 'utf8'));
    parsed.build = { exitCode: 99 };
    writeFileSync(tamperedPath, `${JSON.stringify(parsed, null, 2)}\n`);
    assert.throws(
      () => readAndVerifyArtifact(sessionDir, passed, {
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
      }),
      (error) => error.code === 'ARTIFACT_DIGEST_MISMATCH',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyBatchTransaction commits multiple candidates atomically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-batch-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'batch');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidateA = buildCandidate(root, 'src/a.liquid', 'alpha', 'alpha-fixed');
    const candidateB = buildCandidate(root, 'src/b.liquid', 'beta', 'beta-fixed');
    const result = await applyBatchTransaction({
      localRoot: root,
      sessionDir,
      entries: [entryFor(sessionDir, candidateA, 'u1'), entryFor(sessionDir, candidateB, 'u2')],
    });
    assert.equal(result.status, 'committed');
    assert.match(readFileSync(join(root, 'src/a.liquid'), 'utf8'), /alpha-fixed/);
    assert.match(readFileSync(join(root, 'src/b.liquid'), 'utf8'), /beta-fixed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyBatchTransaction rejects cross-candidate overlapping edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-overlap-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'overlap');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    writeFile(root, 'src/a.liquid', 'shared-tail\n');
    const content = readFileSync(join(root, 'src/a.liquid'), 'utf8');
    const preimage = buildSourcePreimage(content, 1);
    const baseEdit = {
      file: 'src/a.liquid',
      blockRange: { startLine: 1, endLine: 1 },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
    };
    const candidateA = attachDiffToCandidate(validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{ ...baseEdit, oldText: 'shared', newText: 'shared-a' }],
    }));
    const candidateB = attachDiffToCandidate(validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{ ...baseEdit, oldText: 'shared', newText: 'shared-b' }],
    }));
    await assert.rejects(
      () => applyBatchTransaction({
        localRoot: root,
        sessionDir,
        entries: [entryFor(sessionDir, candidateA), entryFor(sessionDir, candidateB, 'u2')],
      }),
      (error) => error instanceof CandidateIntentError && error.code === 'OVERLAPPING_EDITS',
    );
    assert.equal(readFileSync(join(root, 'src/a.liquid'), 'utf8'), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight stale preimage performs no source writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-preflight-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'preflight');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidate = buildCandidate(root, 'src/a.liquid', 'alpha', 'beta');
    writeFileSync(join(root, 'src/a.liquid'), 'changed-tail\n');
    await assert.rejects(
      () => applyTransaction({
        localRoot: root,
        sessionDir,
        candidate,
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
        verificationArtifactId: persistPassedVerificationArtifact(sessionDir, {
          candidateHash: candidate.candidateHash,
          diffHash: candidate.diffHash,
        }),
      }),
      (error) => error.code === 'STALE_PREIMAGE',
    );
    assert.equal(readFileSync(join(root, 'src/a.liquid'), 'utf8'), 'changed-tail\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoreTransactionFiles reports concurrent edit conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-rb-conflict-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'rb');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidate = buildCandidate(root, 'src/a.liquid', 'alpha', 'beta');
    const failed = await applyTransaction({
      localRoot: root,
      sessionDir,
      candidate,
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
      verificationArtifactId: persistPassedVerificationArtifact(sessionDir, {
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
      }),
      failAfterWrite: 0,
    });
    assert.equal(failed.status, 'rolled-back');
    writeFileSync(join(root, 'src/a.liquid'), 'user-changed-tail\n');
    const rollback = await restoreTransactionFiles({
      localRoot: root,
      transactionDir: failed.transactionDir,
    });
    assert.ok(rollback.conflicts.some((entry) => entry.reason === 'CONCURRENT_EDIT'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal parser rejects traversal duplicate and tampered events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-journal-'));
  const transactionDir = join(root, 'transaction');
  mkdirSync(join(transactionDir, 'snapshots'), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(transactionDir, 'journal.ndjson'), `${JSON.stringify({
      action: 'write',
      file: '../outside.liquid',
      preHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      postHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })}\n`, { mode: 0o600 });
    assert.throws(() => parseJournal(transactionDir));
    writeFileSync(join(transactionDir, 'journal.ndjson'), [
      JSON.stringify({
        action: 'write',
        file: 'src/a.liquid',
        preHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        postHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
      JSON.stringify({
        action: 'write',
        file: 'src/a.liquid',
        preHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        postHash: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      }),
    ].join('\n') + '\n', { mode: 0o600 });
    assert.throws(
      () => parseJournal(transactionDir),
      (error) => error.code === 'JOURNAL_DUPLICATE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace lock rejects live contention and reclaims dead stale lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-lock-'));
  try {
    const first = acquireWorkspaceLock(root);
    assert.throws(
      () => acquireWorkspaceLock(root),
      (error) => error instanceof WorkspaceLockError
        && error.code === 'LOCK_CONTENTION'
        && /pid \d+/.test(error.message),
    );
    releaseWorkspaceLock(first.lockPath, first.token);
    const stalePath = join(root, '.ada-fix.apply.lock');
    writeFileSync(stalePath, `${JSON.stringify({ token: 'dead', pid: 999999999, acquiredAt: new Date().toISOString() })}\n`);
    const reclaimed = acquireWorkspaceLock(root);
    assert.ok(reclaimed.token);
    releaseWorkspaceLock(reclaimed.lockPath, reclaimed.token);
    assert.equal(existsSync(stalePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command environment does not expose sentinel secret', () => {
  const prior = process.env.ADA_FIX_SENTINEL_SECRET;
  process.env.ADA_FIX_SENTINEL_SECRET = 'super-secret-value';
  try {
    const env = buildCommandEnvironment({ ADA_FIX_ALLOWED: '1' });
    assert.equal(env.ADA_FIX_SENTINEL_SECRET, undefined);
    assert.equal(env.ADA_FIX_ALLOWED, '1');
  } finally {
    if (prior == null) delete process.env.ADA_FIX_SENTINEL_SECRET;
    else process.env.ADA_FIX_SENTINEL_SECRET = prior;
  }
});

test('shadow verification fails closed when sourceTraceResolved is false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-trace-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'trace');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const content = '<button id="apply">Apply</button>\n';
    writeFile(root, 'src/pages/index.liquid', content);
    writeFile(root, 'scripts/build.js', 'process.exit(0);\n');
    const candidate = buildCandidate(
      root,
      'src/pages/index.liquid',
      '<button id="apply">Apply</button>',
      '<button id="apply" aria-label="Apply">Apply</button>',
      1,
      content,
    );
    await assert.rejects(
      () => runShadowVerification({
        localRoot: root,
        sessionDir,
        candidate,
        build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
        site: createLoopbackSiteAdapter(),
        scanner: async () => ({ findings: [], sourceTraceResolved: false }),
      }),
      (error) => error.code === 'SOURCE_TRACE_UNRESOLVED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shadow performance provenance never claims PSI parity for local Lighthouse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-perf-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'perf');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const content = '<button id="apply">Apply</button>\n';
    writeFile(root, 'src/pages/index.liquid', content);
    writeFile(root, 'scripts/build.js', 'process.exit(0);\n');
    const candidate = buildCandidate(
      root,
      'src/pages/index.liquid',
      '<button id="apply">Apply</button>',
      '<button id="apply" aria-label="Apply">Apply</button>',
      1,
      content,
    );
    const result = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate,
      targetFindingIds: ['f1'],
      baselineFindings: [{ findingId: 'f1', impact: 'serious' }],
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter(),
      scanner: async () => ({ findings: [], sourceTraceResolved: true, executedLayers: ['axe', 'accessScan'] }),
      performanceMetrics: {
        baseline: { lcpMs: 1200 },
        after: { lcpMs: 900 },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.artifact.environment.localLighthouse, false);
    assert.equal(result.artifact.environment.psiParity, false);
    assert.equal(result.artifact.performance.baseline.lcpMs, 1200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runManagedCommand rejects on timeout and escalates termination', async () => {
  if (process.platform === 'win32') return;
  await assert.rejects(
    () => runManagedCommand(process.execPath, [HANG_SCRIPT], tmpdir(), {
      timeoutMs: 200,
    }),
    (error) => error.code === 'COMMAND_TIMEOUT',
  );
});

test('failed atomic write removes temp files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-compliance-temp-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'temp');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidate = buildCandidate(root, 'src/a.liquid', 'alpha', 'beta');
    chmodSync(join(root, 'src'), 0o500);
    await assert.rejects(
      () => applyTransaction({
        localRoot: root,
        sessionDir,
        candidate,
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
        verificationArtifactId: persistPassedVerificationArtifact(sessionDir, {
          candidateHash: candidate.candidateHash,
          diffHash: candidate.diffHash,
        }),
      }),
    );
    const dirEntries = readdirSync(join(root, 'src'));
    assert.ok(dirEntries.every((name) => !name.includes('.tmp')));
  } finally {
    try {
      chmodSync(join(root, 'src'), 0o700);
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('production Task6 modules do not import legacy fixer rollback', () => {
  const modules = [
    '../../src/fix/candidate/intent.js',
    '../../src/fix/candidate/diff.js',
    '../../src/fix/verify/shadow.js',
    '../../src/fix/verify/artifact.js',
    '../../src/fix/apply/transaction.js',
    '../../src/fix/apply/rollback.js',
    '../../src/fix/apply/handler.js',
    '../../src/fix/review/state.js',
  ];
  for (const modulePath of modules) {
    const source = readFileSync(new URL(modulePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fixer\/rollback/);
  }
});
