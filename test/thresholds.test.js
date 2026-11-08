import './helpers/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, normalizeThresholds, validateThresholds, isDevServerHtml, isNoindex, DEFAULT_THRESHOLDS } from '../src/utils/thresholds.js';
import { mergeConfig, DEFAULT_CONFIG } from '../src/utils/config.js';
import { computeExitCode } from '../src/index.js';
import { buildScanReportV2, projectReportV1 } from '../src/reporter/report-v2.js';
import { buildGateSection } from '../src/reporter/html.js';

const lh = (mobile, desktop = {}) => ({
  p: { lighthouse: {
    mobile: { scores: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100, ...mobile } },
    desktop: { scores: { performance: 100, accessibility: 100, bestPractices: 100, seo: 100, ...desktop } },
  } },
});
const page = (over = {}) => ({ name: 'p', url: 'http://x/', violations: [], lighthouseScores: lh({}), devServer: false, ...over });
const metric = (gate, id) => gate.pages[0].metrics.find((m) => m.id === id);

test('mobile performance 70 fails on a production-like target, advisory on a dev server', () => {
  const prod = evaluateGate([page({ lighthouseScores: lh({ performance: 70 }) })], undefined);
  assert.equal(metric(prod, 'lighthouse.mobile.performance').status, 'fail');
  assert.equal(prod.failed, true);
  const dev = evaluateGate([page({ lighthouseScores: lh({ performance: 70 }), devServer: true })], undefined);
  const m = metric(dev, 'lighthouse.mobile.performance');
  assert.equal(m.status, 'advisory');
  assert.match(m.reason, /dev server/);
  assert.equal(dev.failed, false);
  const forced = evaluateGate([page({ lighthouseScores: lh({ performance: 70 }), devServer: true })], undefined, { perfGate: true });
  assert.equal(forced.failed, true);
});

test('table: metric statuses', () => {
  const v = (impact, layer = 'axe', category = 'accessibility') => ({ impact, layer, category });
  const cases = [
    ['mobile 80 passes at default', page({ lighthouseScores: lh({ performance: 80 }) }), 'lighthouse.mobile.performance', 'pass'],
    ['desktop 89 fails at 90', page({ lighthouseScores: lh({}, { performance: 89 }) }), 'lighthouse.desktop.performance', 'fail'],
    ['accessibility 99 fails at 100', page({ lighthouseScores: lh({ accessibility: 99 }) }), 'lighthouse.mobile.accessibility', 'fail'],
    ['null score is skipped', page({ lighthouseScores: lh({ seo: null }) }), 'lighthouse.mobile.seo', 'skipped'],
    ['no lighthouse data is skipped', page({ lighthouseScores: {} }), 'lighthouse.mobile.performance', 'skipped'],
    ['serious a11y fails', page({ violations: [v('serious')] }), 'a11y.serious', 'fail'],
    ['moderate a11y is report', page({ violations: [v('moderate')] }), 'a11y.moderate', 'report'],
    ['w3c error fails', page({ violations: [v('serious', 'w3c', 'markup')] }), 'w3c.errors', 'fail'],
    ['w3c warning is report', page({ violations: [v('minor', 'w3c', 'markup')] }), 'w3c.warnings', 'report'],
    ['non-a11y violation ignored', page({ violations: [v('critical', 'lighthouse', 'performance')] }), 'a11y.critical', 'pass'],
  ];
  for (const [name, p, id, status] of cases) assert.equal(metric(evaluateGate([p], undefined), id).status, status, name);
  assert.equal(metric(evaluateGate([page()], undefined, { layers: { w3c: false } }), 'w3c.errors').status, 'skipped');
  assert.equal(evaluateGate([{ ...page(), status: 'failed' }], undefined).pages[0].metrics.length, 0);
});

test('user thresholds override defaults, a11y count allowed', () => {
  const g = evaluateGate([page({ violations: [{ impact: 'serious', category: 'accessibility' }] })], { a11y: { serious: 2 }, lighthouse: { mobile: { performance: 50 } } });
  assert.equal(metric(g, 'a11y.serious').status, 'pass');
  assert.equal(metric(g, 'lighthouse.mobile.performance').target, 50);
  assert.equal(metric(g, 'lighthouse.desktop.performance').target, 90);
});

test('legacy flat thresholds map with a deprecation notice', () => {
  const { thresholds, notices } = normalizeThresholds({ wcag: 3, performance: 70, bestPractices: 60 });
  assert.equal(thresholds.a11y.critical, 3);
  assert.equal(thresholds.a11y.serious, 3);
  assert.equal(thresholds.lighthouse.mobile.performance, 70);
  assert.equal(thresholds.lighthouse.desktop.performance, 90);
  assert.equal(thresholds.lighthouse.desktop.bestPractices, 60);
  assert.match(notices[0], /deprecated/);
  assert.deepEqual(normalizeThresholds(DEFAULT_THRESHOLDS).notices, []);
  assert.deepEqual(validateThresholds({ wcag: 0, performance: 90, bestPractices: 90 }), []);
});

