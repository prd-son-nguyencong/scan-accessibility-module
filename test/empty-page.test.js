import './helpers/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startParadoxSite } from './helpers/paradox-site-server.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { isEmptyPage } from '../src/scanner/page-health.js';
import { validateConfig } from '../src/utils/config.js';
import { evaluateGate, formatGate } from '../src/utils/thresholds.js';
import { scanWithLighthouse } from '../src/scanner/lighthouse.js';
import { buildLighthouseScannerRuns } from '../src/index.js';
import { derivePageStatus } from '../src/scanner/page-health.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/ada-scan.js');
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/empty-page');

async function runCli(policy) {
  const site = await startParadoxSite({ dir: FIXTURE });
  const root = mkdtempSync(path.join(tmpdir(), 'ada-empty-'));
  writeFileSync(path.join(root, '.scan-config.json'), JSON.stringify({
    baseUrl: site.url, buildCommand: 'node -e 0', pages: [{ path: '/real' }, { path: '/empty' }], ...(policy ? { scan: { emptyPagePolicy: policy } } : {}),
  }));
  try {
    const child = spawn(process.execPath, [CLI, '--layers', 'axe,htmlValidate', '--no-psi'], { cwd: root, env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_DEPLOYMENT_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('close', r));
    return { code, out, report: JSON.parse(readFileSync(path.join(root, '.ada-scan/latest.json'), 'utf8')) };
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
}

test('0-byte page is skipped-empty: no layers, no findings, not failed or incomplete; the real page is scanned', { timeout: 280_000 }, async () => {
  const { code, out, report } = await runCli();
  const byRoute = Object.fromEntries(report.pages.map((p) => [p.route, p]));
  assert.equal(byRoute['/empty'].status, 'skipped-empty');
  assert.match(byRoute['/empty'].skipped.note, /empty template, platform-managed\?/);
  assert.deepEqual(byRoute['/empty'].findings, []);
  assert.deepEqual(byRoute['/empty'].scannerRunIds, []);
  assert.equal(byRoute['/real'].status, 'ok');
  assert.ok(byRoute['/real'].scannerRunIds.length > 0);
  assert.equal(report.summary.pagesSkipped, 1);
  assert.equal(report.summary.pagesFailed, 0);
  assert.equal(report.summary.pagesPartial, 0);
  assert.notEqual(code, 2);
  assert.match(out, /SKIPPED: page is empty/);
});

test('scan.emptyPagePolicy "scan" scans the 0-byte page as a full page', { timeout: 280_000 }, async () => {
  const { report } = await runCli('scan');
  const empty = report.pages.find((p) => p.route === '/empty');
  assert.notEqual(empty.status, 'skipped-empty');
  assert.ok(empty.findings.length > 0, 'axe reports the missing lang/title on the empty document');
});

test('isEmptyPage: empty and script-only bodies are empty; any text, heading or landmark is not', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const page = await browser.newPage();
  try {
    const cases = [
      ['', true],
      ['<html><head><title>x</title></head><body><script>1</script><style>a{}</style><template><p>t</p></template></body></html>', true],
      ['<body><p>hello</p></body>', false],
      ['<body><main></main></body>', false],
      ['<body><h1> </h1></body>', false],
      ['<body><div role="navigation"></div></body>', false],
    ];
    for (const [html, expected] of cases) {
      await page.setContent(html);
      assert.equal(await isEmptyPage(page), expected, html);
    }
  } finally { await page.close(); await closeBrowser(); }
});

test('scan.emptyPagePolicy is validated', () => {
  assert.deepEqual(validateConfig({ scan: { emptyPagePolicy: 'scan' } }).filter((e) => /scan/.test(e)), []);
  assert.ok(validateConfig({ scan: { emptyPagePolicy: 'maybe' } }).some((e) => /emptyPagePolicy/.test(e)));
});

// A page Lighthouse cannot score: all categories score 0 and every audit has no result.
const unscorableLhr = () => {
  const ids = Array.from({ length: 76 }, (_, i) => `audit-${i}`);
  return {
    lighthouseVersion: '12.0.0', fetchTime: 't', finalUrl: 'http://127.0.0.1/',
    categories: Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map((c) => [c, { score: 0, auditRefs: ids.map((id) => ({ id })) }])),
    audits: Object.fromEntries(ids.map((id) => [id, { title: id, score: null, scoreDisplayMode: 'error' }])),
  };
};

test('lighthouse: a page with 76 incomplete audits is unscorable, not a 0/100 gate FAIL', async () => {
  const res = await scanWithLighthouse('http://127.0.0.1/', {}, { runner: async () => unscorableLhr() });
  for (const d of ['mobile', 'desktop']) {
    assert.equal(res.lighthouse[d].unscorable, true);
    assert.deepEqual(Object.values(res.lighthouse[d].scores), [null, null, null, null]);
  }
  const runs = buildLighthouseScannerRuns(res);
  assert.ok(runs.every((r) => r.status === 'skipped' && r.evidence.errorCode === 'unscorable'));
  assert.equal(derivePageStatus(null, runs), 'partial');
  const gate = evaluateGate([{ name: 'p', url: 'http://x/p', lighthouseScores: { p: { lighthouse: res.lighthouse } }, violations: [] }]);
  const lh = gate.pages[0].metrics.filter((m) => m.id.startsWith('lighthouse.'));
  assert.equal(lh.length, 8);
  assert.ok(lh.every((m) => m.status === 'skipped' && m.reason === 'unscorable'));
  assert.equal(gate.failed, false);
  assert.match(formatGate(gate).join('\n'), /SKIPPED +lighthouse\.mobile\.performance: n\/a \/ \d+ \(unscorable\)/);
});

test('lighthouse: a genuinely low-scoring page with results still fails the gate (paired)', async () => {
  const lhr = unscorableLhr();
  for (const a of Object.values(lhr.audits)) { a.score = 0; a.scoreDisplayMode = 'binary'; a.details = { items: [] }; }
  const res = await scanWithLighthouse('http://127.0.0.1/', {}, { runner: async () => lhr });
  assert.equal(res.lighthouse.mobile.unscorable, undefined);
  assert.equal(res.lighthouse.mobile.scores.performance, 0);
  const gate = evaluateGate([{ name: 'p', url: 'http://x/p', lighthouseScores: { p: { lighthouse: res.lighthouse } }, violations: [] }]);
  assert.equal(gate.failed, true);
});

test('QA report lists skipped pages with the reason and shows SKIPPED(unscorable) gate cells', () => {
  const report = {
    generatedAt: '2026-01-01T00:00:00Z', target: { mode: 'url-only', url: 'http://x' }, scanners: [],
    summary: { pagesFailed: 0, pagesPartial: 0, pagesSkipped: 1 },
    pages: [{ name: 'stub', route: '/stub', url: 'http://x/stub', status: 'skipped-empty', skipped: { reason: 'empty-page', note: 'empty template, platform-managed?' }, findings: [] }],
    runMetadata: { thresholds: { failed: false, pages: [{ name: 'p', url: 'http://x/p', metrics: [{ id: 'lighthouse.mobile.accessibility', actual: null, target: 90, status: 'skipped', reason: 'unscorable' }] }] } },
  };
  const model = buildQaModel(report);
  assert.deepEqual(model.skippedPages, [{ route: '/stub', reason: 'empty template, platform-managed?' }]);
  assert.equal(model.status, 'PASS');
  const html = renderQaHtml(model);
  assert.match(html, /<h2 id="skipped">Skipped pages<\/h2>/);
  assert.match(html, /empty template, platform-managed\?/);
  assert.match(html, /SKIPPED\(unscorable\)/);
});
