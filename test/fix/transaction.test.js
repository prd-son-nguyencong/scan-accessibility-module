import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { hashFileContent, validateAndBuildCandidate } from '../../src/fix/candidate/intent.js';
import { attachDiffToCandidate } from '../../src/fix/candidate/diff.js';
import { applyTransaction, applyBatchTransaction } from '../../src/fix/apply/transaction.js';
import { rollbackTransaction } from '../../src/fix/apply/rollback.js';
import { persistPassedVerificationArtifact } from './helpers/candidate-fixture.js';

function artifactIdFor(sessionDir, candidate) {
  return persistPassedVerificationArtifact(sessionDir, {
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
  });
}

const REPORT_ID = 'sha256:txn-report';

function writeFile(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function buildTwoFileCandidate(root) {
  writeFile(root, 'src/a.liquid', 'alpha\n');
  writeFile(root, 'src/b.liquid', 'beta\n');
  const contentA = readFileSync(join(root, 'src/a.liquid'), 'utf8');
  const contentB = readFileSync(join(root, 'src/b.liquid'), 'utf8');
  const preA = buildSourcePreimage(contentA, 1);
  const preB = buildSourcePreimage(contentB, 1);
  const candidate = validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: '1',
    edits: [
      {
        file: 'src/a.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: preA.preimageSha256,
        expectedFileSha256: hashFileContent(contentA),
        oldText: 'alpha',
        newText: 'alpha-fixed',
      },
      {
        file: 'src/b.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: preB.preimageSha256,
        expectedFileSha256: hashFileContent(contentB),
        oldText: 'beta',
        newText: 'beta-fixed',
      },
    ],
  });
  return attachDiffToCandidate(candidate);
}

test('forced second-file failure restores only transaction-owned bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-txn-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'txn');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidate = buildTwoFileCandidate(root);
    const originalA = readFileSync(join(root, 'src/a.liquid'), 'utf8');
    const originalB = readFileSync(join(root, 'src/b.liquid'), 'utf8');
    const result = await applyTransaction({
      localRoot: root,
      sessionDir,
      candidate,
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
      verificationArtifactId: artifactIdFor(sessionDir, candidate),
      failAfterWrite: 1,
    });
    assert.equal(result.status, 'rolled-back');
    assert.equal(readFileSync(join(root, 'src/a.liquid'), 'utf8'), originalA);
    assert.equal(readFileSync(join(root, 'src/b.liquid'), 'utf8'), originalB);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent user edit blocks apply without overwriting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-txn-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'txn');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    const candidate = buildTwoFileCandidate(root);
    const userEditedContent = 'user-edited\n';
    writeFileSync(join(root, 'src/a.liquid'), userEditedContent);
    await assert.rejects(
      () => applyTransaction({
        localRoot: root,
        sessionDir,
        candidate,
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash,
        verificationArtifactId: artifactIdFor(sessionDir, candidate),
      }),
      (error) => error.code === 'STALE_PREIMAGE',
    );
    assert.equal(readFileSync(join(root, 'src/a.liquid'), 'utf8'), userEditedContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transaction success writes files and journal excludes source bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-txn-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'txn');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    writeFile(root, 'src/a.liquid', 'alpha\n');
    const content = readFileSync(join(root, 'src/a.liquid'), 'utf8');
    const pre = buildSourcePreimage(content, 1);
    const candidate = attachDiffToCandidate(validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{
        file: 'src/a.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: pre.preimageSha256,
        expectedFileSha256: hashFileContent(content),
        oldText: 'alpha',
        newText: 'alpha-fixed',
      }],
    }));
    const result = await applyTransaction({
      localRoot: root,
      sessionDir,
      candidate,
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
      verificationArtifactId: artifactIdFor(sessionDir, candidate),
    });
    assert.equal(result.status, 'committed');
    assert.equal(readFileSync(join(root, 'src/a.liquid'), 'utf8'), 'alpha-fixed\n');
    const journal = readFileSync(join(result.transactionDir, 'journal.ndjson'), 'utf8');
    assert.doesNotMatch(journal, /alpha-fixed/);
    assert.equal(statSync(join(result.transactionDir, 'journal.ndjson')).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback conflict when concurrent edit after transaction write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-txn-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'txn');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    writeFile(root, 'src/a.liquid', 'alpha\n');
    const content = readFileSync(join(root, 'src/a.liquid'), 'utf8');
    const pre = buildSourcePreimage(content, 1);
    const candidate = attachDiffToCandidate(validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{
        file: 'src/a.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: pre.preimageSha256,
        expectedFileSha256: hashFileContent(content),
        oldText: 'alpha',
        newText: 'alpha-fixed',
      }],
    }));
    const failed = await applyTransaction({
      localRoot: root,
      sessionDir,
      candidate,
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
      verificationArtifactId: artifactIdFor(sessionDir, candidate),
      failAfterWrite: 0,
    });
    writeFileSync(join(root, 'src/a.liquid'), 'user-changed\n');
    const rollback = await rollbackTransaction({ localRoot: root, transactionDir: failed.transactionDir });
    assert.ok(rollback.conflicts.some((entry) => entry.reason === 'CONCURRENT_EDIT'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transaction module does not import legacy fixer rollback', () => {
  const txn = readFileSync(new URL('../../src/fix/apply/transaction.js', import.meta.url), 'utf8');
  const rb = readFileSync(new URL('../../src/fix/apply/rollback.js', import.meta.url), 'utf8');
  assert.doesNotMatch(txn, /fixer\/rollback/);
  assert.doesNotMatch(rb, /from ['"].*fixer\/rollback/);
});
