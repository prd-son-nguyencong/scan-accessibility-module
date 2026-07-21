import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import {
  loadManualMappingsFromTraceAudit,
  TraceAuditError,
} from '../../src/fix/review/trace-audit.js';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

const PREIMAGE = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PREIMAGE_OTHER = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function localReport() {
  return buildScanReportV2(baseFixture.scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://localhost:1234/',
      buildRevision: 'git:abc123',
      instrumentationDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
}

function manualMappingEvent({
  reportId,
  findingId,
  file = 'src/partials/jobs/sort.liquid',
  line = 12,
  preimage = PREIMAGE,
} = {}) {
  return {
    type: 'manual_source_mapping',
    reportId,
    findingId,
    file,
    line,
    expectedPreimageSha256: preimage,
    computedPreimageSha256: preimage,
  };
}

test('trace-audit replay accepts idempotent duplicate manual_source_mapping events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-audit-'));
  try {
    const report = localReport();
    const findingId = report.pages[0].findings[0].findingId;
    const sessionDir = join(root, 'session');
    mkdirSync(sessionDir, { recursive: true });
    const event = manualMappingEvent({ reportId: report.reportId, findingId });
    writeFileSync(
      join(sessionDir, 'trace-audit.jsonl'),
      `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );

    const mappings = loadManualMappingsFromTraceAudit(sessionDir, {
      reportId: report.reportId,
      knownFindingIds: new Set([findingId]),
    });
    assert.equal(Object.keys(mappings).length, 1);
    assert.equal(mappings[findingId].file, 'src/partials/jobs/sort.liquid');
    assert.equal(mappings[findingId].line, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trace-audit replay rejects conflicting duplicate manual_source_mapping events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-audit-'));
  try {
    const report = localReport();
    const findingId = report.pages[0].findings[0].findingId;
    const sessionDir = join(root, 'session');
    mkdirSync(sessionDir, { recursive: true });
    const first = manualMappingEvent({ reportId: report.reportId, findingId, line: 12 });
    const second = manualMappingEvent({
      reportId: report.reportId,
      findingId,
      file: 'src/pages/index.liquid',
      line: 30,
      preimage: PREIMAGE_OTHER,
    });
    writeFileSync(
      join(sessionDir, 'trace-audit.jsonl'),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      { mode: 0o600 },
    );

    assert.throws(
      () => loadManualMappingsFromTraceAudit(sessionDir, {
        reportId: report.reportId,
        knownFindingIds: new Set([findingId]),
      }),
      (error) => error instanceof TraceAuditError && error.code === 'CORRUPT_TRACE_AUDIT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
