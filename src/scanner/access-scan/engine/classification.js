import { PROFILES } from './profiles.js';

/**
 * @typedef {import('./schema.js').RuleDescriptor} RuleDescriptor
 * @typedef {import('./schema.js').RuleCheckDescriptor} RuleCheckDescriptor
 * @typedef {import('./schema.js').ViolationType} ViolationType
 * @typedef {{ path: string, message: string }} ValidationError
 */

/**
 * @param {RuleDescriptor['automation']} automation
 * @returns {ViolationType}
 */
export function defaultClassificationForAutomation(automation) {
  switch (automation) {
    case 'deterministic':
    case 'behavioral':
      return 'confirmed';
    case 'heuristic':
      return 'potential';
    case 'manual':
      return 'manual-review';
    default:
      return 'confirmed';
  }
}

/**
 * @param {Pick<RuleDescriptor, 'automation'>} rule
 * @param {RuleCheckDescriptor} check
 * @returns {ViolationType}
 */
export function resolveCheckClassification(rule, check) {
  const explicit = check.classification;
  const allowsParity = check.profiles.includes(PROFILES.COMMERCIAL_PARITY);

  if (explicit === 'commercial-parity') {
    if (!allowsParity) {
      throw new Error('commercial-parity classification requires a commercial-parity profile');
    }
    return 'commercial-parity';
  }

  if (explicit === 'confirmed') {
    if (rule.automation === 'heuristic' || rule.automation === 'manual') {
      throw new Error(`${rule.automation} checks cannot be classified as confirmed`);
    }
    return 'confirmed';
  }

  if (explicit) {
    return explicit;
  }

  return defaultClassificationForAutomation(rule.automation);
}

/**
 * @param {RuleDescriptor} descriptor
 * @param {number} checkIndex
 * @returns {ValidationError[]}
 */
export function validateCheckClassification(descriptor, checkIndex) {
  /** @type {ValidationError[]} */
  const errors = [];
  const check = descriptor.checks[checkIndex];
  try {
    resolveCheckClassification(descriptor, check);
  } catch (error) {
    errors.push({
      path: `/checks/${checkIndex}/classification`,
      message: error instanceof Error ? error.message : 'invalid classification',
    });
  }
  return errors;
}
