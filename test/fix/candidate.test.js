import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage, buildSourcePreimageRange } from '../../src/tracer/preimage.js';
import {
  CandidateIntentError,
  applyEditToText,
  computeCandidateHash,
  hashFileContent,
  validateAndBuildCandidate,
} from '../../src/fix/candidate/intent.js';
import { attachDiffToCandidate, computeDiffHash } from '../../src/fix/candidate/diff.js';

const REPORT_ID = 'sha256:report-test';
const POLICY_VERSION = '1';

function writeLiquid(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function editIntentForFile(root, relPath, line, oldText, newText) {
  const content = readFileSync(join(root, relPath), 'utf8');
  const preimage = buildSourcePreimage(content, line);
  return {
    file: relPath,
    blockRange: { startLine: line, endLine: line },
    expectedBlockSha256: preimage.preimageSha256,
    expectedFileSha256: hashFileContent(content),
    oldText,
    newText,
  };
}

function buildCandidate(root, edits, extra = {}) {
  const candidate = validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: POLICY_VERSION,
    promptVersion: 'p1',
    modelId: 'model-a',
    edits,
    ...extra,
  });
  return attachDiffToCandidate(candidate);
}

test('validateAndBuildCandidate rejects stale preimage hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', '<button id="apply">Apply</button>\n');
    const edit = editIntentForFile(root, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    edit.expectedFileSha256 = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    assert.throws(
      () => buildCandidate(root, [edit]),
      (error) => error instanceof CandidateIntentError && error.code === 'STALE_PREIMAGE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateAndBuildCandidate rejects non-unique old text', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', '<span>x</span>\n<span>x</span>\n');
    const edit = editIntentForFile(root, 'src/a.liquid', 1, 'x', 'y');
    edit.blockRange = { startLine: 1, endLine: 2 };
    const content = readFileSync(join(root, 'src/a.liquid'), 'utf8');
    edit.expectedBlockSha256 = buildSourcePreimageRange(content, 1, 2).preimageSha256;
    assert.throws(
      () => buildCandidate(root, [edit]),
      (error) => error instanceof CandidateIntentError && error.code === 'NON_UNIQUE_OLD_TEXT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateAndBuildCandidate rejects overlapping edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', '<button id="apply">Apply</button>\n');
    const editA = editIntentForFile(root, 'src/a.liquid', 1, '<button id="apply">Apply</button>', '<button id="apply" aria-label="Apply">Apply</button>');
    const editB = editIntentForFile(root, 'src/a.liquid', 1, 'Apply', 'Submit');
    assert.throws(
      () => buildCandidate(root, [editA, editB]),
      (error) => error instanceof CandidateIntentError && error.code === 'OVERLAPPING_EDITS',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateAndBuildCandidate rejects unsupported extension and traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', 'ok\n');
    const badExt = editIntentForFile(root, 'src/a.liquid', 1, 'ok', 'ok2');
    badExt.file = 'src/a.exe';
    assert.throws(
      () => buildCandidate(root, [badExt]),
      (error) => error instanceof CandidateIntentError && error.code === 'UNSUPPORTED_EXTENSION',
    );
    const traversal = editIntentForFile(root, 'src/a.liquid', 1, 'ok', 'ok2');
    traversal.file = '../outside.liquid';
    assert.throws(
      () => buildCandidate(root, [traversal]),
      (error) => error instanceof CandidateIntentError && error.code === 'PATH_TRAVERSAL',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateAndBuildCandidate rejects symlink escape', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  const outside = mkdtempSync(join(tmpdir(), 'ada-outside-'));
  try {
    writeLiquid(outside, 'secret.liquid', 'secret\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    symlinkSync(join(outside, 'secret.liquid'), join(root, 'src/link.liquid'));
    const edit = {
      file: 'src/link.liquid',
      blockRange: { startLine: 1, endLine: 1 },
      expectedBlockSha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      expectedFileSha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      oldText: 'secret',
      newText: 'other',
    };
    assert.throws(
      () => buildCandidate(root, [edit]),
      (error) => error instanceof CandidateIntentError && (error.code === 'SYMLINK_ESCAPE' || error.code === 'PATH_TRAVERSAL'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('candidate and diff hashes change when edit metadata changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', '<button id="apply">Apply</button>\n');
    const edit = editIntentForFile(root, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    const first = buildCandidate(root, [edit]);
    const second = buildCandidate(root, [edit], { modelId: 'model-b' });
    assert.notEqual(first.candidateHash, second.candidateHash);
    assert.notEqual(first.diffHash, second.diffHash);
    assert.equal(computeDiffHash(first.candidateHash, first.diff), first.diffHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyEditToText enforces recorded preimage at offsets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', '<button id="apply">Apply</button>\n');
    const edit = editIntentForFile(root, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    const candidate = buildCandidate(root, [edit]);
    const updated = applyEditToText(readFileSync(join(root, 'src/a.liquid'), 'utf8'), candidate.edits[0]);
    assert.match(updated, /aria-label="Apply"/);
    assert.throws(
      () => applyEditToText('changed on disk', candidate.edits[0]),
      (error) => error instanceof CandidateIntentError && error.code === 'STALE_PREIMAGE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deterministic candidate hash for ordered intents', () => {
  const edits = [{
    file: 'src/a.liquid',
    blockRange: { startLine: 1, endLine: 1 },
    expectedBlockSha256: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    expectedFileSha256: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    oldText: 'a',
    newText: 'b',
  }];
  const one = computeCandidateHash({ reportId: REPORT_ID, policyVersion: POLICY_VERSION, promptVersion: 'p', modelId: 'm', edits });
  const two = computeCandidateHash({ reportId: REPORT_ID, policyVersion: POLICY_VERSION, promptVersion: 'p', modelId: 'm', edits: [...edits].reverse() });
  assert.equal(one, two);
});

test('validateAndBuildCandidate rejects oldText outside declared block range', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', 'prefix\n<button id="apply">Apply</button>\r\n');
    const content = readFileSync(join(root, 'src/a.liquid'), 'utf8');
    const edit = editIntentForFile(root, 'src/a.liquid', 2, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    edit.blockRange = { startLine: 2, endLine: 2 };
    edit.oldText = 'prefix';
    edit.expectedBlockSha256 = buildSourcePreimage(content, 2).preimageSha256;
    assert.throws(
      () => buildCandidate(root, [edit]),
      (error) => error instanceof CandidateIntentError && error.code === 'OLD_TEXT_OUTSIDE_BLOCK',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateAndBuildCandidate applies CRLF edits using UTF-8 byte offsets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', 'alpha\r\nbeta\r\n');
    const edit = editIntentForFile(root, 'src/a.liquid', 1, 'alpha', 'alpha-fixed');
    const candidate = buildCandidate(root, [edit]);
    const updated = applyEditToText(readFileSync(join(root, 'src/a.liquid'), 'utf8'), candidate.edits[0]);
    assert.match(updated, /alpha-fixed\r\nbeta/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateAndBuildCandidate applies unicode edits before oldText using byte offsets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    writeLiquid(root, 'src/a.liquid', 'café\n<button>Go</button>\n');
    const edit = editIntentForFile(root, 'src/a.liquid', 2, '<button>', '<button aria-label="Go">');
    const candidate = buildCandidate(root, [edit]);
    const updated = applyEditToText(readFileSync(join(root, 'src/a.liquid'), 'utf8'), candidate.edits[0]);
    assert.match(updated, /aria-label="Go"/);
    assert.match(updated, /^café/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate module does not import legacy fixer rollback', async () => {
  const intentSource = readFileSync(new URL('../../src/fix/candidate/intent.js', import.meta.url), 'utf8');
  const diffSource = readFileSync(new URL('../../src/fix/candidate/diff.js', import.meta.url), 'utf8');
  assert.doesNotMatch(intentSource, /fixer\/rollback/);
  assert.doesNotMatch(diffSource, /fixer\/rollback/);
});
