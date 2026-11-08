import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { attachDiffToCandidate } from '../../src/fix/candidate/diff.js';
import { hashFileContent, hashFileBytes, validateAndBuildCandidate } from '../../src/fix/candidate/intent.js';
import {
  __artifactTestHooks,
  assertDemoCandidateScope,
  createDemoApplyHandlerWrap,
  createDemoRollbackHandler,
  DemoArtifactError,
  exportDemoArtifacts,
  readBoundedFileNoFollow,
  readDemoEvidence,
  writeDemoEvidence,
} from '../../src/fix/demo/artifacts.js';
import { runCisDemo } from '../../src/fix/demo/orchestrator.js';
import { createReviewState, persistReviewState } from '../../src/fix/review/state.js';
import { startReviewServer, TOKEN_HEADER } from '../../src/fix/review/server.js';

const REPORT_ID = 'sha256:demo-artifacts-report';
const TARGET_FILE = 'src/pages/index.liquid';
const MODEL_ID = 'anthropic.claude-sonnet-5';

function writeProject(root, content = '<div id="page">Home</div>\n') {
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  writeFileSync(join(root, TARGET_FILE), content, 'utf8');
}

function prepareSessionLayout(root, sessionId = 'demo-artifacts') {
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', sessionId);
  const sandboxRoot = join(sessionDir, 'demo-workspace');
  writeProject(root);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(sessionDir, 'artifacts'), { recursive: true, mode: 0o700 });
  mkdirSync(join(sandboxRoot, 'src', 'pages'), { recursive: true });
  writeFileSync(
    join(sandboxRoot, TARGET_FILE),
    readFileSync(join(root, TARGET_FILE), 'utf8'),
    'utf8',
  );
  return { sessionDir, sandboxRoot };
}

function buildDemoContext({
  originalRoot,
  sandboxRoot,
  sessionDir,
  sessionId = 'demo-artifacts',
  targetFile = TARGET_FILE,
  originalHash = null,
  sandboxHash = null,
}) {
  const originalBytes = readFileSync(join(originalRoot, targetFile));
  const sandboxBytes = readFileSync(join(sandboxRoot, targetFile));
  const originalSha = originalHash || hashFileBytes(originalBytes);
  const sandboxSha = sandboxHash || hashFileBytes(sandboxBytes);
  return {
    originalRoot,
    sandboxRoot,
    sessionDir,
    artifactsDir: join(sessionDir, 'artifacts'),
    targetFile,
    sessionId,
    checkpoints: {
      original: { fileSha256: originalSha },
      sandbox: { fileSha256: sandboxSha },
    },
  };
}

function buildCandidateRecord(root, {
  relPath = TARGET_FILE,
  oldText = '<div id="page">Home</div>',
  newText = '<div id="page" role="main">Home</div>',
  content = '<div id="page">Home</div>\n',
  modelId = MODEL_ID,
} = {}) {
  const preimage = buildSourcePreimage(content, 1);
  const candidate = attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: '1',
    modelId,
    edits: [{
      file: relPath,
      blockRange: { startLine: 1, endLine: 1 },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText,
      newText,
    }],
  }));
  return {
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    diff: candidate.diff,
    editIntents: candidate.edits,
    policyVersion: candidate.policyVersion,
    promptVersion: candidate.promptVersion,
    modelId: candidate.modelId,
    verified: true,
    conflictFree: true,
    verification: { status: 'passed', artifactId: 'artifact-demo-1' },
  };
}

function buildApplyPayload(root, candidateRecord, fixUnitId = 'unit-1') {
  return {
    reportId: REPORT_ID,
    units: [{ fixUnitId, candidateHash: candidateRecord.candidateHash, diffHash: candidateRecord.diffHash }],
    candidates: [{ fixUnitId, candidate: candidateRecord }],
  };
}

function assertNoArtifactLeaves(sessionDir, { ignoreFixedPath = false } = {}) {
  assert.equal(existsSync(join(sessionDir, 'artifacts/candidate.patch')), false);
  if (!ignoreFixedPath) {
    assert.equal(existsSync(join(sessionDir, `artifacts/fixed/${TARGET_FILE}`)), false);
  }
  assert.equal(existsSync(join(sessionDir, 'artifacts/evidence.json')), false);
}

function writeTransactionJournal(transactionDir, {
  file,
  preHash,
  postHash,
  candidateHash,
  diffHash,
  verificationArtifactId = 'artifact-demo-1',
}) {
  const lines = [
    JSON.stringify({
      action: 'begin',
      entries: [{
        fixUnitId: 'unit-1',
        candidateHash,
        diffHash,
        verificationArtifactId,
      }],
      files: [file],
    }),
    JSON.stringify({
      action: 'write',
      file,
      preHash,
      postHash,
      at: '2026-01-01T00:00:00.000Z',
    }),
    JSON.stringify({
      action: 'commit',
      files: [file],
    }),
  ];
  writeFileSync(
    join(transactionDir, 'journal.ndjson'),
    `${lines.join('\n')}\n`,
    { mode: 0o600 },
  );
}

