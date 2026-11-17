import { canonicalizeRuleId } from '../../../reporter/rule-aliases.js';
import { dedupeFindings, VIOLATION_TYPES } from './finding.js';
import { PROFILES } from './profiles.js';

/**
 * @typedef {import('./finding.js').NormalizedFinding} NormalizedFinding
 * @typedef {import('./schema.js').ProfileId} ProfileId
 */

/**
 * @param {NormalizedFinding} finding
 * @param {ProfileId} activeProfile
 * @returns {boolean}
 */
function isIncludedForProfile(finding, activeProfile) {
  const findingProfile = finding.evidence.profile;
  if (!findingProfile || typeof findingProfile !== 'string') {
    return true;
  }
  return findingProfile === activeProfile;
}

/**
 * @param {NormalizedFinding} finding
 * @returns {NormalizedFinding}
 */
function canonicalizeFindingIdentity(finding) {
  const canonicalRuleId = canonicalizeRuleId(finding.ruleId);
  return {
    ...finding,
    evidence: {
      ...finding.evidence,
      canonicalRuleId,
      nativeRuleId: finding.ruleId,
    },
  };
}

/**
 * Projection stage: canonicalize rule identity, apply active-profile inclusion,
 * commercial precedence, and frame/shadow-safe dedupe within the active profile.
 *
 * @param {NormalizedFinding[]} findings
 * @param {{ profile: ProfileId }} options
 * @returns {NormalizedFinding[]}
 */
export function projectFindings(findings, { profile }) {
  const included = findings
    .filter((finding) => isIncludedForProfile(finding, profile))
    .map(canonicalizeFindingIdentity);

  if (profile === PROFILES.COMMERCIAL_PARITY) {
    const withoutHiddenStandards = included.filter(
      (finding) => finding.evidence.profile !== PROFILES.STANDARDS,
    );
    return dedupeFindings(withoutHiddenStandards);
  }

  const withoutHiddenParity = included.filter(
    (finding) => finding.evidence.profile !== PROFILES.STANDARDS
      || finding.violationType !== VIOLATION_TYPES.COMMERCIAL_PARITY,
  );

  return dedupeFindings(withoutHiddenParity);
}
