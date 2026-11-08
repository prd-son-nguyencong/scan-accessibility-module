import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderRuleCoverageDoc, ruleDocFacts } from '../scripts/lib/rule-doc.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('docs/accessscan-rule-coverage.md matches the registry (run npm run docs:rules)', async () => {
  assert.equal(read('docs/accessscan-rule-coverage.md'), await renderRuleCoverageDoc());
});

test('rule counts in README and docs agree with the registry', async () => {
  const { active } = await ruleDocFacts();
  for (const rel of ['README.md', 'docs/accessscan-rules-for-po.md', 'docs/2026-05-02-scan-autofix-pipeline-design.md']) {
    const text = read(rel);
    for (const [, n] of text.matchAll(/(\d{2,}) active\b/g)) assert.equal(Number(n), active, `${rel}: "${n} active"`);
    for (const [, n] of text.matchAll(/Total Rules:\*\* (\d+)/g)) assert.equal(Number(n), active, `${rel}: Total Rules ${n}`);
  }
});
