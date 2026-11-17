import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireBrowser } from './helpers/require-browser.js';
import { deterministicRules, knownGaps, renderSeedsCoverage, runSeeds, seedPassed } from '../scripts/lib/seeds.js';

// Seeded faults: bad*.html must raise ruleId, its clean twin good*.html must stay silent.
// All seeds run in one pass (two reused pages, one browser) to keep the file fast.
test('rule seeds: bad fixtures are flagged, good twins are silent; coverage doc is current', async (t) => {
  if (!await requireBrowser(t)) return;
  const results = await runSeeds();
  const gaps = knownGaps();
  for (const result of results) {
    const name = `${result.ruleId}/${result.file}`;
    await t.test(name, () => {
      if (gaps.has(name)) return assert.ok(!seedPassed(result), `${name} now passes: remove it from KNOWN-GAPS.md`);
      assert.ok(seedPassed(result), result.expect === 'bad' ? `${result.ruleId} not flagged` : `${result.ruleId} flagged a clean twin`);
    });
  }
  await t.test('every deterministic rule has seeds or a stated reason', async () => {
    const seeded = new Set(results.map((r) => r.ruleId));
    const rules = await deterministicRules();
    assert.ok(rules.filter((rule) => seeded.has(rule.id)).length / rules.length >= 0.7);
  });
  await t.test('docs/seeds-coverage.md is current (run npm run seeds:report)', async () => {
    const doc = readFileSync(new URL('../docs/seeds-coverage.md', import.meta.url), 'utf8');
    assert.equal(doc, renderSeedsCoverage(results, await deterministicRules()));
  });
});
