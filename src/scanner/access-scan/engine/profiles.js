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
 * Profiles are independent: a check runs only when its declared profile list
 * includes the active profile. Dual-profile checks run in both systems;
 * standards-only and parity-only checks never cross profiles.
 *
 * @param {RuleCheckDescriptor[]} checks
 * @param {ProfileId} profile
 * @returns {RuleCheckDescriptor[]}
 */
export function filterChecksForProfile(checks, profile) {
  return checks.filter((check) => check.profiles.includes(profile));
}

/**
 * @param {{
 *   profile?: ProfileId | null,
 *   includeThirdParty?: boolean,
 * }} [options]
 * @returns {ProfileId}
 */
export function resolveScanProfile(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'profile')) {
    const { profile } = options;
    if (profile === undefined || profile === null) {
      return PROFILES.STANDARDS;
    }
    if (typeof profile !== 'string') {
      throw new AccessScanUnknownProfileError(String(profile));
    }
    if (profile === '') {
      throw new AccessScanUnknownProfileError(profile);
    }
    if (!Object.values(PROFILES).includes(profile)) {
      throw new AccessScanUnknownProfileError(profile);
    }
    return profile;
  }

  const includeThirdParty = options.includeThirdParty === true;
  return includeThirdParty ? PROFILES.COMMERCIAL_PARITY : PROFILES.STANDARDS;
}

/**
 * Orchestrator/CLI helper: only treat `profile` as explicit when it is non-nullish.
 * Passing `{ profile: undefined }` into resolveScanProfile forces standards and
 * ignores includeThirdParty; callers that forward optional fields must use this.
 *
 * @param {{
 *   profile?: ProfileId | null,
 *   includeThirdParty?: boolean,
 * }} [options]
 * @returns {ProfileId}
 */
export function resolveOrchestratorScanProfile({ profile, includeThirdParty } = {}) {
  if (profile != null) {
    return resolveScanProfile({ profile, includeThirdParty });
  }
  return resolveScanProfile({ includeThirdParty });
}

export class AccessScanUnknownProfileError extends Error {
  /**
   * @param {string} profile
   */
  constructor(profile) {
    super(`Unknown accessScan profile: ${profile}`);
    this.name = 'AccessScanUnknownProfileError';
    this.errorCode = 'unknown_profile';
    this.profile = profile;
  }
}
