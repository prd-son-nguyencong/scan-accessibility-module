import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2, projectReportV1 } from '../src/reporter/report-v2.js';
import { buildVerdictSection } from '../src/reporter/html.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { validateConfig } from '../src/utils/config.js';

const ctx = { generatedAt: '2026-07-15T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const run = (layer) => ({ layer, engine: { name: layer, version: '1' }, status: 'complete', ...(layer === 'accessScan' ? { evidence: { profile: 'standards', comparatorVersion: '1' } } : {}) });
const viol = (ruleId, layer, selector, html, extra = {}) => ({
  ruleId, layer, impact: 'serious', element: { selector, outerHTML: html }, fix: { hint: 'h' }, evidence: { failureSummary: 'Fix any of the following: x' }, ...extra,
});
const build = (violations, policy) => {
  const layers = [...new Set(violations.map((x) => x.layer))];
  return buildScanReportV2([{ page: '/', url: 'https://example.test/', scannerRuns: layers.map(run), violations }], { ...ctx, agreementPolicy: policy });
};
const byRule = (report) => Object.fromEntries(report.pages[0].findings.map((f) => [f.nativeRuleId, f]));

const IMG = '<img src="a.png">';

test('axe and accessScan on the same element under alias rule ids merge into ONE finding: multi, both engines, strongest verdict', () => {
  const report = build([
    viol('image-alt', 'axe', 'img.a', IMG),
    viol('ImageDiscernible', 'accessScan', '#main img', IMG),
  ]);
  assert.equal(report.pages[0].findings.length, 1);
  const [f] = report.pages[0].findings;
  assert.deepEqual(f.enginesAgreeing, ['accessScan', 'axe']);
  assert.deepEqual(f.layers, ['accessScan', 'axe']);
  assert.deepEqual(f.nativeRuleIds, ['ImageDiscernible', 'image-alt']);
  assert.equal(f.agreement, 'multi');
  assert.equal(f.verdict, 'confirmed'); // the deterministic engine's verdict wins the merge
  assert.equal(report.summary.findingCount, 1);
  assert.equal(report.summary.occurrenceCount, 1); // seen by two layers, counted once
});

test('Lighthouse a11y with axe is one lineage (both run axe-core): not multi', () => {
  const r = byRule(build([viol('image-alt', 'axe', 'img.a', IMG), viol('image-alt', 'lighthouse', 'body > img', IMG)]));
  assert.equal(r['image-alt'].agreement, 'single-deterministic');
  assert.deepEqual(r['image-alt'].enginesAgreeing, ['axe', 'lighthouse']);
});

test('html-validate and axe agree on a missing alt through the opening tag even when selectors differ', () => {
  const f = build([viol('image-alt', 'axe', 'img.a', IMG), viol('html-validate:wcag/h37', 'htmlValidate', 'html > body > img', IMG)]).pages[0].findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].agreement, 'multi');
});

test('same family on a different element, or a different family on the same element, does not agree', () => {
  const r = byRule(build([
    viol('image-alt', 'axe', 'img.a', IMG),
    viol('ImageDiscernible', 'accessScan', 'img.b', '<img src="b.png">'),
    viol('button-name', 'axe', 'img.a', IMG),
  ]));
  assert.equal(r['image-alt'].agreement, 'single-deterministic');
  assert.deepEqual(r.ImageDiscernible.enginesAgreeing, ['accessScan']);
  assert.deepEqual(r['button-name'].enginesAgreeing, ['axe']);
});

test('a finding only one heuristic engine reports becomes needs-review under strict (default), likely under off', () => {
  const h = [viol('focus-order-illogical', 'keyboard', 'a.x', '<a class="x">', { verdict: 'likely' })]; // an explicit verdict: a bare heuristic is already needs-review
  const strict = build(h).pages[0].findings[0];
  assert.equal(strict.agreement, 'single-heuristic');
  assert.equal(strict.verdict, 'needs-review');
  assert.equal(strict.verdictBeforeAgreement, 'likely');
  assert.deepEqual(build(h).summary.verdictCounts, { confirmed: 0, likely: 0, needsReview: 1 });
  const off = build(h, 'off').pages[0].findings[0];
  assert.equal(off.agreement, 'single-heuristic');
  assert.equal(off.verdict, 'likely');
  assert.equal(off.verdictBeforeAgreement, undefined);
});

test('a heuristic finding with an explicit confirmed verdict is capped, not kept confirmed', () => {
  const f = build([viol('focus-order-illogical', 'keyboard', 'a.x', '<a class="x">', { verdict: 'confirmed' })], 'off').pages[0].findings[0];
  assert.equal(f.verdict, 'needs-review'); // the choke point caps a heuristic whatever the agreement policy
  assert.equal(build([viol('focus-order-illogical', 'keyboard', 'a.x', '<a class="x">', { verdict: 'confirmed' })]).pages[0].findings[0].verdict, 'needs-review');
});

test('gate math is untouched: confirmed counts are identical under strict and off', () => {
  const vs = [viol('image-alt', 'axe', 'img.a', IMG), viol('focus-order-illogical', 'keyboard', 'a.x', '<a class="x">')];
  assert.equal(build(vs).summary.verdictCounts.confirmed, 1);
  assert.equal(build(vs, 'off').summary.verdictCounts.confirmed, 1);
});

test('v1 projection, HTML verdict table and QA report show the engines column', () => {
  const report = build([viol('focus-order-illogical', 'keyboard', 'a.x', '<a class="x">'), viol('image-alt', 'axe', 'img.a', IMG), viol('ImageDiscernible', 'accessScan', 'img.a', IMG)]);
  const v1 = projectReportV1(report).pages[0].violations;
  assert.deepEqual(v1.find((x) => x.enginesAgreeing.length === 2).enginesAgreeing, ['accessScan', 'axe']);
  const html = buildVerdictSection(v1);
  assert.match(html, /<th scope="col">Engines agreeing<\/th>/);
  assert.match(html, /<td>keyboard \(single-heuristic\)<\/td>/);
  const qa = renderQaHtml(buildQaModel(report));
  assert.match(qa, /<th scope="col">Engines agreeing<\/th>/);
  assert.match(qa, /<td>accessScan, axe<\/td>/);
});

test('config validates verdict.agreementPolicy', () => {
  assert.deepEqual(validateConfig({ verdict: { agreementPolicy: 'strict' } }), []);
  assert.deepEqual(validateConfig({ verdict: { agreementPolicy: 'off' } }), []);
  assert.match(validateConfig({ verdict: { agreementPolicy: 'lax' } }).join(), /agreementPolicy must be one of: strict, off/);
});
