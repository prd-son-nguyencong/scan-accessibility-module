import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { compareReports } from '../src/reporter/compare.js';
import { buildQaModel, renderQaHtml, wcagLevel } from '../src/reporter/qa-report.js';
import { writeQaReport } from '../src/reporter/scan-report.js';
import { evaluateGate } from '../src/utils/thresholds.js';
import { setReportsDir } from '../src/utils/paths.js';

const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const axeRun = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const lh = (perf) => ({ p: { lighthouse: {
  mobile: { scores: { performance: perf, accessibility: 100, bestPractices: 100, seo: 100 } },
  desktop: { scores: { performance: 95, accessibility: 100, bestPractices: 100, seo: 100 } } } } });
const viol = (over) => ({
  ruleId: 'image-alt', layer: 'axe', impact: 'critical', verdict: 'confirmed', wcagRef: 'WCAG2A',
  element: { selector: 'img.a', outerHTML: '<img class="a" src="a.png">' }, fix: { hint: 'Images need alt text' }, evidence: { failureSummary: 'Fix any of the following: x' }, ...over,
});
const traced = { file: 'src/partials/home/hero.liquid', line: 7, confidence: 'high', mode: 'local', method: 'marker' };
const violations = [
  viol({ source: traced }),
  viol({ ruleId: 'color-contrast', impact: 'serious', wcagRef: 'WCAG2AA', element: { selector: 'p.b', outerHTML: '<p class="b">x</p>' } }),
  viol({ ruleId: 'region', verdict: 'needs-review', impact: 'moderate', wcagRef: 'WCAG2A', element: { selector: 'div.c', outerHTML: '<div class="c"></div>' } }),
  viol({ ruleId: 'aria-widget', evidence: { proof: { type: 'attribute-value', fact: 'role="x" on div.w' } }, element: { selector: 'div.w', outerHTML: '<div data-react-component="Jobs"></div>' } }),
];
const mk = (extra = {}, vs = violations, c = ctx) => {
  const pr = { name: 'p', page: '/', url: 'https://example.test/', scannerRuns: [axeRun], violations: vs, lighthouseScores: lh(70) };
  const prelim = buildScanReportV2([pr], c);
  const gate = evaluateGate([{ ...pr, findings: prelim.pages[0].findings }], undefined);
  return buildScanReportV2([pr], { ...c, thresholds: gate, ...extra });
};

test('status FAIL with reasons; per-page metrics; top issues with traced file:line; platform group apart', () => {
  const m = buildQaModel(mk());
  assert.equal(m.status, 'FAIL');
  assert.match(m.statusReason, /quality gate/);
  const perf = m.standards.find((s) => s.id === 'perf').pages[0].metrics.find((x) => x.id === 'lighthouse.mobile.performance');
  assert.deepEqual([perf.actual, perf.target, perf.status], [70, 80, 'fail']);
  const alt = m.topIssues.find((g) => g.ruleId === 'image-alt');
  assert.deepEqual(alt.sources, ['src/partials/home/hero.liquid:7']);
  assert.equal(alt.confirmed, 1);
  assert.equal(m.topIssues.find((g) => g.ruleId === 'region').needsReview, 1);
  assert.deepEqual(m.platformOwned.map((g) => g.ruleId), ['aria-widget']);
  assert.ok(!m.topIssues.some((g) => g.ruleId === 'aria-widget'));
  assert.deepEqual([m.wcag.A, m.wcag.AA, m.wcag.AAA], [1, 1, 0]);
  assert.equal(m.limits.manualReviewItems, 1);
});

test('html: landmarks, captions, no inline script or handler, never claims compliance, escapes input', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderQaHtml(buildQaModel(mk({}, [viol({ ruleId: evil, element: { selector: evil, outerHTML: '<b>' }, source: { ...traced, file: evil } })])));
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(markup, /<script|<img|<[^>]*\son[a-z]+=/i);
  assert.equal((html.match(/<script/g) || []).length, 2, 'the theme script and its toggle, each allowed by hash');
  assert.equal((html.match(/script-src ('sha256-[^']+' ?){2};/g) || []).length, 1);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /compliant/i);
  assert.match(html, /<main id="main" class="wrap">/);
  assert.match(html, /<h1>QA report<\/h1>/);
  assert.equal((html.match(/<table class="tbl">/g) || []).length, (html.match(/<caption>/g) || []).length);
  assert.match(html, /Automated tools find only part of the WCAG issues/);
  assert.match(html, /Manual review: 0 flagged item\(s\) plus the standing checks/);
  assert.match(html, /@media print/);
});

test('INCOMPLETE when a page failed or fewer pages were scanned than requested; PASS only when clean', () => {
  const clean = mk({}, []);
  clean.runMetadata.thresholds.pages[0].metrics = [];
  clean.runMetadata.thresholds.failed = false;
  assert.equal(buildQaModel(clean).status, 'PASS');
  const partial = structuredClone(clean);
  partial.runMetadata.discovery = { partial: true, pages: [{ route: '/', source: 'config' }, { route: '/about', source: 'config' }] };
  const m = buildQaModel(partial);
  assert.equal(m.status, 'INCOMPLETE');
  assert.match(m.statusReason, /1 of 2 requested pages scanned/);
});

test('baseline section from comparison; absent comparison and absent gate degrade gracefully', () => {
  const base = mk({}, violations.slice(1), { ...ctx, generatedAt: '2026-10-26T00:00:00.000Z' });
  const cur = mk({ comparison: compareReports(mk(), base) });
  const html = renderQaHtml(buildQaModel(cur));
  assert.match(html, /fixed 0, remaining 1, new 1/);
  const none = mk();
  delete none.runMetadata.thresholds;
  delete none.comparison;
  const out = renderQaHtml(buildQaModel(none));
  assert.match(out, /No baseline comparison in this scan/);
  assert.match(out, /No quality gate result is recorded/);
  assert.equal(buildQaModel(none).status, 'FAIL');
});

test('wcagLevel reads the tag suffix only', () => {
  assert.deepEqual(['WCAG2A', 'WCAG21AA', 'WCAG22AAA', 'WCAG 1.4.3', null].map(wcagLevel), ['A', 'AA', 'AAA', null, null]);
});

test('writeQaReport writes html and json to the reports dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-'));
  setReportsDir(dir);
  try {
    const file = writeQaReport(mk());
    assert.equal(file, path.join(dir, 'qa-report.html'));
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'qa-report.json'), 'utf8')).status, 'FAIL');
    assert.match(readFileSync(file, 'utf8'), /^<!doctype html>/);
  } finally { setReportsDir(''); }
});
