import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReadme } from '../scripts/lib/readme-doc.js';
import { ruleDocFacts } from '../scripts/lib/rule-doc.js';
import { KNOWN_LAYERS } from '../src/utils/config.js';
import { USAGE } from '../src/utils/cli-args.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('README generated blocks match the CLI help and the registry (run pnpm docs:readme)', async () => {
  assert.equal(readme, await renderReadme(readme));
});

test('README layer and rule counts equal the registry numbers', async () => {
  const { active } = await ruleDocFacts();
  const [, layers] = /(\d+) scan layers/.exec(readme);
  const [, rules] = /(\d+) active accessScan rules/.exec(readme);
  assert.equal(Number(layers), KNOWN_LAYERS.length);
  assert.equal(Number(rules), active);
  assert.ok(active > 50, 'registry did not load');
});

test('every long flag in the CLI help appears in the README flags table', () => {
  const flags = [...USAGE.matchAll(/^ {2}(--[a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(flags.length > 20);
  for (const f of flags) assert.ok(readme.includes(`\`${f}`), `README misses ${f}`);
});

test('README carries no stale claims', () => {
  for (const stale of [/\bROI Summary\b/, /\bFour layers\b/, /\bTen scan layers\b/, /\b851\b/, /\b491\/491\b/, /site-\d{3}/, /accessscan-parity-playbook/]) {
    assert.doesNotMatch(readme, stale);
  }
});
