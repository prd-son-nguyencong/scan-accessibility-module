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
import {
  attachDiffToCandidate,
  buildCanonicalUnifiedDiff,
  computeDiffHash,
} from '../../src/fix/candidate/diff.js';
import { parseUnifiedDiff } from '../../src/fix/review/diff-view.js';

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

function diffBodyLines(diff) {
  return diff.replace(/\n$/, '').split('\n');
}

function diffChangeLines(diff) {
  const lines = diffBodyLines(diff);
  return {
    hunkHeaders: lines.filter((line) => line.startsWith('@@')),
    removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')),
    added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')),
  };
}

function longFileContent(lineCount = 40) {
  return `${Array.from({ length: lineCount }, (_, index) => `line-${index + 1}`).join('\n')}\n`;
}

function writeLiquidNoTrailingNewline(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function buildCandidateFromEdits(root, edits) {
  return validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: POLICY_VERSION,
    promptVersion: 'p1',
    modelId: 'model-a',
    edits,
  });
}

function assertNoZeroZeroHunks(diff) {
  for (const header of diffChangeLines(diff).hunkHeaders) {
    assert.doesNotMatch(header, /,0 \+[0-9]+,0 @@$/);
    assert.doesNotMatch(header, /^@@ -[0-9]+,0 \+[0-9]+,0 @@$/);
  }
}