function writeTransactionSnapshot(transactionDir, file, content) {
  const snapshotPath = join(transactionDir, 'snapshots', file);
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  writeFileSync(snapshotPath, content, { mode: 0o600 });
}

function prepareRollbackFixtures(root, sessionDir, sandboxRoot) {
  const { context, payload, scope, result, fixedContent } = buildExportFixtures({
    root,
    sessionDir,
    sandboxRoot,
  });
  exportDemoArtifacts(context, payload, result, scope);
  const originalPreApply = '<div id="page">Home</div>\n';
  writeTransactionSnapshot(result.transactionDir, TARGET_FILE, originalPreApply);
  return { context, scope, result, fixedContent, originalPreApply };
}

function prepareFailedExportRollbackFixtures(root, sessionDir, sandboxRoot) {
  const { context, scope, result, fixedContent } = buildExportFixtures({
    root,
    sessionDir,
    sandboxRoot,
    applyFixed: false,
  });
  const originalPreApply = readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8');
  writeTransactionSnapshot(result.transactionDir, TARGET_FILE, originalPreApply);
  writeFileSync(join(sandboxRoot, TARGET_FILE), fixedContent, 'utf8');
  assert.equal(existsSync(join(sessionDir, 'artifacts/evidence.json')), false);
  return {
    context,
    scope,
    result,
    fixedContent,
    originalPreApply,
    transactionId: 'transaction-1700000000000-a1b2c3d4',
  };
}

function committedResult(sessionDir, {
  preHash,
  postHash,
  candidateHash,
  diffHash,
  transactionSuffix = 'a1b2c3d4',
  verificationArtifactId = 'artifact-demo-1',
}) {
  const transactionDir = join(sessionDir, `transaction-1700000000000-${transactionSuffix}`);
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  writeTransactionJournal(transactionDir, {
    file: TARGET_FILE,
    preHash,
    postHash,
    candidateHash,
    diffHash,
    verificationArtifactId,
  });
  return {
    status: 'committed',
    transactionDir,
    written: [{ file: TARGET_FILE, postHash }],
  };
}

function buildExportFixtures({ root, sessionDir, sandboxRoot, applyFixed = true }) {
  const candidateRecord = buildCandidateRecord(sandboxRoot);
  const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
  const payload = buildApplyPayload(sandboxRoot, candidateRecord);
  const scope = assertDemoCandidateScope(context, payload);
  const fixedContent = '<div id="page" role="main">Home</div>\n';
  if (applyFixed) {
    writeFileSync(join(sandboxRoot, TARGET_FILE), fixedContent, 'utf8');
  }
  const result = committedResult(sessionDir, {
    preHash: scope.preApplySandboxHash,
    postHash: scope.expectedPostApplyHash,
    candidateHash: scope.candidateHash,
    diffHash: scope.diffHash,
  });
  return { candidateRecord, context, payload, scope, result, fixedContent };
}

async function runCommittedExportWithHook({
  root,
  sessionDir,
  sandboxRoot,
  failAfterSuccessfulWrites = null,
}) {
  const { candidateRecord, context, payload, scope, fixedContent } = buildExportFixtures({
    root,
    sessionDir,
    sandboxRoot,
    applyFixed: false,
  });
  const result = committedResult(sessionDir, {
    preHash: scope.preApplySandboxHash,
    postHash: scope.expectedPostApplyHash,
    candidateHash: scope.candidateHash,
    diffHash: scope.diffHash,
  });
  let writeCount = 0;
  const previous = __artifactTestHooks.writeExclusiveLeaf;
  __artifactTestHooks.writeExclusiveLeaf = (targetPath, bytes, mode) => {
    writeCount += 1;
    if (failAfterSuccessfulWrites != null && writeCount > failAfterSuccessfulWrites) {
      throw new Error('forced artifact write failure');
    }
    __artifactTestHooks.defaultWriteExclusiveLeaf(targetPath, bytes, mode);
  };
  try {
    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      writeFileSync(join(sandboxRoot, TARGET_FILE), fixedContent, 'utf8');
      return result;
    });
    const wrappedResult = await wrapped(payload);
    return { wrappedResult, result, sessionDir, scope };
  } finally {
    __artifactTestHooks.writeExclusiveLeaf = previous;
  }
}

