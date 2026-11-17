import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { requireBrowser } from './helpers/require-browser.js';
import { ENGINES, TRUTH_DIR, computeMetrics, renderTruthMetrics, runTruth } from '../scripts/lib/truth-corpus.js';
import { WCAG_CRITERIA } from '../src/utils/wcag-criteria.js';

test('computeMetrics: recall, false-positive rate and agreement from hand-counted results', () => {
  const found = (axe = [], accessScan = []) => ({ axe, accessScan, accessScanHeuristic: [], htmlValidate: [] });
  // SC 1.1.1 is covered by axe and accessScan; SC 9.9.9 by axe only. A heuristic hit must not count anywhere solid.
  const covers = (layer, sc) => (sc === '1.1.1' ? ['axe', 'accessScan'].includes(layer) : layer === 'axe');
  const results = [
    { id: 'a', sc: '1.1.1', truth: 'violation', found: found(['1.1.1'], ['1.1.1']) }, // both detect
    { id: 'b', sc: '1.1.1', truth: 'violation', found: found(['1.1.1'], []) }, // only axe detects: disagreement
    { id: 'c', sc: '1.1.1', truth: 'clean', found: found([], ['1.1.1']) }, // accessScan false positive: disagreement
    { id: 'd', sc: '1.1.1', truth: 'clean', found: found() }, // both silent: agreement
    { id: 'e', sc: '9.9.9', truth: 'violation', found: found() }, // axe misses; accessScan out of scope
    { id: 'f', sc: '1.1.1', truth: 'violation', found: { ...found(), accessScanHeuristic: ['1.1.1'] } }, // only the heuristic hits
  ];
  const m = computeMetrics(results, covers);
  const row = (name) => m.engines.find((e) => e.engine === name);
  assert.deepEqual(ENGINES, ['axe', 'accessScan', 'accessScanHeuristic', 'htmlValidate']);
  assert.deepEqual([row('axe').violations, row('axe').detected, row('axe').clean, row('axe').falsePositives], [4, 2, 2, 0]);
  assert.deepEqual([row('accessScan').violations, row('accessScan').detected, row('accessScan').falsePositives, row('accessScan').outOfScope], [3, 1, 1, 1]);
  assert.equal(m.shared, 5); // a, b, c, d, f are covered by two solid layers; e by one
  assert.equal(m.agreed, 3); // a (both flag), d (both silent) and f (both silent: the heuristic hit is ignored)
  const sc = m.perSc.find((s) => s.sc === '1.1.1');
  assert.deepEqual([sc.violations, sc.any, sc.falsePositives], [3, 2, 1]);
});

// One pass over every fixture (two reused pages, one browser), like test/rule-seeds.test.js.
test('truth corpus: pairs are well formed, bad fires, clean stays silent, full criteria are seeded, doc is current', async (t) => {
  if (!await requireBrowser(t)) return;
  const { cases: pairs } = JSON.parse(readFileSync(new URL('labels.json', TRUTH_DIR), 'utf8'));
  const { results, covers } = await runTruth();
  const known = new Map(WCAG_CRITERIA.map((c) => [c.id, c]));

  await t.test('labels.json: at least 15 pairs, existing files, known criteria, a stated basis', () => {
    assert.ok(pairs.length >= 15, `${pairs.length} pairs`);
    for (const p of pairs) {
      assert.ok(known.has(p.sc), `${p.name}: unknown criterion ${p.sc}`);
      assert.ok(existsSync(new URL(p.bad, TRUTH_DIR)) && existsSync(new URL(p.good, TRUTH_DIR)), `${p.name}: file missing`);
      assert.ok(p.basis.length > 20, `${p.name}: state why the bad fixture violates the criterion`);
    }
  });
  await t.test('every truth-corpus violation is flagged for its criterion by some layer; no clean twin by a deterministic layer', () => {
    for (const r of results.filter((x) => x.id.startsWith('truth-corpus/'))) {
      const layers = ENGINES.filter((e) => r.found[e].includes(r.sc));
      const known = pairs.find((p) => `truth-corpus/${p.bad}` === r.id)?.knownMiss; // an admitted gap: must flip when a rule is added
      if (r.truth === 'violation') assert.equal(layers.length > 0, !known, `${r.id}: ${known ? 'now flagged, drop knownMiss' : `no layer flags SC ${r.sc}`}`);
      else assert.deepEqual(layers.filter((e) => e !== 'accessScanHeuristic'), [], `${r.id}: flagged although clean`);
    }
  });
  await t.test('every criterion the coverage matrix marks full has seeded violations and clean twins', () => {
    for (const c of WCAG_CRITERIA.filter((x) => x.coverage === 'full')) {
      const own = results.filter((r) => r.sc === c.id);
      assert.ok(own.some((r) => r.truth === 'violation') && own.some((r) => r.truth === 'clean'), `${c.id} has no truth-corpus pair`);
    }
  });
  await t.test('the six criteria that had only rule-seeds now have truth-corpus pairs; every full criterion has one', () => {
    for (const sc of ['1.4.4', '2.2.1', '2.4.11', '2.5.8', '3.2.1', '3.2.2']) assert.ok(pairs.some((p) => p.sc === sc), sc);
    for (const c of WCAG_CRITERIA.filter((x) => x.coverage === 'full')) assert.ok(pairs.some((p) => p.sc === c.id), c.id);
  });
  await t.test('docs/truth-metrics.md is current (run npm run truth:metrics)', () => {
    assert.equal(readFileSync(new URL('../docs/truth-metrics.md', import.meta.url), 'utf8'), renderTruthMetrics(results, covers));
  });
}, { timeout: 1_200_000 }); // 231 fixtures scan one page each; the 300 s suite default is too short on a loaded machine