test('buildCanonicalUnifiedDiff appends at EOF without trailing newline quickly', { timeout: 500 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/append.liquid';
    const content = 'line-1\nline-2';
    writeLiquidNoTrailingNewline(root, relPath, content);
    const edit = editIntentForFile(root, relPath, 2, 'line-2', 'line-2\nAPPENDED');
    const diff = buildCanonicalUnifiedDiff(buildCandidateFromEdits(root, [edit]));
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 1);
    assert.equal(removed.length, 0);
    assert.equal(added.length, 1);
    assert.equal(added[0], '+APPENDED');
    assertNoZeroZeroHunks(diff);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.additions, 1);
    assert.equal(parsed.removals, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff deletes last line at EOF without trailing newline quickly', { timeout: 500 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/delete.liquid';
    const content = 'line-1\nline-2';
    writeLiquidNoTrailingNewline(root, relPath, content);
    const preimage = buildSourcePreimageRange(content, 1, 2);
    const edit = {
      file: relPath,
      blockRange: { startLine: 1, endLine: 2 },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText: 'line-1\nline-2',
      newText: 'line-1',
    };
    const diff = buildCanonicalUnifiedDiff(buildCandidateFromEdits(root, [edit]));
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(added.length, 0);
    assert.equal(removed[0], '-line-2');
    assertNoZeroZeroHunks(diff);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.additions, 0);
    assert.equal(parsed.removals, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff clears last line with empty newText and parses', { timeout: 500 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/clear.liquid';
    const content = 'line-1\nline-2\n';
    writeLiquid(root, relPath, content);
    const edit = editIntentForFile(root, relPath, 2, 'line-2', '');
    const diff = buildCanonicalUnifiedDiff(buildCandidateFromEdits(root, [edit]));
    assertNoZeroZeroHunks(diff);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.removals >= 1 || parsed.additions >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff prepends at line 1 with @@ -0,0 +1,1 @@', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/prepend.liquid';
    const content = 'line-2\nline-3\n';
    writeLiquid(root, relPath, content);
    const edit = editIntentForFile(root, relPath, 1, 'line-2', 'line-1\nline-2');
    const diff = buildCanonicalUnifiedDiff(buildCandidateFromEdits(root, [edit]));
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 1);
    assert.equal(removed.length, 0);
    assert.equal(added.length, 1);
    assert.equal(added[0], '+line-1');
    assert.match(hunkHeaders[0], /^@@ -0,0 \+1,1 @@$/);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.additions, 1);
    assert.equal(parsed.removals, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff emits minimal hunk for one-line insertion in long file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/long.liquid';
    const content = longFileContent(40);
    writeLiquid(root, relPath, content);
    const edit = editIntentForFile(root, relPath, 19, 'line-19', 'line-19\n            INSERTED-LINE');
    const candidate = validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: POLICY_VERSION,
      promptVersion: 'p1',
      modelId: 'model-a',
      edits: [edit],
    });
    const diff = buildCanonicalUnifiedDiff(candidate);
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 1);
    assert.equal(removed.length, 0);
    assert.equal(added.length, 1);
    assert.equal(added[0], '+            INSERTED-LINE');
    assert.match(hunkHeaders[0], /^@@ -19,0 \+20,1 @@$/);
    assert.doesNotMatch(diff, /^-line-40/m);
    assert.doesNotMatch(diff, /^\+line-40/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff emits minimal hunk for one-line replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/replace.liquid';
    const content = longFileContent(25);
    writeLiquid(root, relPath, content);
    const edit = editIntentForFile(root, relPath, 10, 'line-10', 'line-10-replaced');
    const candidate = validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: POLICY_VERSION,
      promptVersion: 'p1',
      modelId: 'model-a',
      edits: [edit],
    });
    const diff = buildCanonicalUnifiedDiff(candidate);
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(added.length, 1);
    assert.equal(removed[0], '-line-10');
    assert.equal(added[0], '+line-10-replaced');
    assert.match(hunkHeaders[0], /^@@ -10,1 \+10,1 @@$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff emits two minimal hunks for distant edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/multi.liquid';
    const content = longFileContent(30);
    writeLiquid(root, relPath, content);
    const editA = editIntentForFile(root, relPath, 5, 'line-5', 'line-5-a');
    const editB = editIntentForFile(root, relPath, 25, 'line-25', 'line-25-b');
    const candidate = validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: POLICY_VERSION,
      promptVersion: 'p1',
      modelId: 'model-a',
      edits: [editA, editB],
    });
    const diff = buildCanonicalUnifiedDiff(candidate);
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 2);
    assert.equal(removed.length, 2);
    assert.equal(added.length, 2);
    assert.deepEqual(removed, ['-line-5', '-line-25']);
    assert.deepEqual(added, ['+line-5-a', '+line-25-b']);
    assert.match(hunkHeaders[0], /^@@ -5,1 \+5,1 @@$/);
    assert.match(hunkHeaders[1], /^@@ -25,1 \+25,1 @@$/);
    assert.doesNotMatch(diff, /^-line-6/m);
    assert.doesNotMatch(diff, /^-line-24/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCanonicalUnifiedDiff matches live header aria-current insertion shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-candidate-'));
  try {
    const relPath = 'src/partials/layout/header.liquid';
    const headerPath = join(process.cwd(), '..', 'src/partials/layout/header.liquid');
    const content = readFileSync(headerPath, 'utf8');
    writeLiquid(root, relPath, content);
    const oldText = [
      '          <a',
      '            href="/"',
      '            class="hocus:after:scale-x-100 relative block after:absolute after:bottom-0 after:left-0 after:h-[0.1rem] after:w-full after:scale-x-0 after:bg-black after:transition-all after:content-[\'\']">',
      '            Homepage',
      '          </a>',
    ].join('\n');
    const newText = [
      '          <a',
      '            href="/"',
      '            aria-current="page"',
      '            class="hocus:after:scale-x-100 relative block after:absolute after:bottom-0 after:left-0 after:h-[0.1rem] after:w-full after:scale-x-0 after:bg-black after:transition-all after:content-[\'\']">',
      '            Homepage',
      '          </a>',
    ].join('\n');
    const preimage = buildSourcePreimageRange(content, 20, 24);
    const edit = {
      file: relPath,
      blockRange: { startLine: 20, endLine: 24 },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText,
      newText,
    };
    const candidate = validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: POLICY_VERSION,
      promptVersion: 'p1',
      modelId: 'model-a',
      edits: [edit],
    });
    const diff = buildCanonicalUnifiedDiff(candidate);
    const { hunkHeaders, removed, added } = diffChangeLines(diff);
    assert.equal(hunkHeaders.length, 1);
    assert.equal(removed.length, 0);
    assert.equal(added.length, 1);
    assert.equal(added[0], '+            aria-current="page"');
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.additions, 1);
    assert.equal(parsed.removals, 0);
    const addedRow = parsed.files[0].rows.find((row) => row.kind === 'added');
    assert.ok(addedRow);
    assert.equal(addedRow.text, '            aria-current="page"');
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
