import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { enrichReportForHtml } from '../src/index.js';
import { buildHtml } from '../src/reporter/html.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { evaluateGate } from '../src/utils/thresholds.js';
import { totalsLabel, w3cEngineNote, runStatusLabel } from '../src/reporter/wording.js';

const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const run = (layer, status, extra = {}) => ({ layer, engine: { name: layer === 'w3c' ? 'none (external validator not run)' : layer, version: '1' }, status, ...extra });
const v = (over) => ({ ruleId: 'image-alt', layer: 'axe', category: 'accessibility', impact: 'critical', verdict: 'confirmed', wcagRef: 'WCAG2A', element: { selector: 'img.a', outerHTML: '<img class="a">' }, fix: { hint: 'x' }, ...over });
const lighthouseScores = { p: { lighthouse: { mobile: { scores: { performance: 90, accessibility: 80, bestPractices: 100, seo: 100 } }, desktop: { scores: { performance: 90, accessibility: 80, bestPractices: 100, seo: 100 } } } } };

function fixture({ good = true } = {}) {
  const violations = [
    v({ count: 3 }),
    v({ ruleId: 'skip-link', layer: 'lighthouse', impact: 'moderate', element: { selector: 'a.skip', outerHTML: '<a class="skip">' } }),
    ...(good ? [v({ ruleId: 'html-validate-x', layer: 'htmlValidate', category: 'html', impact: 'serious', element: { selector: 'div.q', outerHTML: '<div class="q">' } })] : []),
  ];
  const pr = { name: 'p', page: '/', url: 'https://example.test/', status: 'ok', violations, lighthouseScores,
    scannerRuns: [run('axe', 'complete'), run('w3c', 'skipped'), run('lighthouse', 'complete', { evidence: { accessibility: { incomplete: 76 } } })] };
  const failedPage = { name: 'f', page: '/f', url: 'https://example.test/f', status: 'failed', failure: { reason: 'http', message: 'HTTP 500' }, violations: [], scannerRuns: [] };
  const emptyPage = { name: 'e', page: '/e', url: 'https://example.test/e', status: 'skipped-empty', skipped: { note: 'empty template' }, violations: [], scannerRuns: [] };
  const prelim = buildScanReportV2([pr, failedPage, emptyPage], ctx);
  const gate = evaluateGate([{ ...pr, findings: prelim.pages[0].findings }], undefined);
  const report = buildScanReportV2([pr, failedPage, emptyPage], { ...ctx, thresholds: gate, discovery: { partial: false, pages: [], droppedRoutes: [{ route: '/pages/ghost', source: 'dist', status: 404 }] } });
  return report;
}

test('totals say occurrences and distinct findings', () => {
  assert.equal(totalsLabel(176, 165), '176 occurrences in 165 distinct findings');
  const html = buildHtml(enrichReportForHtml(fixture()));
  assert.match(html, /5 occurrences in 3 distinct findings/);
});

test('Lighthouse scores come from the Lighthouse run, per form factor', () => {
  const html = buildHtml(enrichReportForHtml(fixture()));
  assert.match(html, /<h3 class="sub">Mobile/);
  assert.match(html, /<th scope="row" data-l="Page">p<\/th><td class="num" data-l="Performance">90 <span class="muted">good<\/span><\/td><td class="num" data-l="Accessibility">80 <span class="muted">needs work<\/span>/);
});

test('w3c gate rows name the engine; Nu not run says so; absent html-validate findings are not claimed', () => {
  const html = buildHtml(enrichReportForHtml(fixture()));
  assert.match(html, /w3c\.\* checks are fed by: HTML validity \(html-validate, offline\); Nu validator not run \(external disabled\)/);
  const bad = buildHtml(enrichReportForHtml(fixture({ good: false })));
  assert.doesNotMatch(bad, /html-validate, offline/);
  assert.equal(w3cEngineNote([run('w3c', 'complete')], []), 'W3C Nu');
  const m = buildQaModel(fixture());
  assert.equal(m.htmlEngine, 'HTML validity (html-validate, offline); Nu validator not run (external disabled)');
  assert.match(renderQaHtml(m), /fed by: HTML validity \(html-validate, offline\)/);
});

test('coverage separates failed, skipped and dropped pages and says a clean total is not a pass', () => {
  const html = buildHtml(enrichReportForHtml(fixture()));
  assert.match(html, /Failed \(1\)[\s\S]*not scanned \(HTTP 500\)/);
  assert.match(html, /Skipped \(1\)[\s\S]*empty template[\s\S]*Not a failure/);
  assert.match(html, /Dropped routes \(1\)[\s\S]*not served \(HTTP 404\)/);
  assert.match(html, /Incomplete scan\.<\/strong> A clean total is not a pass/);
});

test('Lighthouse complete with unevaluated audits is labelled; gate note near the top', () => {
  assert.equal(runStatusLabel(run('lighthouse', 'complete', { evidence: { accessibility: { incomplete: 76 } } })), 'complete (76 audits not evaluated)');
  assert.equal(runStatusLabel(run('lighthouse', 'complete')), 'complete');
  const html = buildHtml(enrichReportForHtml(fixture()));
  assert.match(html, /complete \(76 audits not evaluated\)/);
  const note = 'Only confirmed findings fail the gate; likely and needs-review findings are listed for review.';
  assert.ok(html.indexOf(note) > 0 && html.indexOf(note) < html.indexOf('Incomplete scan.'));
  assert.match(renderQaHtml(buildQaModel(fixture())), /Only confirmed findings fail the gate/);
});
