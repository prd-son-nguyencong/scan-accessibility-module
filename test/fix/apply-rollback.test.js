import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashFileBytes } from '../../src/fix/candidate/intent.js';
import { restoreTransactionFiles } from '../../src/fix/apply/rollback.js';

const TARGET_FILE = 'src/pages/index.liquid';

function writeJournal(transactionDir, { file, preHash, postHash }) {
  const lines = [
    JSON.stringify({
      action: 'begin',
      entries: [{ fixUnitId: 'unit-1', candidateHash: preHash, diffHash: postHash, verificationArtifactId: 'artifact-1' }],
      files: [file],
    }),
    JSON.stringify({ action: 'write', file, preHash, postHash }),
    JSON.stringify({ action: 'commit', files: [file] }),
  ];
  writeFileSync(join(transactionDir, 'journal.ndjson'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

function writeSnapshot(transactionDir, file, content) {
  const snapshotPath = join(transactionDir, 'snapshots', file);
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  writeFileSync(snapshotPath, content, { mode: 0o600 });
}

function prepareRestoreLayout(root) {
  const localRoot = join(root, 'workspace');
  const transactionDir = join(root, 'transaction-1700000000000-abcd1234');
  mkdirSync(join(localRoot, 'src', 'pages'), { recursive: true });
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  const preContent = '<div id="page">Home</div>\n';
  const postContent = '<div id="page" role="main">Home</div>\n';
  const preHash = hashFileBytes(Buffer.from(preContent, 'utf8'));
  const postHash = hashFileBytes(Buffer.from(postContent, 'utf8'));
  writeSnapshot(transactionDir, TARGET_FILE, preContent);
  writeJournal(transactionDir, { file: TARGET_FILE, preHash, postHash });
  writeFileSync(join(localRoot, TARGET_FILE), postContent, 'utf8');
  return { localRoot, transactionDir, preContent, postContent, preHash, postHash };
}

test('restoreTransactionFiles treats pre-hash match as already restored without overwrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-apply-rollback-idempotent-'));
  try {
    const { localRoot, transactionDir, preContent, preHash } = prepareRestoreLayout(root);
    writeFileSync(join(localRoot, TARGET_FILE), preContent, 'utf8');

    const result = await restoreTransactionFiles({ localRoot, transactionDir });
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.restored.length, 1);
    assert.equal(result.restored[0].alreadyRestored, true);
    assert.equal(result.restored[0].restoredHash, preHash);
    assert.equal(readFileSync(join(localRoot, TARGET_FILE), 'utf8'), preContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoreTransactionFiles retry after successful restore remains conflict-free', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-apply-rollback-retry-'));
  try {
    const { localRoot, transactionDir, preContent } = prepareRestoreLayout(root);

    const first = await restoreTransactionFiles({ localRoot, transactionDir });
    assert.equal(first.conflicts.length, 0);
    assert.equal(first.restored[0].alreadyRestored, undefined);
    assert.equal(readFileSync(join(localRoot, TARGET_FILE), 'utf8'), preContent);

    const second = await restoreTransactionFiles({ localRoot, transactionDir });
    assert.equal(second.conflicts.length, 0);
    assert.equal(second.restored[0].alreadyRestored, true);
    assert.equal(readFileSync(join(localRoot, TARGET_FILE), 'utf8'), preContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restoreTransactionFiles still reports concurrent edit when bytes differ from post-hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-apply-rollback-conflict-'));
  try {
    const { localRoot, transactionDir } = prepareRestoreLayout(root);
    writeFileSync(join(localRoot, TARGET_FILE), '<div>user edit</div>\n', 'utf8');

    const result = await restoreTransactionFiles({ localRoot, transactionDir });
    assert.equal(result.restored.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].reason, 'CONCURRENT_EDIT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
