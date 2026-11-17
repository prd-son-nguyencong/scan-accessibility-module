import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireBrowser } from './helpers/require-browser.js';
import { closeBrowser, newPage } from '../src/scanner/browser.js';
import { ORACLES, oracleFails, oracleFocusIndicator } from '../scripts/lib/truth-oracle.js';
import { TRUTH_DIR, loadCases } from '../scripts/lib/truth-corpus.js';
import { COMMITMENTS_URL, checkCommitments, computeConfirmed, findingScs, proposeCommitments, wilson } from '../scripts/lib/confirmed-eval.js';

after(() => closeBrowser());

async function oracleOn(browser, oracleName, html) {
  const page = await newPage(browser);
  try {
    await page.setContent(html);
    return await ORACLES[oracleName](page);
  } finally {
    await page.context().close();
  }
}

const { cases: pairs } = JSON.parse(readFileSync(new URL('labels.json', TRUTH_DIR), 'utf8'));
const read = (rel) => readFileSync(new URL(rel, TRUTH_DIR), 'utf8');

test('oracle: every truth-corpus pair that names an oracle agrees with it (bad fails, clean passes)', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const withOracle = pairs.filter((p) => p.oracle);
  assert.deepEqual([...new Set(withOracle.map((p) => p.oracle))].sort(), ['focusIndicator', 'labelInName', 'targetSize']);
  for (const p of withOracle) {
    const bad = await oracleOn(browser, p.oracle, read(p.bad));
    const good = await oracleOn(browser, p.oracle, read(p.good));
    assert.equal(oracleFails(bad), true, `${p.name}: the oracle finds no failure in the violation fixture ${JSON.stringify(bad)}`);
    assert.equal(oracleFails(good), false, `${p.name}: the oracle fails the clean twin ${JSON.stringify(good)}`);
  }
});

test('oracle: viewport-dependent fixtures fail at 390 only; a 24px pitch passes everywhere', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const gap = await oracleOn(browser, 'targetSize', read('2.5.8/icon-row-mobile-gap-bad.html'));
  assert.equal(gap.desktop.failing.length, 0, 'passes at 1280');
  assert.ok(gap.mobile.failing.length > 0, 'fails at 390');
  const pitch = await oracleOn(browser, 'targetSize', read('2.5.8/stacked-list-pitch-good.html'));
  assert.deepEqual([pitch.desktop.failing, pitch.mobile.failing], [[], []]);
  const tight = await oracleOn(browser, 'targetSize', read('2.5.8/stacked-list-pitch-bad.html'));
  assert.ok(tight.desktop.failing.length > 0 && tight.mobile.failing.length > 0, 'a 20px pitch fails at both');
  const toggle = await oracleOn(browser, 'focusIndicator', read('2.4.7/focus-hidden-mobile-toggle-bad.html'));
  assert.equal(toggle.desktop.failing.length, 0, 'the toggle is hidden at 1280 and the nav links keep their ring');
  assert.ok(toggle.mobile.failing.length > 0, 'the toggle has no visible focus at 390');
});

test('oracle: focus indicator contrast uses the 3:1 line (a pale ring fails, a dark ring passes)', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const page = (color) => `<!doctype html><title>t</title><style>body{background:#fff}a:focus-visible{outline:3px solid ${color}}</style><a href="/x">Link</a>`;
  assert.equal(oracleFails(await oracleOn(browser, 'focusIndicator', page('#cccccc'))), true);
  assert.equal(oracleFails(await oracleOn(browser, 'focusIndicator', page('#0b57d0'))), false);
  assert.equal(typeof oracleFocusIndicator, 'function');
});

test('wilson: known intervals', () => {
  assert.equal(wilson(0, 0), null);
  const half = wilson(5, 10);
  assert.ok(Math.abs(half.lo - 0.2366) < 1e-3 && Math.abs(half.hi - 0.7634) < 1e-3, JSON.stringify(half));
  const none = wilson(0, 10);
  assert.equal(none.lo, 0);
  assert.ok(Math.abs(none.hi - 0.2775) < 1e-3, JSON.stringify(none));
  const all = wilson(10, 10);
  assert.ok(Math.abs(all.hi - 1) < 1e-9);
  assert.ok(Math.abs(all.lo - 0.7225) < 1e-3, JSON.stringify(all));
});

