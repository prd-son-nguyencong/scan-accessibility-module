const NATIVE_TO_COMMERCIAL_RULE_IDS = Object.freeze({
  StickyHeaderObscuresFocus: 'FocusNotObscuredHeader',
  TablistRole: 'TabListMisMatch',
  MetaViewportPresent: 'PageMetaViewportValid',
  MetaViewportScalable: 'PageMetaViewportValid',
  PageTitle: 'PageTitleValid',
  PageTitleDescriptive: 'PageTitleValid',
});

const COMMERCIAL_TO_NATIVE_RULE_IDS = Object.freeze({
  FocusNotObscuredHeader: 'StickyHeaderObscuresFocus',
  TabListMisMatch: 'TablistRole',
  ListNotEmpty: 'ListEmpty',
  PageTitleValid: 'PageTitle',
  PageMetaViewportValid: 'MetaViewportScalable',
});

const KNOWN_EXTERNAL_COMMERCIAL_RULE_IDS = Object.freeze(
  new Set(Object.keys(COMMERCIAL_TO_NATIVE_RULE_IDS)),
);

/**
 * Maps an internal native accessScan rule id to the commercial report alias.
 *
 * @param {string} nativeRuleId
 * @returns {string}
 */
export function canonicalizeRuleId(nativeRuleId) {
  return NATIVE_TO_COMMERCIAL_RULE_IDS[nativeRuleId] || nativeRuleId;
}

/**
 * Maps a commercial oracle rule id to the internal native accessScan rule id.
 *
 * @param {string} externalRuleId
 * @returns {string}
 */
export function resolveNativeRuleId(externalRuleId) {
  const nativeRuleId = COMMERCIAL_TO_NATIVE_RULE_IDS[externalRuleId];
  if (!nativeRuleId) {
    throw new Error(`Unknown external commercial rule id: ${externalRuleId}`);
  }
  return nativeRuleId;
}

/**
 * @param {string} nativeRuleId
 * @returns {string}
 */
export function resolveCommercialRuleId(nativeRuleId) {
  return canonicalizeRuleId(nativeRuleId);
}

/**
 * @param {string} externalRuleId
 * @returns {boolean}
 */
export function isKnownExternalCommercialRuleId(externalRuleId) {
  return KNOWN_EXTERNAL_COMMERCIAL_RULE_IDS.has(externalRuleId);
}

/**
 * Normalizes any external commercial or native rule id to the shared
 * acceptance identity used by corpus fingerprinting and differential gates.
 *
 * @param {string} ruleId
 * @returns {string}
 */
export function normalizeCorpusRuleId(ruleId) {
  if (!ruleId || typeof ruleId !== 'string') return 'unknown-rule';
  const nativeRuleId = COMMERCIAL_TO_NATIVE_RULE_IDS[ruleId] || ruleId;
  return canonicalizeRuleId(nativeRuleId);
}

export {
  COMMERCIAL_TO_NATIVE_RULE_IDS,
  NATIVE_TO_COMMERCIAL_RULE_IDS,
};