test('successful committed export creates exact patch, fixed bytes, and evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { candidateRecord, context, payload, scope, result, fixedContent } = buildExportFixtures({
      root,
      sessionDir,
      sandboxRoot,
      applyFixed: false,
    });

    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      writeFileSync(join(sandboxRoot, TARGET_FILE), fixedContent, 'utf8');
      return result;
    });
    const wrappedResult = await wrapped(payload);

    assert.equal(wrappedResult.status, 'committed');
    assert.equal(wrappedResult.artifactError, undefined);
    assert.equal(wrappedResult.artifacts.patch, 'artifacts/candidate.patch');
    assert.equal(wrappedResult.artifacts.fixed, `artifacts/fixed/${TARGET_FILE}`);
    assert.equal(wrappedResult.artifacts.evidence, 'artifacts/evidence.json');
    assert.match(wrappedResult.artifacts.transactionId, /^transaction-\d+-[a-f0-9]+$/);
    assert.equal(wrappedResult.artifacts.transactionDir.includes('/'), false);

    assert.equal(
      readFileSync(join(sessionDir, 'artifacts/candidate.patch'), 'utf8'),
      candidateRecord.diff,
    );
    assert.equal(
      readFileSync(join(sessionDir, `artifacts/fixed/${TARGET_FILE}`), 'utf8'),
      fixedContent,
    );

    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.sessionId, 'demo-artifacts');
    assert.equal(evidence.targetFile, TARGET_FILE);
    assert.equal(evidence.modelId, MODEL_ID);
    assert.equal(evidence.candidateHash, candidateRecord.candidateHash);
    assert.equal(evidence.diffHash, candidateRecord.diffHash);
    assert.equal(evidence.transactionId, wrappedResult.artifacts.transactionId);
    assert.equal(evidence.original.preimageSha256, context.checkpoints.original.fileSha256);
    assert.equal(evidence.sandbox.preimageSha256, scope.preApplySandboxHash);
    assert.equal(evidence.sandbox.preparePreimageSha256, context.checkpoints.sandbox.fileSha256);
    assert.equal(evidence.sandbox.postApplySha256, scope.expectedPostApplyHash);
    assert.equal(evidence.originalUnchangedAfterApply, true);
    assert.equal(evidence.originalUnchangedAfterRollback, null);
    assert.equal(evidence.sandboxRestored, null);
    assert.equal(evidence.verificationArtifactId, 'artifact-demo-1');
    assert.deepEqual(evidence.artifactPaths, {
      patch: 'artifacts/candidate.patch',
      fixed: `artifacts/fixed/${TARGET_FILE}`,
      evidence: 'artifacts/evidence.json',
    });
    assert.equal(readFileSync(join(root, TARGET_FILE), 'utf8'), '<div id="page">Home</div>\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope violation rejects before handler call for multi-unit apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);

    const candidateRecord = buildCandidateRecord(sandboxRoot);
    const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
    const payload = buildApplyPayload(sandboxRoot, candidateRecord);
    payload.units.push({ fixUnitId: 'unit-2', candidateHash: candidateRecord.candidateHash, diffHash: candidateRecord.diffHash });
    payload.candidates.push({ fixUnitId: 'unit-2', candidate: candidateRecord });

    let handlerCalled = false;
    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      handlerCalled = true;
      return { status: 'committed', transactionDir: join(sessionDir, 'transaction-1-abc'), written: [] };
    });

    await assert.rejects(
      () => wrapped(payload),
      (error) => error instanceof DemoArtifactError && error.code === 'DEMO_CANDIDATE_SCOPE_VIOLATION',
    );
    assert.equal(handlerCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scope violation rejects non-target edit files before handler call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    mkdirSync(join(sandboxRoot, 'src', 'partials'), { recursive: true });
    writeFileSync(join(sandboxRoot, 'src/partials/other.liquid'), '<div>other</div>\n');

    const candidateRecord = buildCandidateRecord(sandboxRoot, {
      relPath: 'src/partials/other.liquid',
      content: '<div>other</div>\n',
      oldText: '<div>other</div>',
      newText: '<div role="main">other</div>',
    });
    const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
    const payload = buildApplyPayload(sandboxRoot, candidateRecord);

    let handlerCalled = false;
    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      handlerCalled = true;
      return { status: 'committed' };
    });

    await assert.rejects(
      () => wrapped(payload),
      (error) => error instanceof DemoArtifactError && error.code === 'DEMO_CANDIDATE_SCOPE_VIOLATION',
    );
    assert.equal(handlerCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export failure after committed handler returns committed result with artifactError', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { wrappedResult, result } = await runCommittedExportWithHook({
      root,
      sessionDir,
      sandboxRoot,
      failAfterSuccessfulWrites: 0,
    });
    assert.equal(wrappedResult.status, 'committed');
    assert.equal(wrappedResult.artifactError, 'ARTIFACT_EXPORT_FAILED');
    assert.equal(wrappedResult.transactionDir, result.transactionDir);
    assert.equal(wrappedResult.artifacts, undefined);
    assertNoArtifactLeaves(sessionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial artifact export rolls back all created files and directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-external-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { wrappedResult, result } = await runCommittedExportWithHook({
      root,
      sessionDir,
      sandboxRoot,
      failAfterSuccessfulWrites: 1,
    });
    assert.equal(wrappedResult.status, 'committed');
    assert.equal(wrappedResult.artifactError, 'ARTIFACT_EXPORT_FAILED');
    assert.equal(wrappedResult.transactionDir, result.transactionDir);
    assert.equal(wrappedResult.artifacts, undefined);
    assertNoArtifactLeaves(sessionDir);
    assert.equal(readdirSync(externalDir).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects symlinked artifacts/fixed parent and writes nothing externally', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-external-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    symlinkSync(externalDir, join(sessionDir, 'artifacts', 'fixed'));
    const { context, payload, scope, result } = buildExportFixtures({ root, sessionDir, sandboxRoot });

    assert.throws(
      () => exportDemoArtifacts(context, payload, result, scope),
      (error) => error instanceof DemoArtifactError && error.code === 'SYMLINK_ARTIFACT_PARENT',
    );
    assert.equal(readdirSync(externalDir).length, 0);
    assertNoArtifactLeaves(sessionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects deeper symlinked artifact parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-external-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    mkdirSync(join(sessionDir, 'artifacts', 'fixed', 'src'), { recursive: true, mode: 0o700 });
    symlinkSync(externalDir, join(sessionDir, 'artifacts', 'fixed', 'src', 'pages'));
    const { context, payload, scope, result } = buildExportFixtures({ root, sessionDir, sandboxRoot });

    assert.throws(
      () => exportDemoArtifacts(context, payload, result, scope),
      (error) => error instanceof DemoArtifactError && error.code === 'SYMLINK_ARTIFACT_PARENT',
    );
    assert.equal(readdirSync(externalDir).length, 0);
    assertNoArtifactLeaves(sessionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test('noncommitted results pass through unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);

    const candidateRecord = buildCandidateRecord(sandboxRoot);
    const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
    const payload = buildApplyPayload(sandboxRoot, candidateRecord);
    const pending = { status: 'rolled-back', error: 'APPLY_FAILED' };

    const wrapped = createDemoApplyHandlerWrap(context)(async () => pending);
    const wrappedResult = await wrapped(payload);
    assert.deepEqual(wrappedResult, pending);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('underlying handler errors propagate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);

    const candidateRecord = buildCandidateRecord(sandboxRoot);
    const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
    const payload = buildApplyPayload(sandboxRoot, candidateRecord);

    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      const error = new Error('APPLY_FAILED');
      error.code = 'APPLY_FAILED';
      throw error;
    });

    await assert.rejects(
      () => wrapped(payload),
      (error) => error.code === 'APPLY_FAILED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects invalid transaction basename and outside-session paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);

    const candidateRecord = buildCandidateRecord(sandboxRoot);
    const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
    const payload = buildApplyPayload(sandboxRoot, candidateRecord);

    assert.throws(
      () => exportDemoArtifacts(context, payload, {
        status: 'committed',
        transactionDir: join(sessionDir, 'not-a-transaction'),
        written: [{ file: TARGET_FILE, postHash: hashFileContent('<div id="page" role="main">Home</div>\n') }],
      }),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_TRANSACTION',
    );

    assert.throws(
      () => exportDemoArtifacts(context, payload, {
        status: 'committed',
        transactionDir: join(root, 'scan-reports', 'fix-sessions', 'other-session', 'transaction-1700000000000-deadbeef'),
        written: [{ file: TARGET_FILE, postHash: hashFileContent('<div id="page">Home</div>\n') }],
      }),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_TRANSACTION',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects mismatched written hash and current sandbox bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, payload, scope } = buildExportFixtures({ root, sessionDir, sandboxRoot, applyFixed: false });
    const transactionDir = join(sessionDir, 'transaction-1700000000000-deadbeef');
    mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
    writeTransactionJournal(transactionDir, {
      file: TARGET_FILE,
      preHash: scope.preApplySandboxHash,
      postHash: hashFileContent('mismatch\n'),
      candidateHash: scope.candidateHash,
      diffHash: scope.diffHash,
    });

    assert.throws(
      () => exportDemoArtifacts(context, payload, {
        status: 'committed',
        transactionDir,
        written: [{ file: TARGET_FILE, postHash: hashFileContent('mismatch\n') }],
      }, scope),
      (error) => error instanceof DemoArtifactError && error.code === 'APPLY_RESULT_INCOHERENT',
    );
    assertNoArtifactLeaves(sessionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects symlinked fixed artifact destination leaf', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, payload, scope, result } = buildExportFixtures({ root, sessionDir, sandboxRoot });
    mkdirSync(join(sessionDir, 'artifacts', 'fixed', 'src', 'pages'), { recursive: true, mode: 0o700 });
    const leakTarget = join(sessionDir, 'leak.txt');
    writeFileSync(leakTarget, 'secret\n');
    symlinkSync(leakTarget, join(sessionDir, 'artifacts/fixed/src/pages/index.liquid'));

    assert.throws(
      () => exportDemoArtifacts(context, payload, result, scope),
      (error) => error instanceof DemoArtifactError && error.code === 'SYMLINK_DESTINATION',
    );
    assert.equal(readFileSync(leakTarget, 'utf8'), 'secret\n');
    assertNoArtifactLeaves(sessionDir, { ignoreFixedPath: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects pre-existing artifact leaves', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    writeFileSync(join(sessionDir, 'artifacts/candidate.patch'), 'existing patch\n', 'utf8');
    const { context, payload, scope, result } = buildExportFixtures({ root, sessionDir, sandboxRoot });

    assert.throws(
      () => exportDemoArtifacts(context, payload, result, scope),
      (error) => error instanceof DemoArtifactError && error.code === 'ARTIFACT_ALREADY_EXISTS',
    );
    assert.equal(readFileSync(join(sessionDir, 'artifacts/candidate.patch'), 'utf8'), 'existing patch\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readDemoEvidence and writeDemoEvidence reject malformed and symlink evidence files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-artifacts');
  try {
    mkdirSync(join(sessionDir, 'artifacts'), { recursive: true, mode: 0o700 });
    const evidencePath = join(sessionDir, 'artifacts/evidence.json');
    writeFileSync(evidencePath, '{not-json', 'utf8');
    assert.throws(
      () => readDemoEvidence(sessionDir),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_EVIDENCE',
    );

    writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 99 }), 'utf8');
    assert.throws(
      () => readDemoEvidence(sessionDir),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_EVIDENCE',
    );

    rmSync(evidencePath);
    const secret = join(sessionDir, 'secret.json');
    writeFileSync(secret, '{"schemaVersion":1}\n');
    symlinkSync(secret, evidencePath);
    assert.throws(
      () => readBoundedFileNoFollow(evidencePath, 4096),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_FILE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeDemoEvidence writes atomically with restrictive mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-artifacts');
  try {
    mkdirSync(join(sessionDir, 'artifacts'), { recursive: true, mode: 0o700 });
    const evidence = {
      schemaVersion: 1,
      sessionId: 'demo-artifacts',
      targetFile: TARGET_FILE,
      modelId: MODEL_ID,
      candidateHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      diffHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      transactionId: 'transaction-1700000000000-deadbeef',
      artifactPaths: {
        patch: 'artifacts/candidate.patch',
        fixed: `artifacts/fixed/${TARGET_FILE}`,
        evidence: 'artifacts/evidence.json',
      },
      original: {
        preimageSha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        afterApplySha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      sandbox: {
        preimageSha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        preparePreimageSha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        postApplySha256: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
      originalUnchangedAfterApply: true,
      originalUnchangedAfterRollback: null,
      sandboxRestored: null,
      verificationArtifactId: null,
    };
    writeDemoEvidence(sessionDir, evidence);
    const mode = statSync(join(sessionDir, 'artifacts/evidence.json')).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.deepEqual(readDemoEvidence(sessionDir), evidence);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence preimageSha256 reflects immediate pre-apply sandbox not stale prepare checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const stalePrepareHash = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const { candidateRecord, payload, scope, result, fixedContent } = buildExportFixtures({
      root,
      sessionDir,
      sandboxRoot,
      applyFixed: false,
    });
    const context = buildDemoContext({
      originalRoot: root,
      sandboxRoot,
      sessionDir,
      sandboxHash: stalePrepareHash,
    });
    assert.notEqual(scope.preApplySandboxHash, stalePrepareHash);

    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      writeFileSync(join(sandboxRoot, TARGET_FILE), fixedContent, 'utf8');
      return result;
    });
    const wrappedResult = await wrapped(payload);
    assert.equal(wrappedResult.artifactError, undefined);

    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.sandbox.preimageSha256, scope.preApplySandboxHash);
    assert.equal(evidence.sandbox.preparePreimageSha256, stalePrepareHash);
    assert.equal(evidence.candidateHash, candidateRecord.candidateHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export fails when committed handler writes bytes that do not match scoped candidate apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, payload, scope, result } = buildExportFixtures({
      root,
      sessionDir,
      sandboxRoot,
      applyFixed: false,
    });
    const wrongContent = '<div id="page" role="wrong">Home</div>\n';

    const wrapped = createDemoApplyHandlerWrap(context)(async () => {
      writeFileSync(join(sandboxRoot, TARGET_FILE), wrongContent, 'utf8');
      return result;
    });
    const wrappedResult = await wrapped(payload);

    assert.equal(wrappedResult.status, 'committed');
    assert.equal(wrappedResult.artifactError, 'ARTIFACT_EXPORT_FAILED');
    assert.equal(wrappedResult.artifacts, undefined);
    assertNoArtifactLeaves(sessionDir);
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), wrongContent);
    assert.notEqual(hashFileContent(wrongContent), scope.expectedPostApplyHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportDemoArtifacts rejects journal hashes that disagree with scoped apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, payload, scope, result } = buildExportFixtures({ root, sessionDir, sandboxRoot });
    const transactionDir = result.transactionDir;
    writeTransactionJournal(transactionDir, {
      file: TARGET_FILE,
      preHash: scope.preApplySandboxHash,
      postHash: hashFileContent('journal-mismatch\n'),
      candidateHash: scope.candidateHash,
      diffHash: scope.diffHash,
    });

    assert.throws(
      () => exportDemoArtifacts(context, payload, result, scope),
      (error) => error instanceof DemoArtifactError && error.code === 'JOURNAL_INCOHERENT',
    );
    assertNoArtifactLeaves(sessionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exclusive final-leaf write preserves concurrently created leaf and rolls back attempt artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const preExisting = 'pre-existing patch content\n';
    const previousBefore = __artifactTestHooks.beforeFinalLeafWrite;
    __artifactTestHooks.beforeFinalLeafWrite = (leafPath) => {
      if (leafPath.endsWith('candidate.patch')) {
        writeFileSync(leafPath, preExisting, { mode: 0o600, flag: 'wx' });
      }
    };
    try {
      const { wrappedResult } = await runCommittedExportWithHook({ root, sessionDir, sandboxRoot });
      assert.equal(wrappedResult.status, 'committed');
      assert.equal(wrappedResult.artifactError, 'ARTIFACT_EXPORT_FAILED');
      assert.equal(readFileSync(join(sessionDir, 'artifacts/candidate.patch'), 'utf8'), preExisting);
      assert.equal(existsSync(join(sessionDir, 'artifacts/evidence.json')), false);
      assert.equal(existsSync(join(sessionDir, `artifacts/fixed/${TARGET_FILE}`)), false);
    } finally {
      __artifactTestHooks.beforeFinalLeafWrite = previousBefore;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertDemoCandidateScope rejects oversized verification artifact id', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-artifacts-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const candidateRecord = buildCandidateRecord(sandboxRoot);
    candidateRecord.verification = {
      status: 'passed',
      artifactId: `artifact-${'x'.repeat(200)}`,
    };
    const context = buildDemoContext({ originalRoot: root, sandboxRoot, sessionDir });
    const payload = buildApplyPayload(sandboxRoot, candidateRecord);

    assert.throws(
      () => assertDemoCandidateScope(context, payload),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_VERIFICATION_ARTIFACT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisDemo passes apply handler wrap unless explicitly overridden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-orchestrator-wrap-'));
  try {
    writeProject(root);
    let trustedArgs = null;
    const report = {
      reportId: 'demo-report-fixture',
      pages: [{ findings: [{ findingId: 'sha256:demo', source: { file: TARGET_FILE, line: 1 } }] }],
    };

    await runCisDemo({
      originalRoot: root,
      targetFile: TARGET_FILE,
      sessionId: 'demo-wrap',
      route: '/',
      useUI: false,
    }, {
      prepareDemoSandbox: async () => ({
        originalRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'demo-wrap'),
        sandboxRoot: join(root, 'scan-reports', 'fix-sessions', 'demo-wrap', 'demo-workspace'),
        artifactsDir: join(root, 'scan-reports', 'fix-sessions', 'demo-wrap', 'artifacts'),
        targetFile: TARGET_FILE,
        checkpoints: {
          original: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          sandbox: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        copy: { fileCount: 1, totalBytes: 10 },
      }),
      runFreshSandboxScan: async () => ({ report }),
      runTrustedFixCli: async (options) => {
        trustedArgs = options;
        return { status: 'pending', reason: 'REVIEW_UI_PENDING' };
      },
    });

    assert.equal(typeof trustedArgs.applyHandlerWrap, 'function');
    const wrapped = trustedArgs.applyHandlerWrap(async () => ({ status: 'pending' }));
    assert.equal(typeof wrapped, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisDemo honors explicit applyHandlerWrap override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-orchestrator-wrap-'));
  try {
    writeProject(root);
    let trustedArgs = null;
    const report = {
      reportId: 'demo-report-fixture',
      pages: [{ findings: [{ findingId: 'sha256:demo', source: { file: TARGET_FILE, line: 1 } }] }],
    };
    const override = (handler) => handler;

    await runCisDemo({
      originalRoot: root,
      targetFile: TARGET_FILE,
      sessionId: 'demo-wrap-override',
      route: '/',
      useUI: false,
    }, {
      applyHandlerWrap: override,
      prepareDemoSandbox: async () => ({
        originalRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'demo-wrap-override'),
        sandboxRoot: join(root, 'scan-reports', 'fix-sessions', 'demo-wrap-override', 'demo-workspace'),
        artifactsDir: join(root, 'scan-reports', 'fix-sessions', 'demo-wrap-override', 'artifacts'),
        targetFile: TARGET_FILE,
        checkpoints: {
          original: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          sandbox: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        copy: { fileCount: 1, totalBytes: 10 },
      }),
      runFreshSandboxScan: async () => ({ report }),
      runTrustedFixCli: async (options) => {
        trustedArgs = options;
        return { status: 'pending', reason: 'REVIEW_UI_PENDING' };
      },
    });

    assert.equal(trustedArgs.applyHandlerWrap, override);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDemoRollbackHandler restores sandbox byte-exact and updates evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, result, fixedContent, originalPreApply } = prepareRollbackFixtures(root, sessionDir, sandboxRoot);
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), fixedContent);

    const rollback = createDemoRollbackHandler(context);
    const rollbackResult = await rollback({ transactionId: 'transaction-1700000000000-a1b2c3d4' });

    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), originalPreApply);
    assert.equal(readFileSync(join(root, TARGET_FILE), 'utf8'), originalPreApply);
    assert.equal(rollbackResult.sandboxRestored, true);
    assert.equal(rollbackResult.originalUnchangedAfterRollback, true);
    assert.equal(rollbackResult.restored[0].file, TARGET_FILE);

    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.sandboxRestored, true);
    assert.equal(evidence.originalUnchangedAfterRollback, true);
    assert.equal(evidence.sandbox.afterRollbackSha256, evidence.sandbox.preimageSha256);
    assert.equal(evidence.original.afterRollbackSha256, evidence.original.preimageSha256);
    assert.equal(existsSync(join(sessionDir, 'artifacts/candidate.patch')), true);
    assert.equal(existsSync(join(sessionDir, `artifacts/fixed/${TARGET_FILE}`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDemoRollbackHandler reports conflicts without overwriting concurrent edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-conflict-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, result, fixedContent } = prepareRollbackFixtures(root, sessionDir, sandboxRoot);
    writeFileSync(join(sandboxRoot, TARGET_FILE), 'user-edited-content\n', 'utf8');

    const rollback = createDemoRollbackHandler(context);
    await assert.rejects(
      () => rollback({ transactionId: 'transaction-1700000000000-a1b2c3d4' }),
      (error) => error instanceof DemoArtifactError && error.code === 'ROLLBACK_CONFLICTED',
    );
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), 'user-edited-content\n');
    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.sandboxRestored, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDemoRollbackHandler rejects invalid transaction id and symlink transaction dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-invalid-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context } = prepareRollbackFixtures(root, sessionDir, sandboxRoot);
    const rollback = createDemoRollbackHandler(context);

    await assert.rejects(
      () => rollback({ transactionId: '../outside' }),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_TRANSACTION',
    );

    const evilDir = join(sessionDir, 'evil-transaction');
    mkdirSync(evilDir, { recursive: true });
    symlinkSync(evilDir, join(sessionDir, 'transaction-1700000000000-evil1234'));
    await assert.rejects(
      () => rollback({ transactionId: 'transaction-1700000000000-evil1234' }),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_TRANSACTION',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDemoRollbackHandler detects original drift after restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-drift-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context } = prepareRollbackFixtures(root, sessionDir, sandboxRoot);
    writeFileSync(join(root, TARGET_FILE), '<div id="page">Changed original</div>\n', 'utf8');

    const rollback = createDemoRollbackHandler(context);
    await assert.rejects(
      () => rollback({ transactionId: 'transaction-1700000000000-a1b2c3d4' }),
      (error) => error instanceof DemoArtifactError && error.code === 'ROLLBACK_VERIFICATION_FAILED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDemoRollbackHandler recovers without evidence after ARTIFACT_EXPORT_FAILED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-recovery-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const {
      context,
      fixedContent,
      originalPreApply,
      transactionId,
      scope,
    } = prepareFailedExportRollbackFixtures(root, sessionDir, sandboxRoot);
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), fixedContent);

    const rollback = createDemoRollbackHandler(context);
    const rollbackResult = await rollback({ transactionId });

    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), originalPreApply);
    assert.equal(readFileSync(join(root, TARGET_FILE), 'utf8'), originalPreApply);
    assert.equal(rollbackResult.sandboxRestored, true);
    assert.equal(rollbackResult.originalUnchangedAfterRollback, true);

    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.modelId, null);
    assert.equal(evidence.artifactError, 'ARTIFACT_EXPORT_FAILED');
    assert.equal(evidence.sandboxRestored, true);
    assert.equal(evidence.originalUnchangedAfterRollback, true);
    assert.equal(evidence.candidateHash, scope.candidateHash);
    assert.equal(evidence.diffHash, scope.diffHash);
    assert.equal(evidence.sandbox.preimageSha256, scope.preApplySandboxHash);
    assert.deepEqual(evidence.artifactPaths, { evidence: 'artifacts/evidence.json' });
    assert.equal(existsSync(join(sessionDir, 'artifacts/candidate.patch')), false);
    assert.equal(existsSync(join(sessionDir, `artifacts/fixed/${TARGET_FILE}`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createDemoRollbackHandler fails closed on malformed existing evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-malformed-evidence-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, transactionId } = prepareFailedExportRollbackFixtures(root, sessionDir, sandboxRoot);
    writeFileSync(join(sessionDir, 'artifacts/evidence.json'), '{not-valid-json', { mode: 0o600 });

    const rollback = createDemoRollbackHandler(context);
    await assert.rejects(
      () => rollback({ transactionId }),
      (error) => error instanceof DemoArtifactError && error.code === 'INVALID_EVIDENCE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed export rollback succeeds through review state and API with recovery evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-state-api-'));
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root, 'rollback-state-api');
    const {
      context,
      originalPreApply,
      transactionId,
      scope,
    } = prepareFailedExportRollbackFixtures(root, sessionDir, sandboxRoot);

    const state = createReviewState({
      sessionDir,
      reportId: REPORT_ID,
      sessionId: 'rollback-state-api',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
      sandboxContext: { enabled: true, targetFile: TARGET_FILE },
    });
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = transactionId;
    state.raw.sandbox.artifactError = 'ARTIFACT_EXPORT_FAILED';
    persistReviewState(state);

    const rollbackHandler = createDemoRollbackHandler(context);
    const result = await state.rollbackSandboxTransaction(rollbackHandler);
    assert.equal(result.sandboxRestored, true);
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), originalPreApply);
    assert.equal(readFileSync(join(root, TARGET_FILE), 'utf8'), originalPreApply);

    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.artifactError, 'ARTIFACT_EXPORT_FAILED');
    assert.equal(evidence.candidateHash, scope.candidateHash);

    await assert.rejects(
      () => state.rollbackSandboxTransaction(rollbackHandler),
      (error) => error.name === 'ReviewStateError' && error.code === 'ROLLBACK_ALREADY_COMPLETED',
    );

    const server = await startReviewServer({ state, rollbackHandler });
    const replay = await fetch(`${server.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: server.token,
        origin: server.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'ROLLBACK_ALREADY_COMPLETED');
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback retries after evidence persistence failure when sandbox is already restored', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-evidence-retry-'));
  let persistAttempts = 0;
  const previousHook = __artifactTestHooks.beforePersistEvidenceAfterRollback;
  __artifactTestHooks.beforePersistEvidenceAfterRollback = () => {
    persistAttempts += 1;
    if (persistAttempts === 1) {
      throw new DemoArtifactError('EVIDENCE_TOO_LARGE', 'Simulated evidence persistence failure.');
    }
  };
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, fixedContent, originalPreApply, transactionId } = prepareFailedExportRollbackFixtures(
      root,
      sessionDir,
      sandboxRoot,
    );
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), fixedContent);

    const rollback = createDemoRollbackHandler(context);
    await assert.rejects(
      () => rollback({ transactionId }),
      (error) => error instanceof DemoArtifactError && error.code === 'EVIDENCE_TOO_LARGE',
    );
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), originalPreApply);
    assert.equal(existsSync(join(sessionDir, 'artifacts/evidence.json')), false);

    const retryResult = await rollback({ transactionId });
    assert.equal(retryResult.sandboxRestored, true);
    assert.equal(persistAttempts, 2);
    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.sandboxRestored, true);
    assert.equal(evidence.artifactError, 'ARTIFACT_EXPORT_FAILED');
  } finally {
    __artifactTestHooks.beforePersistEvidenceAfterRollback = previousHook;
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback evidence update keeps prior evidence when atomic rename fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-evidence-atomic-'));
  const previousRename = __artifactTestHooks.renameEvidenceLeaf;
  __artifactTestHooks.renameEvidenceLeaf = () => {
    throw new Error('simulated rename failure');
  };
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root);
    const { context, transactionId } = prepareRollbackFixtures(root, sessionDir, sandboxRoot);
    const beforeEvidence = readDemoEvidence(sessionDir);
    assert.equal(beforeEvidence.sandboxRestored, null);

    const rollback = createDemoRollbackHandler(context);
    await assert.rejects(
      () => rollback({ transactionId: 'transaction-1700000000000-a1b2c3d4' }),
      (error) => error instanceof Error && error.message === 'simulated rename failure',
    );

    const afterEvidence = readDemoEvidence(sessionDir);
    assert.deepEqual(afterEvidence, beforeEvidence);
    assert.equal(existsSync(join(sessionDir, 'artifacts/evidence.json')), true);
  } finally {
    __artifactTestHooks.renameEvidenceLeaf = previousRename;
    rmSync(root, { recursive: true, force: true });
  }
});

test('state rollback retry completes after handler evidence persistence failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-rollback-state-retry-'));
  let persistAttempts = 0;
  const previousHook = __artifactTestHooks.beforePersistEvidenceAfterRollback;
  __artifactTestHooks.beforePersistEvidenceAfterRollback = () => {
    persistAttempts += 1;
    if (persistAttempts === 1) {
      throw new DemoArtifactError('EVIDENCE_TOO_LARGE', 'Simulated evidence persistence failure.');
    }
  };
  try {
    const { sessionDir, sandboxRoot } = prepareSessionLayout(root, 'rollback-state-retry');
    const { context, originalPreApply, transactionId } = prepareFailedExportRollbackFixtures(
      root,
      sessionDir,
      sandboxRoot,
    );

    const state = createReviewState({
      sessionDir,
      reportId: REPORT_ID,
      sessionId: 'rollback-state-retry',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
      sandboxContext: { enabled: true, targetFile: TARGET_FILE },
    });
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = transactionId;
    state.raw.sandbox.artifactError = 'ARTIFACT_EXPORT_FAILED';
    persistReviewState(state);

    const rollbackHandler = createDemoRollbackHandler(context);
    await assert.rejects(
      () => state.rollbackSandboxTransaction(rollbackHandler),
      (error) => error.name === 'ReviewStateError' && error.code === 'ROLLBACK_VERIFICATION_FAILED',
    );
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, false);
    assert.equal(state.getSnapshot().sandbox.rollbackAvailable, true);
    assert.equal(state.raw.rollbackInFlight, false);
    assert.equal(readFileSync(join(sandboxRoot, TARGET_FILE), 'utf8'), originalPreApply);

    const result = await state.rollbackSandboxTransaction(rollbackHandler);
    assert.equal(result.sandboxRestored, true);
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, true);
    assert.equal(persistAttempts, 2);
    assert.equal(readDemoEvidence(sessionDir).sandboxRestored, true);
  } finally {
    __artifactTestHooks.beforePersistEvidenceAfterRollback = previousHook;
    rmSync(root, { recursive: true, force: true });
  }
});