test('legacy flat thresholds survive the real config merge (mergeConfig -> normalizeThresholds)', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { thresholds: { performance: 50, wcag: 5 } });
  const { thresholds } = normalizeThresholds(merged.thresholds);
  assert.equal(thresholds.lighthouse.mobile.performance, 50);
  assert.equal(thresholds.a11y.critical, 5);
  assert.equal(thresholds.a11y.serious, 5);
  assert.equal(normalizeThresholds(mergeConfig(DEFAULT_CONFIG, {}).thresholds).thresholds.lighthouse.mobile.performance, 80);
});

test('validation', () => {
  assert.deepEqual(validateThresholds(DEFAULT_THRESHOLDS), []);
  const errs = validateThresholds({
    lighthouse: { mobile: { performance: 101, foo: 1 }, tablet: {} }, a11y: { critical: 'x' }, w3c: { errors: -1 }, nope: 1, performance: 150,
  }).join('\n');
  for (const frag of ['mobile.performance', 'mobile.foo', 'tablet', 'a11y.critical', 'w3c.errors', 'thresholds.nope', 'thresholds.performance']) {
    assert.match(errs, new RegExp(frag.replace('.', '\\.')), frag);
  }
});

test('dev server detection', () => {
  assert.equal(isDevServerHtml('<script type="module" src="/@vite/client"></script>'), true);
  assert.equal(isDevServerHtml('<html><script src="/assets/app.js"></script></html>'), false);
  assert.equal(isDevServerHtml(undefined), false);
});

test('exit codes: gate failure is 1 only with --gate, 2 wins, --no-fail silences', () => {
  const failed = { failed: true };
  const clean = { occurrenceCount: 0 };
  assert.equal(computeExitCode(clean, { gateResult: failed }), 0);
  assert.equal(computeExitCode(clean, { gate: true, gateResult: failed }), 1);
  assert.equal(computeExitCode(clean, { gate: true, gateResult: { failed: false } }), 0);
  assert.equal(computeExitCode(clean, { gate: true, noFail: true, gateResult: failed }), 0);
  assert.equal(computeExitCode({ pagesFailed: 1 }, { gate: true, gateResult: failed }), 2);
});

test('report carries runMetadata.thresholds (V2 and legacy projection) and the HTML shows actual / target', () => {
  const run = { layer: 'axe', engine: { name: 'axe', version: '1' }, viewport: { name: 'desktop', width: 1280, height: 900 }, pageState: 'initial',
    status: 'complete', evidence: { ruleGroups: 0, findingOccurrences: 0, fixUnits: 0, errorCode: null } };
  const gate = evaluateGate([page({ lighthouseScores: lh({ performance: 70 }) })], undefined);
  const report = buildScanReportV2([{ page: 'p', url: 'http://localhost/p', violations: [], scannerRuns: [run] }], { producer: { version: '0.0.0' }, thresholds: gate });
  assert.equal(report.runMetadata.thresholds.failed, true);
  const legacy = projectReportV1(report);
  assert.equal(legacy.thresholds.failed, true);
  assert.match(buildGateSection(legacy), /70 \/ 80/);
}); 

test('gate counts report-model findings by summed occurrences and ignores info', () => {
  const f = (impact, count, extra = {}) => ({ category: 'accessibility', impact, count, layers: ['axe'], ...extra });
  const gate = evaluateGate([page({ findings: [f('serious', 3), f('info', 9), f('minor', 2)] })], { a11y: { serious: 2 } });
  assert.equal(metric(gate, 'a11y.serious').actual, 3);
  assert.equal(metric(gate, 'a11y.serious').status, 'fail');
  assert.equal(metric(gate, 'a11y.minor').actual, 2);
});

test('isNoindex: robots/googlebot meta (any attribute order) and X-Robots-Tag header', () => {
  assert.equal(isNoindex('<meta name="robots" content="noindex, nofollow">'), true);
  assert.equal(isNoindex(`<meta content='NOINDEX' name='googlebot'>`), true);
  assert.equal(isNoindex('<meta name="robots" content="none">'), true);
  assert.equal(isNoindex('<html></html>', { 'x-robots-tag': 'noindex' }), true);
  assert.equal(isNoindex('<meta name="robots" content="index, follow">'), false);
  assert.equal(isNoindex('<meta name="description" content="noindex is a word here">'), false);
  assert.equal(isNoindex('<html></html>', {}), false);
  assert.equal(isNoindex(undefined), false);
});

test('seo is advisory on a noindex target with a reason, --seo-gate forces it', () => {
  const p = (over) => page({ lighthouseScores: lh({ seo: 38 }), ...over });
  const adv = evaluateGate([p({ noindex: true })], undefined);
  const m = metric(adv, 'lighthouse.mobile.seo');
  assert.equal(m.status, 'advisory');
  assert.equal(m.reason, 'target is noindex (preview); use --seo-gate to enforce');
  assert.equal(adv.failed, false);
  assert.equal(adv.pages[0].noindex, true);
  assert.equal(evaluateGate([p({ noindex: true })], undefined, { seoGate: true }).failed, true);
  assert.equal(evaluateGate([p({ noindex: false })], undefined).failed, true);
  // only seo is relaxed
  assert.equal(metric(evaluateGate([p({ noindex: true, lighthouseScores: lh({ performance: 10 }) })], undefined), 'lighthouse.mobile.performance').status, 'fail');
});
