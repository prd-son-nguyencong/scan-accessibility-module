import { canonicalizeRuleId } from '../../reporter/rule-aliases.js';

/** Cross-scanner aliases that may merge into one canonical root cause. */
const CROSS_SCANNER_ALIASES = Object.freeze({
  'form-field-multiple-label': 'form-control-accessible-name',
  'label': 'form-control-accessible-name',
  'select-name': 'form-control-accessible-name',
  'input-button-name': 'form-control-accessible-name',
  'button-name': 'interactive-control-accessible-name',
  'link-name': 'link-accessible-name',
});

export function canonicalRuleForFixUnit(nativeRuleId) {
  const reporterCanonical = canonicalizeRuleId(nativeRuleId);
  return CROSS_SCANNER_ALIASES[reporterCanonical]
    || CROSS_SCANNER_ALIASES[nativeRuleId]
    || reporterCanonical
    || nativeRuleId;
}

export function rulesMergeCompatible(leftRuleId, rightRuleId) {
  return canonicalRuleForFixUnit(leftRuleId) === canonicalRuleForFixUnit(rightRuleId);
}
