import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalUnifiedDiff } from '../../src/fix/candidate/diff.js';
import { hashFileContent, validateAndBuildCandidate } from '../../src/fix/candidate/intent.js';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import {
  getCandidateDiffView,
  parseUnifiedDiff,
  renderDiffContent,
  renderUnifiedDiff,
  resetCandidateDiffViewCacheForTests,
} from '../../src/fix/review/diff-view.js';
import { createMinimalDocument, collectText, findElements } from './helpers/minimal-dom.js';

const REPORT_ID = 'sha256:report-diff-view';
const POLICY_VERSION = '1';

function writeLiquid(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function buildCandidateWithDiff(root, edits) {
  const candidate = validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: POLICY_VERSION,
    promptVersion: 'p1',
    modelId: 'model-a',
    edits,
  });
  const diff = buildCanonicalUnifiedDiff(candidate);
  return { candidate, diff };
}

function editForFile(root, relPath, line, oldText, newText, content) {
  writeLiquid(root, relPath, content);
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

test('parseUnifiedDiff accepts canonical diff from buildCanonicalUnifiedDiff', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-diff-view-'));
  try {
    const content = '<select id="sort-select"></select>';
    const relPath = 'src/partials/jobs/sort.liquid';
    const edit = editForFile(
      root,
      relPath,
      1,
      '<select id="sort-select"></select>',
      '<select id="sort-select" aria-label="Sort"></select>',
      content,
    );
    const { diff } = buildCandidateWithDiff(root, [edit]);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.additions, 1);
    assert.equal(parsed.removals, 1);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].oldPath, relPath);
    assert.equal(parsed.files[0].newPath, relPath);
    const kinds = parsed.files[0].rows.map((row) => row.kind);
    assert.ok(kinds.includes('hunk'));
    assert.ok(kinds.includes('removed'));
    assert.ok(kinds.includes('added'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseUnifiedDiff parses multiple files with context and meta rows', () => {
  const patch = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,2 +1,2 @@',
    ' context-a',
    '-removed-a',
    '+added-a',
    '\\ No newline at end of file',
    '--- a/src/b.liquid',
    '+++ b/src/b.liquid',
    '@@ -2,1 +2,1 @@',
    '-old-b',
    '+new-b',
  ].join('\n') + '\n';
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.removals, 2);
  const fileA = parsed.files[0];
  assert.equal(fileA.oldPath, 'src/a.liquid');
  assert.deepEqual(
    fileA.rows.filter((row) => row.kind === 'context').map((row) => row.text),
    ['context-a'],
  );
  const meta = fileA.rows.find((row) => row.kind === 'meta');
  assert.ok(meta);
  assert.match(meta.text, /No newline at end of file/);
  const removed = fileA.rows.find((row) => row.kind === 'removed');
  const added = fileA.rows.find((row) => row.kind === 'added');
  assert.equal(removed.oldLine, 2);
  assert.equal(removed.newLine, null);
  assert.equal(added.oldLine, null);
  assert.equal(added.newLine, 2);
});

test('parseUnifiedDiff rejects malformed headers order and unknown rows', () => {
  assert.equal(parseUnifiedDiff('not a diff\n').ok, false);
  assert.equal(parseUnifiedDiff('+++ b/x\n--- a/x\n').ok, false);
  assert.equal(parseUnifiedDiff('--- a/x\n--- a/y\n').ok, false);
  const badHunk = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,1 +1,1 @@',
    '? mystery',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(badHunk).ok, false);
  assert.equal(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ bad @@\n').ok, false);
});

test('parseUnifiedDiff rejects hunk count inconsistencies', () => {
  const mismatch = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,2 +1,1 @@',
    '-only-one',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(mismatch).ok, false);
});

test('parseUnifiedDiff accepts prepend hunk @@ -0,0 +1,1 @@', () => {
  const patch = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -0,0 +1,1 @@',
    '+first-line',
  ].join('\n') + '\n';
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.removals, 0);
});

test('parseUnifiedDiff rejects start 0 when corresponding count is positive', () => {
  const badOldStart = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -0,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(badOldStart).ok, false);

  const badNewStart = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,1 +0,1 @@',
    '-old',
    '+new',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(badNewStart).ok, false);
});

