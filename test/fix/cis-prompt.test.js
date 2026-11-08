import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSanitizedFixUnitSnapshot,
  isPathBearingString,
} from '../../src/fix/cis/prompt.js';

test('isPathBearingString rejects bare filenames with allowlisted extensions', () => {
  for (const value of ['sample.liquid', 'foo.html', 'x.js', 'x.css', 'Sort.jobs.liquid']) {
    assert.equal(isPathBearingString(value), true, `expected path-bearing: ${value}`);
  }
});

test('isPathBearingString allows non-path diagnostic text', () => {
  assert.equal(isPathBearingString('Sort select has no accessible name'), false);
  assert.equal(isPathBearingString('select-name'), false);
});

test('buildSanitizedFixUnitSnapshot omits title with bare filename', () => {
  const snapshot = buildSanitizedFixUnitSnapshot({
    fixUnitId: 'sha256:unit',
    kind: 'accessibility',
    canonicalRuleId: 'select-name',
    findingIds: ['sha256:abc'],
    title: 'Issue in sample.liquid',
    evidence: [{ layer: 'axe', nativeRuleId: 'select-name', message: 'see foo.html' }],
  });
  assert.equal(snapshot.title, undefined);
  assert.equal(snapshot.evidence[0].message, undefined);
});
