import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { buildFixUnits } from '../../src/fix/canonical/fix-unit.js';
import {
  applyManualMapping,
  buildEditorDeepLink,
  createSourceTraceInbox,
  mergeTraceEvidence,
  traceAllFindings,
} from '../../src/fix/trace/inbox.js';

const REPORT_ID = 'sha256:report12345678901234567890123456789012345678901234567890123456789012';

function writeApplyPartial(root) {
  const dir = join(root, 'src', 'partials', 'jobs');
  mkdirSync(dir, { recursive: true });
  const content = '<button id="apply">Apply</button>\n';
  writeFileSync(join(dir, 'apply.liquid'), content);
  return {
    file: 'src/partials/jobs/apply.liquid',
    line: 1,
    expectedPreimageSha256: buildSourcePreimage(content, 1).preimageSha256,
  };
}

function unresolvedFinding() {
  return {
    findingId: 'sha256:unresolved',
    nativeRuleId: 'button-name',
    canonicalRuleId: 'button-name',
    layer: 'axe',
    category: 'accessibility',
    pageState: 'initial',
    route: '/',
    element: {
      selector: '#apply-btn',
      normalizedHtmlHash: 'sha256:btn-dom',
    },
    source: {
      file: null,
      line: null,
      confidence: 'none',
      method: 'unresolved',
      preimageSha256: null,
    },
    evidence: {
      message: 'Buttons must have discernible text.',
      observations: [{ layer: 'axe', nativeRuleId: 'button-name' }],
    },
  };
}

