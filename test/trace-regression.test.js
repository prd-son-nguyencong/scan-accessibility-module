import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FINGERPRINT } from '../src/tracer/fingerprint-map.js';
import { collectTraceRows, renderTraceMetrics, summarizeTraceRows } from '../scripts/lib/trace-metrics.js';

const rows = collectTraceRows();

for (const row of rows) {
  test(`trace regression: ${row.adapter} ${row.mode}: ${row.name} is ${row.expect}`, () => {
    assert.equal(row.confidence, row.expect);
    assert.notEqual(row.verdict, 'wrong');
    assert.equal(row.wrongHigh, false);
    assert.equal(row.reason, { ambiguous: 'multiple-candidates', untraceable: row.reason }[row.expect] ?? null);
  });
}

// Preview high vs medium follows traced evidence (marker owner + fingerprint score), not the case name.
test('trace regression: preview fingerprint answers are high exactly with a marker owner and a score of HIGH_SCORE', () => {
  const scored = rows.filter((r) => r.mode === 'preview' && r.evidence.includes('fingerprint') && r.confidence !== 'ambiguous');
  assert.ok(scored.length > 30);
  for (const r of scored) {
    const score = Number(r.evidence.find((e) => e.startsWith('fp-score:')).slice(9));
    const owned = r.evidence.some((e) => e.startsWith('marker:'));
    assert.equal(r.confidence === 'high', owned && score >= FINGERPRINT.HIGH_SCORE, `${r.name}: ${r.confidence}, score ${score}, owned ${owned}`);
  }
});

// Counts are fixed by hand from the fixtures (see scripts/lib/trace-metrics.js); a change here is a behavior change.
test('trace regression: exact counts per adapter and mode', () => {
  const want = {
    'paradox-liquid|local': { traceable: 43, correct: 40, ambiguous: 3, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 6 },
    'paradox-liquid|preview': { traceable: 40, correct: 37, ambiguous: 3, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 5 },
    'html|local': { traceable: 10, correct: 9, ambiguous: 1, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 2 },
    'html|preview': { traceable: 10, correct: 9, ambiguous: 1, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 2 },
    'react|local': { traceable: 5, correct: 5, ambiguous: 0, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 3 },
    'react|preview': { traceable: 5, correct: 5, ambiguous: 0, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 3 },
  };
  const got = Object.fromEntries(summarizeTraceRows(rows).map(({ adapter, mode, ...counts }) => [`${adapter}|${mode}`, counts]));
  assert.deepEqual(got, want);
});

test('Gate 3: zero wrong high and at least 80% of traceable elements correct per adapter', () => {
  const byAdapter = {};
  for (const g of summarizeTraceRows(rows)) {
    const a = (byAdapter[g.adapter] ||= { traceable: 0, correct: 0, wrongHigh: 0 });
    a.traceable += g.traceable;
    a.correct += g.correct;
    a.wrongHigh += g.wrongHigh;
  }
  assert.deepEqual(Object.keys(byAdapter).sort(), ['html', 'paradox-liquid', 'react']);
  for (const [adapter, a] of Object.entries(byAdapter)) {
    assert.equal(a.wrongHigh, 0, adapter);
    assert.ok(a.correct / a.traceable >= 0.8, `${adapter}: ${a.correct}/${a.traceable}`);
  }
});

test('docs/trace-metrics.md matches the fixtures (run npm run trace:metrics)', () => {
  assert.equal(readFileSync(new URL('../docs/trace-metrics.md', import.meta.url), 'utf8'), renderTraceMetrics());
});
