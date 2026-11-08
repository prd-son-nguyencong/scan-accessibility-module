import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScanReportV2, projectReportV1 } from '../src/reporter/report-v2.js';
import { compareReports, formatComparison } from '../src/reporter/compare.js';
import { buildComparison, loadComparisonBase, writeReport } from '../src/reporter/scan-report.js';
import { buildHtml } from '../src/reporter/html.js';
import { generateRoiDocuments } from '../src/reporter/roi-doc.js';
import { setReportsDir } from '../src/utils/paths.js';

const ctx = { generatedAt: '2026-07-15T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const axeRun = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const lhRun = { layer: 'lighthouse', engine: { name: 'lighthouse', version: '12' }, status: 'complete' };

const v = (n, verdict, layer = 'axe') => ({
  ruleId: 'image-alt', layer, impact: 'critical', verdict,
  element: { selector: `img.${n}`, outerHTML: `<img class="${n}" src="${n}.png">` },
  fix: { hint: 'Images need alt text' }, evidence: { failureSummary: 'Fix any of the following: x' },
});
const page = (route, violations, extra = {}) => ({ page: route, url: `https://example.test${route}`, scannerRuns: [axeRun], violations, ...extra });
const sel = (list) => list.map((f) => f.selector).sort();

const baseline = buildScanReportV2([
  page('/', [v('a', 'confirmed'), v('b', 'confirmed'), v('c', 'likely'), v('n', 'needs-review'), v('d', 'confirmed')]),
  page('/about', [v('e', 'confirmed')]),
  page('/old', [v('f', 'confirmed')]),
], { ...ctx, generatedAt: '2026-07-14T00:00:00.000Z' });

const current = buildScanReportV2([
  page('/', [v('a', 'confirmed'), v('c', 'likely'), v('g', 'confirmed'), v('n', 'needs-review'), v('m', 'needs-review'), v('d', 'needs-review')]),
  page('/about', [v('e', 'confirmed'), v('h', 'likely')]),
  page('/new', [v('i', 'confirmed')]),
], ctx);

test('diff by stableId: fixed, remaining, new, reclassified; needs-review counted apart; route changes reported', () => {
  const c = compareReports(current, baseline);
  assert.deepEqual(sel(c.fixed), ['img.b']);
  assert.deepEqual(sel(c.remaining), ['img.a', 'img.c', 'img.e']);
  assert.deepEqual(sel(c.new), ['img.g', 'img.h']);
  assert.deepEqual(c.reclassified.map((r) => [r.selector, r.from, r.to]), [['img.d', 'confirmed', 'needs-review']]);
  assert.deepEqual(c.totals, { fixed: 1, remaining: 3, new: 2, reclassified: 1, needsReview: { baseline: 1, current: 3 } });
  assert.deepEqual(c.pages, [
    { route: '/', fixed: 1, remaining: 2, new: 1 },
    { route: '/about', fixed: 0, remaining: 1, new: 1 },
  ]);
  assert.deepEqual(c.addedPages, ['/new']);
  assert.deepEqual(c.removedPages, ['/old']);
  assert.ok(c.warnings.some((w) => /route set changed \(1 added, 1 removed\)/.test(w)));
  assert.ok(!c.warnings.some((w) => /apples/.test(w)));
  assert.match(formatComparison(c).join('\n'), /fixed 1, remaining 3, new 2/);
  assert.match(formatComparison(c).join('\n'), /\/old: page not scanned this time \(not counted as fixed\)/);
});

test('different profile or target warns; identical baseline warns', () => {
  const other = buildScanReportV2([page('/', [v('a', 'confirmed')])], {
    ...ctx, target: { mode: 'local-only', url: 'http://127.0.0.1:1234/' }, profiles: ['standards', 'commercial-parity'],
  });
  const c = compareReports(other, baseline);
  assert.equal(c.warnings.filter((w) => /apples to apples/.test(w)).length, 2);
  assert.ok(compareReports(current, current).warnings.some((w) => /identical/.test(w)));
});

test('failed pages and layers that did not complete never count as fixed', () => {
  const cur = buildScanReportV2([
    page('/', [], { scannerRuns: [axeRun] }),
    page('/about', [], { status: 'failed', failure: { reason: 'http-status', message: 'HTTP 500' } }),
  ], ctx);
  const base = buildScanReportV2([
    page('/', [v('a', 'confirmed'), v('l', 'confirmed', 'lighthouse')], { scannerRuns: [axeRun, lhRun] }),
    page('/about', [v('e', 'confirmed')]),
  ], ctx);
  const c = compareReports(cur, base);
  assert.deepEqual(sel(c.fixed), ['img.a']);
  assert.deepEqual(c.notCompared, [{ route: '/about', reason: 'page failed in this scan' }]);
  assert.ok(c.warnings.some((w) => /layers not completed in both scans were left out: lighthouse/.test(w)));
});

test('a baseline without stable ids is unusable, not compared by counts', () => {
  const legacy = projectReportV1(baseline);
  assert.match(compareReports(current, legacy).unusable, /no stable finding ids/);
  const { comparison, lines } = buildComparison(current, { report: legacy, source: 'baseline' });
  assert.equal(comparison, null);
  assert.match(lines.join('\n'), /Comparison: skipped \(the baseline has no stable finding ids/);
});

test('baseline wins over previous scan; nothing to compare gives a clear message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-compare-'));
  setReportsDir(dir);
  try {
    const none = loadComparisonBase();
    assert.match(none.reason, /run with --baseline/);
    assert.match(buildComparison(current, none).lines.join('\n'), /Comparison: skipped \(no baseline or previous scan/);
    writeReport([page('/', [v('a', 'confirmed')])], ctx);
    assert.equal(loadComparisonBase().source, 'previous scan');
    writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline));
    assert.equal(loadComparisonBase().source, 'baseline');
  } finally {
    setReportsDir(undefined);
  }
});

