import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionIdArg, runFixSubcommand } from '../../src/index.js';
import { FixControllerError } from '../../src/fix/controller/session.js';

test('runFixSubcommand throws typed error for missing report instead of exiting', async () => {
  await assert.rejects(
    () => runFixSubcommand(['--report', '/tmp/ada-scan-missing-report-never-exists.json']),
    (error) => error instanceof FixControllerError && error.code === 'REPORT_NOT_FOUND',
  );
});

test('parseSessionIdArg accepts a resumable session id and rejects missing values', () => {
  assert.equal(parseSessionIdArg(['--session', 'review-2026-07-16']), 'review-2026-07-16');
  assert.equal(parseSessionIdArg([]), null);
  assert.throws(
    () => parseSessionIdArg(['--session', '--ui']),
    (error) => error instanceof FixControllerError && error.code === 'INVALID_SESSION_ID',
  );
});

test('fix --ui or --session without --fix-mode is refused and points to --fix-mode cis; with it the trusted route runs', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { buildScanReportV2 } = await import('../../src/reporter/report-v2.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-fix-route-'));
  const reportPath = path.join(dir, 'latest.json');
  const run = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
  const report = buildScanReportV2([{ name: '/', page: '/', url: 'https://example.test/', scannerRuns: [run], violations: [] }], {
    generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' },
  });
  writeFileSync(reportPath, JSON.stringify(report));
  const base = ['--report', reportPath, '--source', dir, '--out-dir', path.join(dir, 'out')];
  for (const extra of [['--ui'], ['--session', 'abc']]) {
    await assert.rejects(() => runFixSubcommand([...base, ...extra]), /needs the trusted pipeline: add --fix-mode cis/);
  }
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let result;
  try { result = await runFixSubcommand([...base, '--fix-mode', 'cis', '--session', 'abc', '--ui']); } finally { console.log = orig; }
  assert.equal(result.status, 'scan-only');
  assert.match(logs.join('\n'), /Fix unavailable/);
  assert.equal(existsSync(path.join(dir, 'out', 'tasks')), false);
});

test('fix --verify without --report never reads a legacy scan-reports/latest.json of the cwd project; plain fix still does', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { resetProjectRootCache } = await import('../../src/utils/paths.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-fix-legacy-'));
  mkdirSync(path.join(dir, 'scan-reports'));
  writeFileSync(path.join(dir, 'scan-reports', 'latest.json'), '{}');
  const prevRoot = process.env.ADA_SCAN_ROOT, orig = console.log, logs = [];
  process.env.ADA_SCAN_ROOT = dir; resetProjectRootCache();
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const out = path.join(dir, 'out');
    await assert.rejects(() => runFixSubcommand(['--verify', '--source', dir, '--out-dir', out]), (e) => /No export found in .*out/.test(e.message) && /--out-dir/.test(e.message));
    assert.equal(logs.some((l) => /legacy/i.test(l)), false, logs.join('\n'));
    // not --verify: the legacy report is still found (and here rejected as invalid)
    await assert.rejects(() => runFixSubcommand(['--source', dir]), (e) => e.code === 'REPORT_INVALID');
    assert.ok(logs.some((l) => /Using legacy/.test(l)));
  } finally {
    console.log = orig;
    if (prevRoot === undefined) delete process.env.ADA_SCAN_ROOT; else process.env.ADA_SCAN_ROOT = prevRoot;
    resetProjectRootCache(); rmSync(dir, { recursive: true, force: true });
  }
});