test('parseUnifiedDiff rejects zero-count hunks with no changes', () => {
  const zeroZero = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -5,0 +5,0 @@',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(zeroZero).ok, false);

  const bothZeroExplicit = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,0 +1,0 @@',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(bothZeroExplicit).ok, false);
});

test('parseUnifiedDiff rejects traversal and absolute paths', () => {
  const traversal = [
    '--- a/../secret.liquid',
    '+++ b/../secret.liquid',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(traversal).ok, false);
  const absolute = [
    '--- a//etc/passwd',
    '+++ b//etc/passwd',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(absolute).ok, false);
});

test('parseUnifiedDiff enforces bounds and trailing newline', async () => {
  assert.equal(parseUnifiedDiff('').ok, false);
  assert.equal(parseUnifiedDiff(null).ok, false);
  assert.equal(parseUnifiedDiff('--- a/x\n+++ b/x\n').ok, false);
  const noTrailing = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n');
  assert.equal(parseUnifiedDiff(noTrailing).ok, false);

  const { MAX_DIFF_BYTES, MAX_DIFF_FILES, MAX_DIFF_ROWS, MAX_DIFF_PATH_CHARS, MAX_DIFF_ROW_TEXT_CHARS } = await import('../../src/fix/review/diff-view.js');
  const hugePath = 'src/' + 'a'.repeat(MAX_DIFF_PATH_CHARS);
  const hugeRow = [
    '--- a/' + hugePath,
    '+++ b/' + hugePath,
    '@@ -1,1 +1,1 @@',
    '-' + 'x'.repeat(MAX_DIFF_ROW_TEXT_CHARS + 1),
    '+y',
  ].join('\n') + '\n';
  assert.equal(parseUnifiedDiff(hugeRow).ok, false);

  const manyFiles = [];
  for (let i = 0; i <= MAX_DIFF_FILES; i += 1) {
    manyFiles.push(`--- a/src/file-${i}.liquid`, `+++ b/src/file-${i}.liquid`, '@@ -1,1 +1,1 @@', '-a', '+b');
  }
  assert.equal(parseUnifiedDiff(manyFiles.join('\n') + '\n').ok, false);

  const manyRows = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,' + (MAX_DIFF_ROWS + 1) + ' +1,' + (MAX_DIFF_ROWS + 1) + ' @@',
    ...Array.from({ length: MAX_DIFF_ROWS + 1 }, (_, index) => (index % 2 === 0 ? `-line-${index}` : `+line-${index}`)),
  ];
  assert.equal(parseUnifiedDiff(manyRows.join('\n') + '\n').ok, false);

  const oversized = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n'.padEnd(MAX_DIFF_BYTES + 2, 'x') + '\n';
  assert.equal(parseUnifiedDiff(oversized).ok, false);
});

test('parseUnifiedDiff returns frozen plain data', () => {
  const patch = [
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n') + '\n';
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.ok, true);
  assert.throws(() => { parsed.additions = 99; });
  assert.throws(() => { parsed.files[0].rows.push({}); });
  assert.throws(() => { parsed.files[0].rows[0].text = 'mutated'; });
});

test('parseUnifiedDiff malformed result is frozen with reason', () => {
  const parsed = parseUnifiedDiff('broken');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'MALFORMED_UNIFIED_DIFF');
  assert.throws(() => { parsed.reason = 'other'; });
});

function withMinimalDocument(run) {
  const previous = globalThis.document;
  globalThis.document = createMinimalDocument();
  try {
    return run();
  } finally {
    globalThis.document = previous;
  }
}

function sampleStructuredView() {
  return parseUnifiedDiff([
    '--- a/src/a.liquid',
    '+++ b/src/a.liquid',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
  ].join('\n') + '\n');
}