test('comparison lands in latest.json, the legacy projection, the HTML and the summary document', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-compare-'));
  setReportsDir(dir);
  try {
    const comparison = compareReports(current, baseline);
    const { report, legacyReport } = writeReport(
      [page('/', [v('a', 'confirmed')])], { ...ctx, comparison },
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')).comparison.totals, comparison.totals);
    assert.equal(report.comparison.totals.fixed, 1);
    assert.equal(legacyReport.comparison.totals.new, 2);
    assert.match(buildHtml(legacyReport), /<strong>1 fixed<\/strong>, <strong>3 remaining<\/strong>, <strong>2 new<\/strong>/);
    const { comparisonPath } = generateRoiDocuments(legacyReport);
    const doc = readFileSync(comparisonPath, 'utf8');
    assert.match(doc, /Fixed since baseline/);
    assert.doesNotMatch(doc, /reduction/i);
  } finally {
    setReportsDir(undefined);
  }
});

// --- stable id v2: generated ids/classes and shifting head/script positions must not change identity ---
const idOf = (selector, extra = {}) => buildScanReportV2([page('/', [{
  ruleId: extra.ruleId || 'image-alt', layer: 'axe', impact: 'critical', verdict: 'confirmed',
  element: { selector, outerHTML: extra.html || '<div></div>' }, fix: { hint: 'x' }, evidence: { failureSummary: 'Fix any of the following: x' },
}])], ctx).pages[0].findings[0].stableId;
const same = (a, b, extra) => assert.equal(idOf(a, extra), idOf(b, extra), `${a} == ${b}`);
const differ = (a, b, extra) => assert.notEqual(idOf(a, extra), idOf(b, extra), `${a} != ${b}`);

