import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetProjectRootCache, setReportsDir, getReportsDir } from '../src/utils/paths.js';
import { writeReport, writeBaseline, loadBaseline } from '../src/reporter/scan-report.js';
import { writeHtmlReport } from '../src/reporter/html.js';
import { generateRoiDocuments } from '../src/reporter/roi-doc.js';

let root;
let prev;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-outdir-')));
  prev = process.env.ADA_SCAN_ROOT;
  process.env.ADA_SCAN_ROOT = root;
  resetProjectRootCache();
});
afterEach(() => {
  if (prev === undefined) delete process.env.ADA_SCAN_ROOT;
  else process.env.ADA_SCAN_ROOT = prev;
  resetProjectRootCache();
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fix/report-v2.json', import.meta.url), 'utf8'));
const empty = fixture.scanResults;
const ctx = fixture.context;

test('default location is <root>/.ada-scan and nothing lands in scan-reports', () => {
  const { latestPath, histDir } = writeReport(empty, ctx);
  writeBaseline({ marker: 1 });
  assert.equal(getReportsDir(), path.join(root, '.ada-scan'));
  assert.equal(latestPath, path.join(root, '.ada-scan', 'latest.json'));
  assert.ok(histDir.startsWith(path.join(root, '.ada-scan', 'history')));
  assert.ok(existsSync(path.join(root, '.ada-scan', 'baseline.json')));
  assert.deepEqual(readdirSync(root), ['.ada-scan']);
});

test('--out-dir override (relative to root) receives every writer', () => {
  setReportsDir('custom/out');
  const { report, legacyReport } = writeReport(empty, ctx);
  writeBaseline(report);
  writeHtmlReport(legacyReport);
  generateRoiDocuments(report, null);
  const dir = path.join(root, 'custom', 'out');
  for (const f of ['latest.json', 'baseline.json', 'scan-visual.html', 'roi-comparison.html', 'roi-technical.html', 'history']) {
    assert.ok(existsSync(path.join(dir, f)), f);
  }
  assert.ok(!existsSync(path.join(root, '.ada-scan')));
  assert.ok(!existsSync(path.join(root, 'scan-reports')));
});

test('legacy scan-reports baseline is read when the new location has none', () => {
  mkdirSync(path.join(root, 'scan-reports'));
  writeFileSync(path.join(root, 'scan-reports', 'baseline.json'), JSON.stringify({ pages: [], legacy: true }));
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    assert.deepEqual(loadBaseline(), { pages: [], legacy: true });
  } finally {
    console.log = orig;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /legacy scan-reports/);
  assert.ok(!existsSync(path.join(root, '.ada-scan')));
});

test('new-location baseline wins over the legacy one', () => {
  mkdirSync(path.join(root, 'scan-reports'));
  writeFileSync(path.join(root, 'scan-reports', 'baseline.json'), JSON.stringify({ pages: [], legacy: true }));
  writeBaseline({ pages: [], fresh: true });
  assert.deepEqual(loadBaseline(), { pages: [], fresh: true });
});
