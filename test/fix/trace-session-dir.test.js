import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInstrumentationDigest } from '../../src/tracer/build-instrumented.js';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { startFixController } from '../../src/fix/controller/index.js';
import { applyManualMapping } from '../../src/fix/trace/inbox.js';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8')
);

function bootstrapProject(root) {
  writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'dist' }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  const manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' };
  writeFileSync(join(root, 'dist', 'scan-manifest.json'), JSON.stringify(manifest));
  const digest = computeInstrumentationDigest(manifest);
  writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({
    buildRevision: 'git:abc123',
    instrumentationDigest: digest,
  }));
  return digest;
}

function localReport(digest) {
  return buildScanReportV2(baseFixture.scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://localhost:1234/',
      buildRevision: 'git:abc123',
      instrumentationDigest: digest,
    },
  });
}

test('controller startup derives durable sessionDir and persists trace audit on mapping', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-session-dir-'));
  try {
    const digest = bootstrapProject(root);
    const partialDir = join(root, 'src', 'partials', 'jobs');
    mkdirSync(partialDir, { recursive: true });
    const content = '<button id="apply">Apply</button>\n';
    writeFileSync(join(partialDir, 'apply.liquid'), content);
    const expected = buildSourcePreimage(content, 1).preimageSha256;

    const report = localReport(digest);
    const result = startFixController({ report, localRoot: root });
    assert.equal(result.status, 'pending');
    assert.match(result.traceInbox.sessionDir, /scan-reports\/fix-sessions\/fix-/);
    assert.equal(statSync(result.traceInbox.sessionDir).mode & 0o777, 0o700);

    const mapped = applyManualMapping(result.traceInbox, {
      findingId: report.pages[0].findings[0].findingId,
      file: 'src/partials/jobs/apply.liquid',
      line: 1,
      expectedPreimageSha256: expected,
      reportId: report.reportId,
    });
    assert.equal(mapped.ok, true);

    const auditPath = join(result.traceInbox.sessionDir, 'trace-audit.jsonl');
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.ok(lines.some((line) => JSON.parse(line).type === 'manual_source_mapping'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