test('stableId ignores generated ids, hashed classes and volatile attributes', () => {
  same('div#el-popover-5950>div:nth-of-type(1)', 'div#el-popover-472>div:nth-of-type(1)');
  same('#ours1793041973008>p', '#ours1793042113144>p');
  same('[id="606bad6c-3519-455d-bf4e-b92732cb8875-keyword-search-input"]', '[id="62e171b4-7a1d-46b6-aa9e-01fe82673161-keyword-search-input"]');
  same('#a05f50ca-595f-45a5-b7bc-6d49d7b6f608-keyword-search-input', '#ef636f7c-5184-42f8-a6ea-9b029ec37b24-keyword-search-input');
  same('apply-widget,.ol-text-message.ae8f46[role="button"]', 'apply-widget,.ol-text-message[role="button"]');
  same('apply-widget,.ol-text-message.ae8f46', 'apply-widget,.ol-text-message.b91c20');
  same('div.css-1a2b3c>span', 'div.css-9z8y7x>span');
  same('button[aria-describedby="el-popover-1234"]', 'button[aria-describedby="el-popover-9876"]');
  same('div[data-v-7ba5bd90].card[style="top: 3px"]', 'div.card');
});

test('stableId keeps legitimately numeric names', () => {
  differ('h1', 'h2');
  differ('div.col-6', 'div.col-4');
  differ('div.grid-cols-3', 'div.grid-cols-2');
  differ('div.text-2xl', 'div.text-3xl');
  differ('#section-1', '#section-2');
  differ('#faq10', '#faq11');
  differ('a[aria-label="Page 2"]', 'a[aria-label="Page 3"]');
  differ('#el-popover-5950', '#el-select-5950');
  differ('#job-1001', '#job-2002');
  differ('#tab-100', '#tab-200');
  differ('#job-12345>a', '#job-67890>a');
});

test('stableId drops head and script/link/meta positions but keeps what tells elements apart', () => {
  const s = (src) => ({ ruleId: 'script-type', html: `<script src="${src}" type="text/javascript">` });
  same('html>head>script:nth-child(32)', 'html>head>script:nth-child(37)', s('https://a.test/x.js'));
  same('html>head>script:nth-child(32)', 'html>head>script:nth-child(37)', s('https://a.test/x.js?v=1'));
  same('html>head:nth-of-type(1)>meta:nth-of-type(4)', 'html>head:nth-of-type(1)>meta:nth-of-type(5)');
  same('html>body>script:nth-child(7)', 'html>body>script:nth-child(9)', s('https://a.test/x.js'));
});

test('stableId differs for another element, rule or page', () => {
  const s = (src) => ({ ruleId: 'script-type', html: `<script src="${src}">` });
  assert.notEqual(idOf('html>head>script:nth-child(3)', s('https://a.test/x.js')), idOf('html>head>script:nth-child(3)', s('https://a.test/y.js')));
  assert.notEqual(idOf('html>body>div:nth-child(2)'), idOf('html>body>div:nth-child(3)'));
  assert.notEqual(idOf('div#el-popover-5950>p'), idOf('div#el-popover-5950>span'));
  assert.notEqual(idOf('img.a'), idOf('img.a', { ruleId: 'image-redundant-alt' }));
  const other = buildScanReportV2([page('/about', [v('a', 'confirmed')])], ctx).pages[0].findings[0].stableId;
  assert.notEqual(other, buildScanReportV2([page('/', [v('a', 'confirmed')])], ctx).pages[0].findings[0].stableId);
});

test('identical head scripts are matched by ordinal; shifted positions give fixed 0 / new 0', () => {
  const sc = (n) => ({ ruleId: 'script-type', layer: 'axe', impact: 'minor', verdict: 'likely', element: { selector: `html>head>script:nth-child(${n})`, outerHTML: '<script type="text/javascript">' }, fix: { hint: 'x' } });
  const a = buildScanReportV2([page('/', [sc(3), sc(5), v('a', 'confirmed')])], ctx);
  const b = buildScanReportV2([page('/', [sc(4), sc(9), v('a', 'confirmed')])], { ...ctx, generatedAt: '2026-07-16T00:00:00.000Z' });
  assert.deepEqual(compareReports(b, a).totals, { fixed: 0, remaining: 3, new: 0, reclassified: 0, needsReview: { baseline: 0, current: 0 } });
  const fewer = buildScanReportV2([page('/', [sc(4), v('a', 'confirmed')])], { ...ctx, generatedAt: '2026-07-16T00:00:00.000Z' });
  assert.deepEqual([compareReports(fewer, a).totals.fixed, compareReports(fewer, a).totals.new], [1, 0]);
});