const found = (verdict, scs, rule = 'r') => ({ verdict, scs, rule, layer: 'x' });
test('confirmed metrics: only a confirmed finding for the labelled criterion is a hit; any confirmed finding on a clean twin is a false positive', () => {
  const results = [
    { id: 'a-bad', sc: '2.5.8', truth: 'violation', status: 'complete', findings: [found('confirmed', ['2.5.8'])] },
    { id: 'b-bad', sc: '2.5.8', truth: 'violation', status: 'complete', findings: [found('likely', ['2.5.8']), found('confirmed', ['1.1.1'])] }, // wrong tier and wrong criterion
    { id: 'c-bad', sc: '2.5.3', truth: 'violation', status: 'complete', findings: [found('needs-review', ['2.5.3'])] },
    { id: 'a-good', sc: '2.5.8', truth: 'clean', status: 'complete', findings: [found('confirmed', ['3.1.1'], 'html-lang')] }, // unrelated criterion still counts
    { id: 'b-good', sc: '2.5.8', truth: 'clean', status: 'complete', findings: [found('likely', ['2.5.8'])] },
    { id: 'c-good', sc: '2.5.3', truth: 'clean', status: 'complete', findings: [] },
  ];
  const m = computeConfirmed(results);
  const sc = (id) => m.perSc.find((s) => s.sc === id);
  assert.deepEqual([sc('2.5.8').violations, sc('2.5.8').confirmed, sc('2.5.8').clean, sc('2.5.8').falsePositives], [2, 1, 2, 1]);
  assert.deepEqual([sc('2.5.3').violations, sc('2.5.3').confirmed, sc('2.5.3').falsePositives], [1, 0, 0]);
  assert.deepEqual([m.overall.violations, m.overall.confirmed, m.overall.falsePositives], [3, 1, 1]);
  assert.deepEqual(m.missed.map((x) => [x.id, x.best]), [['b-bad', 'likely'], ['c-bad', 'needs-review']]);
  assert.deepEqual(m.falseAlarms.map((x) => x.id), ['a-good']);
});

test('commitments: proposal rounds recall down and false positives up, a 0% criterion is advisory, validated floors fail the run', () => {
  const results = [
    ...['a', 'b', 'c'].map((n, i) => ({ id: `${n}`, sc: '1.1.1', truth: 'violation', status: 'complete', findings: i < 2 ? [found('confirmed', ['1.1.1'])] : [] })),
    { id: 'g1', sc: '1.1.1', truth: 'clean', status: 'complete', findings: [] },
    { id: 'g2', sc: '1.1.1', truth: 'clean', status: 'complete', findings: [found('confirmed', ['1.1.1'])] },
    { id: 'g3', sc: '1.1.1', truth: 'clean', status: 'complete', findings: [] },
    { id: 'z', sc: '2.5.7', truth: 'violation', status: 'complete', findings: [] },
    { id: 'zg', sc: '2.5.7', truth: 'clean', status: 'complete', findings: [] },
  ];
  const m = computeConfirmed(results);
  const c = proposeCommitments(m);
  assert.deepEqual(c.rules['1.1.1'], { status: 'validated', minRecall: 0.66, maxFalsePositive: 0.34, maxFindingFalsePositives: 1 });
  assert.equal(c.rules['2.5.7'].status, 'advisory');
  assert.match(c.rules['2.5.7'].reason, /fewer than 3 violation fixtures or clean twins \(1 and 1\)/);
  assert.deepEqual(checkCommitments(m, c), [], 'the run that set the thresholds passes');
  const worse = computeConfirmed(results.map((r) => (r.id === 'b' ? { ...r, findings: [] } : r)));
  assert.match(checkCommitments(worse, c).join('\n'), /1\.1\.1: confirmed recall 33\.3% is below minRecall 66%/);
  assert.deepEqual(checkCommitments(computeConfirmed(results.filter((r) => r.sc === '1.1.1' || r.id === 'z')), { rules: { '1.1.1': c.rules['1.1.1'] } }).length, 1, 'a measured criterion without a commitment is reported');
  // A clean twin whose scan did not complete says nothing: it leaves the denominator, and too many of them fail the run.
  const skipped = computeConfirmed([...results, { id: 'g4', sc: '1.1.1', truth: 'clean', status: 'skipped-empty', findings: [] }]);
  assert.equal(skipped.perSc.find((s) => s.sc === '1.1.1').clean, 3);
  assert.deepEqual(skipped.unscanned, [{ id: 'g4', status: 'skipped-empty' }]);
  const many = computeConfirmed([...results, ...['p', 'q', 'r'].map((id) => ({ id, sc: '1.1.1', truth: 'clean', status: 'failed', findings: [] }))]);
  assert.match(checkCommitments(many, c).join('\n'), /3 fixtures did not complete a scan/);
});

