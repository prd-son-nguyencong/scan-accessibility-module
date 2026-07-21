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

test('LinkOpensNewWindow routes to semantic assistance with manual AT check', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u-link-opens-new-window',
    kind: 'accessibility',
    canonicalRuleId: 'LinkOpensNewWindow',
    sourceOwner: { file: 'src/partials/layout/header.liquid', line: 7 },
    findings: [{
      canonicalRuleId: 'LinkOpensNewWindow',
      nativeRuleId: 'LinkOpensNewWindow',
      fix: { deterministic: false },
    }],
  });
  assert.equal(decision.policy, POLICIES.SEMANTIC_ASSISTANCE);
  assert.equal(decision.reasonCode, 'SEMANTIC_LABEL_OR_STRUCTURE');
  assert.deepEqual(decision.requiredManualChecks, [
    'Confirm the assistive technology announcement matches the intended accessible name or label.',
  ]);
});

test('LinkCurrentPage routes to semantic assistance with manual AT check', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u-link-current-page',
    kind: 'accessibility',
    canonicalRuleId: 'LinkCurrentPage',
    sourceOwner: { file: 'src/partials/layout/header.liquid', line: 22 },
    findings: [{
      canonicalRuleId: 'LinkCurrentPage',
      nativeRuleId: 'LinkCurrentPage',
      fix: { deterministic: false },
    }],
  });
  assert.equal(decision.policy, POLICIES.SEMANTIC_ASSISTANCE);
  assert.equal(decision.reasonCode, 'SEMANTIC_LABEL_OR_STRUCTURE');
  assert.deepEqual(decision.requiredManualChecks, [
    'Confirm the assistive technology announcement matches the intended accessible name or label.',
  ]);
});

test('unknown PascalCase AccessScan rule stays unsupported', () => {
  const decision = lookupPolicyDecision({
    fixUnitId: 'u-unknown-pascal',
    kind: 'accessibility',
    canonicalRuleId: 'LinkAnchorAmbiguous',
    findings: [{ fix: { deterministic: false } }],
  });
  assert.equal(decision.policy, POLICIES.UNSUPPORTED);
});
