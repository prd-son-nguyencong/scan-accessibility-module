/**
 * @typedef {import('./schema.js').ProfileId} ProfileId
 * @typedef {import('./schema.js').RuleCheckDescriptor} RuleCheckDescriptor
 */

export const PROFILES = Object.freeze({
  STANDARDS: 'standards',
  COMMERCIAL_PARITY: 'commercial-parity',
});

/**
 * @param {RuleCheckDescriptor} check
 * @returns {boolean}
 */
export function isParityOnlyCheck(check) {
  return (
    check.profiles.length === 1
    && check.profiles[0] === PROFILES.COMMERCIAL_PARITY
  );
}

/**
 * Standards checks run in both profiles when declared.
 * Parity-only checks never run in standards.
 * Commercial-parity is a true overlay: standards checks plus parity-only checks.
 *
 * @param {RuleCheckDescriptor[]} checks
 * @param {ProfileId} profile
 * @returns {RuleCheckDescriptor[]}
 */
export function filterChecksForProfile(checks, profile) {
  if (profile === PROFILES.STANDARDS) {
    return checks.filter((check) => check.profiles.includes(PROFILES.STANDARDS));
  }
  return checks.filter((check) => (
    check.profiles.includes(PROFILES.STANDARDS)
    || check.profiles.includes(PROFILES.COMMERCIAL_PARITY)
  ));
}