test('commitments: validated needs 3 violation fixtures, 3 clean twins and 60% confirmed recall; a clean twin of another criterion counts against the finding\'s criterion', () => {
  const rows = (sc, bad, hits, clean) => [
    ...Array.from({ length: bad }, (_, i) => ({ id: `${sc}-b${i}`, sc, truth: 'violation', status: 'complete', findings: i < hits ? [found('confirmed', [sc])] : [] })),
    ...Array.from({ length: clean }, (_, i) => ({ id: `${sc}-g${i}`, sc, truth: 'clean', status: 'complete', findings: [] })),
  ];
  const c = proposeCommitments(computeConfirmed([...rows('1.1.1', 3, 2, 3), ...rows('1.3.1', 5, 2, 5), ...rows('1.4.3', 2, 2, 3), ...rows('2.4.4', 3, 3, 2), ...rows('3.1.1', 5, 3, 3)])).rules;
  assert.deepEqual(Object.fromEntries(Object.entries(c).map(([sc, r]) => [sc, r.status])), { '1.1.1': 'validated', '1.3.1': 'advisory', '1.4.3': 'advisory', '2.4.4': 'advisory', '3.1.1': 'validated' });
  assert.match(c['1.3.1'].reason, /recall 40% is under 60%/);
  assert.match(c['1.4.3'].reason, /fewer than 3/);
  // the reviewer's case: a 2.5.3 finding confirmed on a twin written for 4.1.2 shows in 2.5.3's own false-alarm count
  const m = computeConfirmed([...rows('2.5.3', 3, 3, 3), ...rows('4.1.2', 3, 3, 3).map((r) => (r.id === '4.1.2-g0' ? { ...r, findings: [found('confirmed', ['2.5.3'])] } : r))]);
  const sc = (id) => m.perSc.find((x) => x.sc === id);
  assert.deepEqual([sc('2.5.3').fpSame, sc('2.5.3').fpFinding, sc('4.1.2').fpFinding], [0, 1, 0]);
  const commitments = proposeCommitments(m);
  assert.deepEqual(checkCommitments(m, commitments), []);
  const cleaner = computeConfirmed([...rows('2.5.3', 3, 3, 3), ...rows('4.1.2', 3, 3, 3)]);
  assert.deepEqual(checkCommitments(cleaner, commitments), [], 'fewer false alarms pass');
  assert.match(checkCommitments(m, { rules: { ...commitments.rules, '2.5.3': { ...commitments.rules['2.5.3'], maxFindingFalsePositives: 0 } } }).join('\n'), /2\.5\.3: 1 clean twins carry a confirmed finding for this criterion, above maxFindingFalsePositives 0/);
});

test('findingScs: the criterion in a wcagRef text or the rule registries', () => {
  const byRule = { axe: { 'target-size': new Set(['2.5.8']) }, accessScan: {}, accessScanHeuristic: {}, htmlValidate: {} };
  assert.deepEqual(findingScs({ wcagRef: 'WCAG 2.2 AA 2.5.8 TargetSize', nativeRuleId: 'TargetSize' }, byRule), ['2.5.8']);
  assert.deepEqual(findingScs({ wcagRef: 'WCAG22AA', nativeRuleId: 'target-size' }, byRule), ['2.5.8']);
  assert.deepEqual(findingScs({ wcagRef: 'WCAG 2.4.7', nativeRuleId: 'focus-not-visible' }, byRule), ['2.4.7']);
  assert.deepEqual(findingScs({ wcagRef: 'Best Practice', nativeRuleId: 'MetaDescription' }, byRule), []);
});

test('accuracy-commitments.json: every labelled criterion has an entry with a status and thresholds in range; no validated entry has under 3 violation fixtures, under 3 clean twins or under 60% recall', async () => {
  const { rules } = JSON.parse(readFileSync(COMMITMENTS_URL, 'utf8'));
  const cases = await loadCases();
  const labelled = [...new Set(cases.map((c) => c.sc))];
  const count = (sc, truth) => cases.filter((c) => c.sc === sc && c.truth === truth).length;
  assert.deepEqual(Object.keys(rules).sort(), labelled.sort());
  for (const [sc, c] of Object.entries(rules)) {
    assert.ok(['validated', 'advisory'].includes(c.status), `${sc}: status ${c.status}`);
    assert.ok(c.minRecall >= 0 && c.minRecall <= 1 && c.maxFalsePositive >= 0 && c.maxFalsePositive <= 1, `${sc}: thresholds out of range`);
    if (c.status === 'validated') {
      assert.ok(c.minRecall >= 0.6, `${sc}: validated needs measured recall of at least 60%`);
      assert.ok(count(sc, 'violation') >= 3 && count(sc, 'clean') >= 3, `${sc}: validated needs 3 violation fixtures and 3 clean twins, has ${count(sc, 'violation')} and ${count(sc, 'clean')}`);
    } else assert.ok(c.reason, `${sc}: an advisory criterion states why`);
  }
});
