export const POLICY_VERSION = '1';

export const POLICIES = Object.freeze({
  MECHANICALLY_SAFE: 'mechanically_safe',
  SEMANTIC_ASSISTANCE: 'semantic_assistance',
  MANUAL_ONLY: 'manual_only',
  UNSUPPORTED: 'unsupported',
});

const NON_PROPOSABLE_SET = new Set([
  POLICIES.MANUAL_ONLY,
  POLICIES.UNSUPPORTED,
]);

export const NON_PROPOSABLE_POLICIES = Object.freeze([
  POLICIES.MANUAL_ONLY,
  POLICIES.UNSUPPORTED,
]);

const DEFAULT_POLICY_BY_RULE = Object.freeze({
  'color-contrast': POLICIES.MANUAL_ONLY,
  'manual-check': POLICIES.MANUAL_ONLY,
  'unsupported-rule': POLICIES.UNSUPPORTED,
  'button-name': POLICIES.SEMANTIC_ASSISTANCE,
  'interactive-control-accessible-name': POLICIES.SEMANTIC_ASSISTANCE,
  'image-alt': POLICIES.SEMANTIC_ASSISTANCE,
  'input-image-alt': POLICIES.SEMANTIC_ASSISTANCE,
  'label': POLICIES.SEMANTIC_ASSISTANCE,
  'link-name': POLICIES.SEMANTIC_ASSISTANCE,
  'link-accessible-name': POLICIES.SEMANTIC_ASSISTANCE,
  'select-name': POLICIES.SEMANTIC_ASSISTANCE,
  'form-control-accessible-name': POLICIES.SEMANTIC_ASSISTANCE,
  'aria-allowed-attr': POLICIES.SEMANTIC_ASSISTANCE,
  'aria-required-attr': POLICIES.SEMANTIC_ASSISTANCE,
  'aria-valid-attr-value': POLICIES.SEMANTIC_ASSISTANCE,
  'document-title': POLICIES.SEMANTIC_ASSISTANCE,
  'meta-viewport': POLICIES.MANUAL_ONLY,
  'state-dependent': POLICIES.MANUAL_ONLY,
});

const DESCRIPTOR_POLICY_MAP = Object.freeze({
  mechanically_safe: POLICIES.MECHANICALLY_SAFE,
  semantic_assistance: POLICIES.SEMANTIC_ASSISTANCE,
  manual_only: POLICIES.MANUAL_ONLY,
  unsupported: POLICIES.UNSUPPORTED,
});

function hasConfirmedDeterministicFinding(fixUnit) {
  return fixUnit.findings?.some((finding) => (
    finding.fix?.deterministic
    && finding.evidence?.violationType === 'confirmed'
  )) ?? false;
}

function trustedDescriptorPolicy(fixUnit) {
  return fixUnit.findings
    ?.map((finding) => finding.evidence?.fixPolicy)
    .find((policy) => policy && DESCRIPTOR_POLICY_MAP[policy]);
}

export function lookupPolicyDecision(fixUnit) {
  const canonicalRuleId = fixUnit.canonicalRuleId || null;
  const trustedPolicy = trustedDescriptorPolicy(fixUnit);
  let policy;

  if (trustedPolicy === POLICIES.MECHANICALLY_SAFE && !hasConfirmedDeterministicFinding(fixUnit)) {
    policy = POLICIES.MANUAL_ONLY;
  } else if (trustedPolicy) {
    policy = trustedPolicy;
  } else if (fixUnit.findings?.some((finding) => finding.fix?.deterministic)) {
    policy = POLICIES.MECHANICALLY_SAFE;
  } else if (canonicalRuleId && DEFAULT_POLICY_BY_RULE[canonicalRuleId]) {
    policy = DEFAULT_POLICY_BY_RULE[canonicalRuleId];
  } else if (fixUnit.kind === 'performance') {
    policy = POLICIES.MANUAL_ONLY;
  } else {
    policy = POLICIES.UNSUPPORTED;
  }

  return {
    policyVersion: POLICY_VERSION,
    policy,
    reasonCode: policy === POLICIES.MECHANICALLY_SAFE
      ? 'DETERMINISTIC_RULE_AVAILABLE'
      : policy === POLICIES.SEMANTIC_ASSISTANCE
        ? 'SEMANTIC_LABEL_OR_STRUCTURE'
        : policy === POLICIES.MANUAL_ONLY && fixUnit.kind === 'performance'
          ? 'PERFORMANCE_LAYER_UNSUPPORTED'
          : policy === POLICIES.MANUAL_ONLY
            ? 'MANUAL_REVIEW_REQUIRED'
            : 'UNSUPPORTED_RULE',
    allowedFileTypes: ['.liquid', '.html', '.js', '.css'],
    requiredManualChecks: policy === POLICIES.MANUAL_ONLY
      ? ['Complete the documented manual verification procedure.']
      : (policy === POLICIES.SEMANTIC_ASSISTANCE
        ? ['Confirm the assistive technology announcement matches the intended accessible name or label.']
        : []),
  };
}

export function canGenerateProposal(policyDecision) {
  return !NON_PROPOSABLE_SET.has(policyDecision.policy);
}
