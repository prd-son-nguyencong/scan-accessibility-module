const CANONICAL_RULE_IDS = Object.freeze({
  StickyHeaderObscuresFocus: 'FocusNotObscuredHeader',
  TablistRole: 'TabListMisMatch',
});

export function canonicalizeRuleId(nativeRuleId) {
  return CANONICAL_RULE_IDS[nativeRuleId] || nativeRuleId;
}