function tracedFinding() {
  return {
    findingId: 'sha256:traced',
    nativeRuleId: 'select-name',
    canonicalRuleId: 'select-name',
    layer: 'axe',
    category: 'accessibility',
    pageState: 'initial',
    route: '/',
    element: {
      selector: '#sort-select',
      normalizedHtmlHash: 'sha256:dom-sort',
    },
    source: {
      file: 'src/partials/jobs/sort.liquid',
      line: 12,
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    evidence: {
      message: 'Select element must have an accessible name.',
      observations: [{ layer: 'axe', nativeRuleId: 'select-name' }],
    },
  };
}

test('bulk tracing returns candidate partials with confidence', () => {
  const inbox = createSourceTraceInbox({
    reportId: REPORT_ID,
    localRoot: '/repo',
    candidates: [
      {
        findingId: 'sha256:unresolved',
        partials: [
          {
            file: 'src/partials/jobs/apply.liquid',
            line: 8,
            confidence: 'medium',
            method: 'hint-search',
          },
        ],
      },
    ],
  });

  const traced = traceAllFindings(inbox, [unresolvedFinding()]);
  assert.equal(traced.length, 1);
  assert.equal(traced[0].partials[0].confidence, 'medium');
});

test('manual mapping persists an append-only audit event bound to report and source hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    const mapping = writeApplyPartial(root);
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const result = applyManualMapping(inbox, {
      findingId: 'sha256:unresolved',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });

    assert.equal(result.ok, true);
    assert.equal(result.auditEvent.type, 'manual_source_mapping');
    assert.equal(result.auditEvent.reportId, REPORT_ID);
    assert.equal(result.auditEvent.expectedPreimageSha256, mapping.expectedPreimageSha256);
    assert.equal(result.auditEvent.computedPreimageSha256, mapping.expectedPreimageSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping requires expected source preimage binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    const mapping = writeApplyPartial(root);
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const missing = applyManualMapping(inbox, {
      findingId: 'sha256:unresolved',
      file: mapping.file,
      line: mapping.line,
      reportId: REPORT_ID,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'EXPECTED_PREIMAGE_REQUIRED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale report hash rejects manual mapping', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    const mapping = writeApplyPartial(root);
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const result = applyManualMapping(inbox, {
      findingId: 'sha256:unresolved',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: 'sha256:stale',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REPORT_HASH_MISMATCH');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous manual mappings fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    const mapping = writeApplyPartial(root);
    const otherContent = '<button id="other">Other</button>\n';
    writeFileSync(join(root, 'src', 'partials', 'jobs', 'other.liquid'), otherContent);
    const otherExpected = buildSourcePreimage(otherContent, 1).preimageSha256;
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    assert.equal(applyManualMapping(inbox, {
      findingId: 'sha256:unresolved',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    }).ok, true);

    const second = applyManualMapping(inbox, {
      findingId: 'sha256:unresolved',
      file: 'src/partials/jobs/other.liquid',
      line: 1,
      expectedPreimageSha256: otherExpected,
      reportId: REPORT_ID,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'AMBIGUOUS_MAPPING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping rejects missing findingId, file, line, or expected preimage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    const mapping = writeApplyPartial(root);
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });
    const cases = [
      { findingId: '', file: mapping.file, line: 1, expectedPreimageSha256: mapping.expectedPreimageSha256 },
      { findingId: 'sha256:x', file: '', line: 1, expectedPreimageSha256: mapping.expectedPreimageSha256 },
      { findingId: 'sha256:x', file: mapping.file, line: 0, expectedPreimageSha256: mapping.expectedPreimageSha256 },
      { findingId: 'sha256:x', file: mapping.file, line: 1, expectedPreimageSha256: '' },
    ];
    for (const input of cases) {
      const result = applyManualMapping(inbox, { ...input, reportId: REPORT_ID });
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.ok(['INVALID_MAPPING_INPUT', 'EXPECTED_PREIMAGE_REQUIRED'].includes(result.reason));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merge trace evidence into an existing canonical unit', () => {
  const units = buildFixUnits([tracedFinding()]);
  const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: '/repo' });
  const merged = mergeTraceEvidence(units[0], {
    layer: 'accessScan',
    nativeRuleId: 'select-name',
    message: 'Select is missing an accessible name.',
    source: tracedFinding().source,
  }, inbox);

  assert.equal(merged.evidence.some((item) => item.layer === 'accessScan'), true);
});

test('editor deep links include file and line when localRoot exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    mkdirSync(join(root, 'src', 'partials', 'jobs'), { recursive: true });
    writeFileSync(join(root, 'src', 'partials', 'jobs', 'sort.liquid'), '<select></select>\n');
    const link = buildEditorDeepLink({
      localRoot: root,
      file: 'src/partials/jobs/sort.liquid',
      line: 1,
      editor: 'vscode',
    });
    assert.match(link, /^vscode:\/\/file/);
    assert.match(link, /sort\.liquid:1$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping rejects paths outside localRoot or through symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-guard-'));
  const outside = mkdtempSync(join(tmpdir(), 'ada-trace-out-'));
  try {
    writeApplyPartial(root);
    writeFileSync(join(outside, 'secret.liquid'), '<button>Outside</button>\n');
    symlinkSync(outside, join(root, 'escape-link'));
    const expected = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const inbox = createSourceTraceInbox({ reportId: REPORT_ID, localRoot: root });

    const outsideResult = applyManualMapping(inbox, {
      findingId: 'sha256:outside',
      file: join(outside, 'secret.liquid'),
      line: 1,
      expectedPreimageSha256: expected,
      reportId: REPORT_ID,
    });
    assert.equal(outsideResult.ok, false);
    assert.equal(outsideResult.reason, 'PATH_OUTSIDE_LOCAL_ROOT');

    const symlinkResult = applyManualMapping(inbox, {
      findingId: 'sha256:symlink',
      file: 'escape-link/secret.liquid',
      line: 1,
      expectedPreimageSha256: expected,
      reportId: REPORT_ID,
    });
    assert.equal(symlinkResult.ok, false);
    assert.equal(symlinkResult.reason, 'PATH_OUTSIDE_LOCAL_ROOT');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('audit log persists append-only to session directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-'));
  try {
    const mapping = writeApplyPartial(root);
    const sessionDir = join(root, 'session');
    const inbox = createSourceTraceInbox({
      reportId: REPORT_ID,
      localRoot: root,
      sessionDir,
    });
    applyManualMapping(inbox, {
      findingId: 'sha256:unresolved',
      file: mapping.file,
      line: mapping.line,
      expectedPreimageSha256: mapping.expectedPreimageSha256,
      reportId: REPORT_ID,
    });

    const auditPath = join(sessionDir, 'trace-audit.jsonl');
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).type, 'manual_source_mapping');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
