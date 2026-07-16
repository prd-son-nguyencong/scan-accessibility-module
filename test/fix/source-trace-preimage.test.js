import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { applyManualMapping, createSourceTraceInbox } from '../../src/fix/trace/inbox.js';

const REPORT_ID = 'sha256:report12345678901234567890123456789012345678901234567890123456789012';

function writeApplyPartial(root) {
  const dir = join(root, 'src', 'partials', 'jobs');
  mkdirSync(dir, { recursive: true });
  const content = [
    '<section>',
    '  <button id="apply">Apply</button>',
    '</section>',
    '',
  ].join('\n');
  const filePath = join(dir, 'apply.liquid');
  writeFileSync(filePath, content);
  const preimage = buildSourcePreimage(content, 2);
  return { file: 'src/partials/jobs/apply.liquid', line: 2, expectedPreimageSha256: preimage.preimageSha256, resolvedPath: filePath };
}

test('manual mapping recomputes preimage from file bytes and rejects caller-supplied hash spoofing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const result = applyManualMapping(inbox, {
      findingId: 'sha256:bound',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mapping.computedPreimageSha256, mapping.expectedPreimageSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping reads validated resolvedPath so symlink retargeting cannot redirect hash input', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    const decoyPath = join(root, 'src', 'partials', 'jobs', 'decoy.liquid');
    writeFileSync(decoyPath, '<button>Decoy</button>\n');
    const linkPath = join(root, 'src', 'partials', 'jobs', 'link.liquid');
    symlinkSync(mapping.resolvedPath, linkPath);

    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const first = applyManualMapping(inbox, {
      findingId: 'sha256:bound',
      file: 'src/partials/jobs/link.liquid',
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });
    assert.equal(first.ok, true);

    rmSync(linkPath);
    symlinkSync(decoyPath, linkPath);
    const second = applyManualMapping(inbox, {
      findingId: 'sha256:bound-2',
      file: 'src/partials/jobs/link.liquid',
      line: 1,
      expectedPreimageSha256: buildSourcePreimage('<button>Decoy</button>\n', 1).preimageSha256,
      reportId: REPORT_ID,
    });
    assert.equal(second.ok, true);
    assert.equal(second.mapping.computedPreimageSha256, second.mapping.expectedPreimageSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping rejects stale bytes against report-bound expected hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    writeFileSync(mapping.resolvedPath, '<button changed></button>\n');
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const result = applyManualMapping(inbox, {
      findingId: 'sha256:bound',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SOURCE_PREIMAGE_MISMATCH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping rejects wrong line against recomputed preimage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const result = applyManualMapping(inbox, {
      findingId: 'sha256:bound',
      file: mapping.file,
      line: 99,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SOURCE_PREIMAGE_MISMATCH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping fails closed when localRoot is missing', () => {
  const result = applyManualMapping(createSourceTraceInbox({
    reportId: REPORT_ID,
    localRoot: '/does-not-exist-root',
  }), {
    findingId: 'sha256:bound',
    file: 'src/a.liquid',
    line: 1,
    expectedPreimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    reportId: REPORT_ID,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'LOCAL_ROOT_MISSING');
});

test('idempotent manual remapping does not append duplicate audit events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-test');
    mkdirSync(sessionDir, { recursive: true });
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root, sessionDir });
    const input = {
      findingId: 'sha256:bound',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    };
    assert.equal(applyManualMapping(inbox, input).ok, true);
    assert.equal(applyManualMapping(inbox, input).ok, true);
    assert.equal(inbox.auditLog.length, 1);
    const lines = readFileSync(join(sessionDir, 'trace-audit.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit file is written before memory log and uses mode 0600 with directory 0700', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-perms');
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root, sessionDir });
    applyManualMapping(inbox, {
      findingId: 'sha256:bound',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });
    const auditPath = join(sessionDir, 'trace-audit.jsonl');
    assert.equal(statSync(sessionDir).mode & 0o777, 0o700);
    assert.equal(statSync(auditPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit append failure leaves manualMappings and memory audit unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-preimage-'));
  try {
    const mapping = writeApplyPartial(root);
    const blocked = join(root, 'blocked-file');
    writeFileSync(blocked, 'not-a-directory');
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root, sessionDir: blocked });
    const result = applyManualMapping(inbox, {
      findingId: 'sha256:bound',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AUDIT_PERSIST_FAILED');
    assert.equal(inbox.manualMappings.size, 0);
    assert.equal(inbox.auditLog.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
