import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixUnits } from '../../src/fix/canonical/fix-unit.js';
import { FixCanonicalizerError } from '../../src/fix/canonical/fix-unit.js';

function finding(id, overrides = {}) {
  return {
    findingId: id,
    nativeRuleId: 'select-name',
    canonicalRuleId: 'select-name',
    layer: 'axe',
    category: 'accessibility',
    pageState: 'initial',
    route: '/',
    element: { selector: '#x', normalizedHtmlHash: 'sha256:dom' },
    source: {
      file: 'src/partials/a.liquid',
      line: 1,
      preimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    evidence: { observations: [{ layer: 'axe', nativeRuleId: 'select-name' }] },
    ...overrides,
  };
}

test('buildFixUnits rejects missing findingId', () => {
  assert.throws(
    () => buildFixUnits([finding('sha256:a'), { ...finding('sha256:b'), findingId: null }]),
    (error) => error instanceof FixCanonicalizerError && error.code === 'MISSING_FINDING_ID',
  );
});

test('buildFixUnits rejects duplicate findingId values', () => {
  assert.throws(
    () => buildFixUnits([finding('sha256:dup'), finding('sha256:dup')]),
    (error) => error instanceof FixCanonicalizerError && error.code === 'DUPLICATE_FINDING_ID',
  );
});
