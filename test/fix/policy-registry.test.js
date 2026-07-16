import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NON_PROPOSABLE_POLICIES,
  POLICIES,
  canGenerateProposal,
  lookupPolicyDecision,
} from '../../src/fix/policy/registry.js';

test('NON_PROPOSABLE_POLICIES export cannot be mutated to allow proposals', () => {
  assert.equal(canGenerateProposal({ policy: POLICIES.MANUAL_ONLY }), false);
  assert.throws(() => {
    NON_PROPOSABLE_POLICIES.push(POLICIES.SEMANTIC_ASSISTANCE);
  });
  assert.equal(canGenerateProposal({ policy: POLICIES.MANUAL_ONLY }), false);
  assert.equal(canGenerateProposal({ policy: POLICIES.UNSUPPORTED }), false);
});

test('policy lookup does not treat sourceOwner.file as a rule id', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u1',
    kind: 'accessibility',
    canonicalRuleId: null,
    sourceOwner: { file: 'src/partials/header.liquid' },
    findings: [{ fix: { deterministic: false } }],
  });
  assert.equal(decision.policy, POLICIES.UNSUPPORTED);
});

test('deterministic finding flag routes to mechanically_safe', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u2',
    kind: 'accessibility',
    findings: [{ fix: { deterministic: true } }],
  });
  assert.equal(decision.policy, POLICIES.MECHANICALLY_SAFE);
});

test('policy lookup honors trusted descriptor evidence.fixPolicy', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u-policy',
    kind: 'accessibility',
    findings: [{
      fix: { deterministic: false },
      evidence: { fixPolicy: 'semantic_assistance', violationType: 'potential' },
    }],
  });
  assert.equal(decision.policy, POLICIES.SEMANTIC_ASSISTANCE);
});

test('trusted mechanically_safe policy does not auto-fix uncertain findings', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u-uncertain',
    kind: 'accessibility',
    findings: [{
      fix: { deterministic: false },
      evidence: { fixPolicy: 'mechanically_safe', violationType: 'potential' },
    }],
  });
  assert.equal(decision.policy, POLICIES.MANUAL_ONLY);
});

test('unknown accessibility unit without deterministic flag is unsupported', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u3',
    kind: 'accessibility',
    findings: [{ fix: { deterministic: false } }],
  });
  assert.equal(decision.policy, POLICIES.UNSUPPORTED);
});