test('getCandidateDiffView caches parse results per candidate object', () => {
  resetCandidateDiffViewCacheForTests();
  const candidate = {
    diff: [
      '--- a/src/a.liquid',
      '+++ b/src/a.liquid',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n') + '\n',
  };
  const first = getCandidateDiffView(candidate);
  const second = getCandidateDiffView(candidate);
  assert.equal(first, second);
  assert.equal(first.ok, true);

  const replacement = { diff: candidate.diff };
  const replaced = getCandidateDiffView(replacement);
  assert.notEqual(replaced, first);
});

test('getCandidateDiffView keeps caching functional beyond 256 distinct candidates', () => {
  resetCandidateDiffViewCacheForTests();
  const candidates = Array.from({ length: 300 }, (_, index) => ({
    diff: [
      `--- a/src/file-${index}.liquid`,
      `+++ b/src/file-${index}.liquid`,
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n') + '\n',
  }));
  const views = candidates.map((candidate) => getCandidateDiffView(candidate));
  assert.ok(views.every((view) => view.ok));
  for (let index = 0; index < candidates.length; index += 1) {
    assert.equal(getCandidateDiffView(candidates[index]), views[index]);
  }
  assert.equal(getCandidateDiffView(candidates[257]), views[257]);
});

test('renderUnifiedDiff renders structured diff with semantic labels and escaped code text', () => {
  withMinimalDocument(() => {
    const parent = document.createElement('div');
    const view = sampleStructuredView();
    assert.equal(renderUnifiedDiff(parent, view), true);
    assert.match(collectText(parent), /1 addition\(s\), 1 removal\(s\)/);
    assert.match(collectText(parent), /src\/a\.liquid/);
    const addedMarkers = findElements(parent, (node) => node.className === 'diff-marker' && node.textContent === '+');
    assert.ok(addedMarkers.length >= 1);
    const hiddenAdded = findElements(parent, (node) => node.className === 'visually-hidden' && node.textContent === 'Added');
    assert.ok(hiddenAdded.length >= 1);
    const codeNodes = findElements(parent, (node) => node.tagName === 'CODE');
    assert.ok(codeNodes.some((node) => node.textContent === 'new'));
    assert.ok(codeNodes.some((node) => node.textContent === 'old'));
    const table = findElements(parent, (node) => node.className === 'diff-table')[0];
    assert.equal(table.getAttribute('role'), 'table');
  });
});

test('renderDiffContent falls back to raw canonical text for malformed view', () => {
  withMinimalDocument(() => {
    const parent = document.createElement('div');
    renderDiffContent(parent, {
      kind: 'candidate',
      text: '--- a/x\n+++ b/x\n',
      view: { ok: false, reason: 'MALFORMED_UNIFIED_DIFF' },
    });
    assert.match(collectText(parent), /Structured diff view unavailable/);
    const raw = findElements(parent, (node) => node.className === 'diff-raw')[0];
    assert.equal(raw.textContent, '--- a/x\n+++ b/x\n');
  });
});

test('renderDiffContent shows snapshot trim note when view was omitted', () => {
  withMinimalDocument(() => {
    const parent = document.createElement('div');
    renderDiffContent(parent, {
      kind: 'candidate',
      text: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n',
      view: null,
      viewTrimmed: true,
    });
    assert.match(collectText(parent), /omitted from this snapshot/);
    assert.match(collectText(parent), /exact canonical diff text/);
  });
});

test('renderDiffContent shows snapshot trim note from snapshotDiffTrimmed option', () => {
  withMinimalDocument(() => {
    const parent = document.createElement('div');
    renderDiffContent(parent, {
      kind: 'candidate',
      text: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n',
      view: null,
    }, { snapshotDiffTrimmed: true });
    assert.match(collectText(parent), /omitted from this snapshot/);
    assert.match(collectText(parent), /exact canonical diff text/);
  });
});

test('renderDiffContent handles null diff and empty candidate text safely', () => {
  withMinimalDocument(() => {
    const parent = document.createElement('div');
    renderDiffContent(parent, null);
    assert.equal(parent.childNodes.length, 0);
    renderDiffContent(parent, { kind: 'none', text: '', view: null });
    const raw = findElements(parent, (node) => node.className === 'diff-raw')[0];
    assert.equal(raw.textContent, '');
  });
});

test('renderDiffContent escapes HTML-like diff text via textContent', () => {
  withMinimalDocument(() => {
    const parent = document.createElement('div');
    const payload = '<script>alert(1)</script>\n';
    renderDiffContent(parent, {
      kind: 'candidate',
      text: payload,
      view: { ok: false, reason: 'MALFORMED_UNIFIED_DIFF' },
    });
    const raw = findElements(parent, (node) => node.className === 'diff-raw')[0];
    assert.equal(raw.textContent, payload);
    assert.equal(findElements(parent, (node) => node.tagName === 'SCRIPT').length, 0);
  });
});
