import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, DEFAULT_CONFIG } from '../src/utils/config.js';

test('mergeConfig shallow-merges nested objects without dropping defaults', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { layers: { w3c: false } });
  assert.equal(merged.layers.w3c, false);
  assert.equal(merged.layers.axe, true); // default preserved
  assert.equal(merged.baseUrl, DEFAULT_CONFIG.baseUrl);
});

test('mergeConfig replaces arrays wholesale', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { skipRules: ['color-contrast'] });
  assert.deepEqual(merged.skipRules, ['color-contrast']);
});

test('mergeConfig overrides scalars and adds new keys', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { baseUrl: 'http://localhost:3000', extra: 1 });
  assert.equal(merged.baseUrl, 'http://localhost:3000');
  assert.equal(merged.extra, 1);
});

test('mergeConfig does not mutate the base', () => {
  const before = structuredClone(DEFAULT_CONFIG);
  mergeConfig(DEFAULT_CONFIG, { layers: { axe: false } });
  assert.deepEqual(DEFAULT_CONFIG, before);
});

test('DEFAULT_CONFIG carries the new host-integration fields', () => {
  for (const key of ['devCommand', 'buildCommand', 'buildEnv', 'outDir', 'source', 'distMap', 'thirdParty', 'suppress']) {
    assert.ok(key in DEFAULT_CONFIG, `missing ${key}`);
  }
});