test('a baseline with another stableId algorithm version is refused, not diffed', () => {
  assert.equal(current.stableIdVersion, 2);
  const old = { ...baseline, stableIdVersion: undefined };
  assert.match(compareReports(current, old).unusable, /algorithm v1 and this scan uses v2/);
  assert.equal(compareReports(current, { ...baseline, stableIdVersion: 3 }).unusable.includes('v3'), true);
});

test('findings the re-verifier saw flaky in either scan are left out of the counts', () => {
  const flakyMeta = { scan: { concurrency: 1, retries: 0, pages: [], reverify: { flakyFindings: [{ route: '/', ruleId: 'image-alt', layer: 'axe', impact: 'critical', selector: 'img.b', stability: '1/2' }] } } };
  const cur = { ...current, runMetadata: { ...current.runMetadata, ...flakyMeta } };
  const c = compareReports(cur, baseline);
  assert.deepEqual(sel(c.fixed), []);
  assert.equal(c.totals.fixed, 0);
});

test('findings in platform-owned or third-party markup are left out of the comparison, with a note', () => {
  const widget = (n) => ({ ...v(n, 'confirmed'), ruleId: 'iframe-title', element: { selector: `iframe.${n}`, outerHTML: '<apply-widget vce-ready=""></apply-widget><div id="chat-widget"></div>' } });
  const yt = (n) => ({ ...v(n, 'confirmed'), ownership: 'third-party' });
  const a = buildScanReportV2([page('/', [v('a', 'confirmed'), widget('x'), yt('y')])], ctx);
  const b = buildScanReportV2([page('/', [v('a', 'confirmed'), widget('z')])], { ...ctx, generatedAt: '2026-07-16T00:00:00.000Z' });
  assert.equal(a.pages[0].findings.find((f) => f.element.selector === 'iframe.x').ownership, 'platform');
  const c = compareReports(b, a);
  assert.deepEqual([c.totals.fixed, c.totals.remaining, c.totals.new], [0, 1, 0]);
  assert.match(c.warnings.join('\n'), /3 findings in platform-owned or third-party markup/);
});

test('a single-heuristic finding downgraded by agreement policy is still reported fixed on rescan', () => {
  const h = (n) => ({ ruleId: 'ImageDiscernible', layer: 'accessScan', impact: 'serious', verdict: 'likely', element: { selector: `img.${n}`, outerHTML: `<img class="${n}" src="${n}.png">` }, fix: { hint: 'h' } });
  const asRun = { layer: 'accessScan', engine: { name: 'accessScan', version: '1' }, status: 'complete', evidence: { profile: 'standards', comparatorVersion: '1' } };
  const pg = (list) => [{ page: '/', url: 'https://example.test/', scannerRuns: [asRun], violations: list }];
  const before = buildScanReportV2(pg([h('a'), h('b')]), { ...ctx, generatedAt: '2026-07-14T00:00:00.000Z' });
  const after = buildScanReportV2(pg([h('a')]), ctx);
  assert.equal(before.pages[0].findings[0].verdict, 'needs-review'); // default strict policy applied
  const c = compareReports(after, before);
  assert.deepEqual(sel(c.fixed), ['img.b']);
  assert.deepEqual(sel(c.remaining), ['img.a']);
  assert.deepEqual(c.totals.needsReview, { baseline: 0, current: 0 });
});
