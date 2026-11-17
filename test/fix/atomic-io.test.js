import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
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
import {
  __transactionTestHooks,
  writeAtomicFile,
} from '../../src/fix/apply/transaction.js';
import {
  __rollbackTestHooks,
  atomicRestore,
} from '../../src/fix/apply/rollback.js';
import { createReviewState, persistReviewState } from '../../src/fix/review/state.js';

function tempArtifacts(dir) {
  return readdirSync(dir).filter((name) => name.includes('.tmp') || name.includes('.rollback'));
}

test('writeAtomicFile removes temp file when rename fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-atomic-write-'));
  const rel = 'src/a.liquid';
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'before\n');
  const previous = __transactionTestHooks.renameSync;
  __transactionTestHooks.renameSync = () => {
    throw Object.assign(new Error('rename failed'), { code: 'EACCES' });
  };
  try {
    assert.throws(
      () => writeAtomicFile(target, Buffer.from('after\n'), 0o644),
      (error) => error.code === 'EACCES',
    );
    assert.equal(readFileSync(target, 'utf8'), 'before\n');
    assert.equal(tempArtifacts(dirname(target)).length, 0);
  } finally {
    __transactionTestHooks.renameSync = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicRestore removes rollback temp when rename fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-atomic-restore-'));
  const target = join(root, 'src/a.liquid');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'changed\n');
  const previous = __rollbackTestHooks.renameSync;
  __rollbackTestHooks.renameSync = () => {
    throw Object.assign(new Error('rename failed'), { code: 'EACCES' });
  };
  try {
    assert.throws(
      () => atomicRestore(target, Buffer.from('restored\n'), 0o644),
      (error) => error.code === 'EACCES',
    );
    assert.equal(tempArtifacts(dirname(target)).length, 0);
  } finally {
    __rollbackTestHooks.renameSync = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
