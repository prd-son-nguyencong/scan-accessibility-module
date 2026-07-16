export const ACTIVE_RULE_COUNT = 82;
export const LEGACY_READABLE_RULE_ID = 'AriaLabelledbyContentMismatch';
export const CATALOG_RULE_COUNT = ACTIVE_RULE_COUNT + 1;

/**
 * @param {Map<string, { status: string, checks: unknown[] }>} rulesById
 */
export function validateCatalogContract(rulesById) {
  const rules = [...rulesById.values()];
  const active = rules.filter((rule) => rule.status === 'active');
  const legacy = rules
    .filter((rule) => rule.status === 'legacy-readable')
    .map((rule) => rule.id)
    .sort();

  if (active.length !== ACTIVE_RULE_COUNT) {
    throw new Error(
      `catalog contract requires ${ACTIVE_RULE_COUNT} active rules, got ${active.length}`,
    );
  }

  if (legacy.length !== 1 || legacy[0] !== LEGACY_READABLE_RULE_ID) {
    throw new Error(
      `catalog contract requires exactly one legacy-readable rule "${LEGACY_READABLE_RULE_ID}"`,
    );
  }

  if (rulesById.size !== CATALOG_RULE_COUNT) {
    throw new Error(
      `catalog contract requires ${CATALOG_RULE_COUNT} total rules, got ${rulesById.size}`,
    );
  }
}
