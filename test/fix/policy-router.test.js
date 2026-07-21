import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICIES } from '../../src/fix/policy/registry.js';
import { partitionProposableUnits, routeFixUnitPolicies } from '../../src/fix/policy/router.js';

function unit(id, overrides = {}) {
  return {
    fixUnitId: id,
    kind: 'accessibility',
    canonicalRuleId: overrides.canonicalRuleId || 'select-name',
    sourceOwner: { file: 'src/partials/a.liquid', preimageSha256: 'sha256:a' },
    findings: overrides.findings || [{ fix: { deterministic: false } }],
    ...overrides,
  };
}

test('manual_only and unsupported cannot enter proposal generation', () => {
  const units = [
    unit('u-manual', { canonicalRuleId: 'color-contrast' }),
    unit('u-unsupported', { canonicalRuleId: 'unsupported-rule' }),
  ];
  const routed = routeFixUnitPolicies(units);
  assert.equal(routed[0].decision.policy, POLICIES.MANUAL_ONLY);
  assert.equal(routed[0].proposalAllowed, false);
  assert.equal(routed[1].decision.policy, POLICIES.UNSUPPORTED);
  assert.equal(routed[1].proposalAllowed, false);
});

test('mechanically_safe can enter proposal generation; performance is manual-only', () => {
  const units = [
    unit('u-safe', {
      findings: [{ fix: { deterministic: true } }],
    }),
    unit('u-performance', { kind: 'performance', canonicalRuleId: 'lcp' }),
  ];
  const routed = routeFixUnitPolicies(units);
  assert.equal(routed[0].decision.policy, POLICIES.MECHANICALLY_SAFE);
  assert.equal(routed[0].proposalAllowed, true);
  assert.equal(routed[1].decision.policy, POLICIES.MANUAL_ONLY);
  assert.equal(routed[1].proposalAllowed, false);
});

test('mixed partition preserves each unit exactly once', () => {
  const units = [
    unit('u-safe', { findings: [{ fix: { deterministic: true } }] }),
    unit('u-manual', { canonicalRuleId: 'color-contrast' }),
    unit('u-performance', { kind: 'performance', canonicalRuleId: 'cls' }),
  ];
  const { proposable, blocked, routed } = partitionProposableUnits(units);
  assert.equal(proposable.length, 1);
  assert.equal(blocked.length, 2);
  assert.equal(routed.length, 3);
  const seen = new Set([
    ...proposable.map((item) => item.fixUnitId),
    ...blocked.map((item) => item.unit.fixUnitId),
  ]);
  assert.equal(seen.size, 3);
  assert.deepEqual([...seen].sort(), ['u-manual', 'u-performance', 'u-safe']);
});

test('header LinkOpensNewWindow and LinkCurrentPage units are proposable semantic assistance', () => {
  const units = [
    unit('u-link-opens-new-window', {
      canonicalRuleId: 'LinkOpensNewWindow',
      sourceOwner: { file: 'src/partials/layout/header.liquid', line: 7, preimageSha256: 'sha256:a' },
    }),
    unit('u-link-current-page', {
      canonicalRuleId: 'LinkCurrentPage',
      sourceOwner: { file: 'src/partials/layout/header.liquid', line: 22, preimageSha256: 'sha256:b' },
    }),
  ];
  const { proposable, blocked, routed } = partitionProposableUnits(units);
  assert.equal(proposable.length, 2);
  assert.equal(blocked.length, 0);
  assert.equal(routed[0].decision.policy, POLICIES.SEMANTIC_ASSISTANCE);
  assert.equal(routed[0].proposalAllowed, true);
  assert.equal(routed[1].decision.policy, POLICIES.SEMANTIC_ASSISTANCE);
  assert.equal(routed[1].proposalAllowed, true);
  assert.deepEqual(routed[0].decision.requiredManualChecks, [
    'Confirm the assistive technology announcement matches the intended accessible name or label.',
  ]);
});
