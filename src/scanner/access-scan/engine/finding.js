import { createViolation } from '../../../schema.js';

/**
 * @typedef {import('./schema.js').ViolationType} ViolationType
 * @typedef {import('./schema.js').RuleDescriptor} RuleDescriptor
 */

export const VIOLATION_TYPES = Object.freeze({
  CONFIRMED: 'confirmed',
  POTENTIAL: 'potential',
  COMMERCIAL_PARITY: 'commercial-parity',
  MANUAL_REVIEW: 'manual-review',
});

const UNCERTAIN_VIOLATION_TYPES = new Set([
  VIOLATION_TYPES.POTENTIAL,
  VIOLATION_TYPES.COMMERCIAL_PARITY,
  VIOLATION_TYPES.MANUAL_REVIEW,
]);

/**
 * @typedef {object} NormalizedFinding
 * @property {string} ruleId
 * @property {ViolationType} violationType
 * @property {{ impact: string, priority: number, wcagRef: string }} severity
 * @property {{ outerHTML: string, selector: string, framePath: string[], shadowPath: string[] }} element
 * @property {string} recommendation
 * @property {Record<string, unknown>} evidence
 */

/**
 * @param {{ version: string, level: string, criterion: string }} standard
 * @returns {string}
 */
function formatWcagRef(standard) {
  if (standard.version === 'Best Practice') {
    return 'Best Practice';
  }
  return `${standard.version} ${standard.level} ${standard.criterion}`;
}

const VIOLATION_PRECEDENCE = Object.freeze({
  confirmed: 4,
  'commercial-parity': 3,
  potential: 2,
  'manual-review': 1,
});

/**
 * @param {NormalizedFinding} finding
 * @returns {string}
 */
function findingScopeKey(finding) {
  const { selector, framePath, shadowPath } = finding.element;
  return `${finding.ruleId}|${selector}|${JSON.stringify(framePath)}|${JSON.stringify(shadowPath)}`;
}

/**
 * @param {ViolationType} left
 * @param {ViolationType} right
 * @returns {ViolationType}
 */
function pickViolationType(left, right) {
  const leftRank = VIOLATION_PRECEDENCE[left] || 0;
  const rightRank = VIOLATION_PRECEDENCE[right] || 0;
  return leftRank >= rightRank ? left : right;
}

/**
 * Deterministically deduplicate scoped rule+element findings.
 * Confirmed standards beat parity; parity beats potential/manual.
 *
 * @param {NormalizedFinding[]} findings
 * @returns {NormalizedFinding[]}
 */
export function dedupeFindings(findings) {
  /** @type {Map<string, NormalizedFinding>} */
  const merged = new Map();

  for (const finding of findings) {
    const key = findingScopeKey(finding);
    const existing = merged.get(key);
    if (!existing) {
      const checkId = finding.evidence.checkId;
      merged.set(key, {
        ...finding,
        evidence: {
          ...finding.evidence,
          ...(checkId ? { checkIds: [checkId] } : {}),
        },
      });
      continue;
    }

    const checkIds = new Set([
      ...(Array.isArray(existing.evidence.checkIds) ? existing.evidence.checkIds : []),
      ...(existing.evidence.checkId ? [existing.evidence.checkId] : []),
      ...(finding.evidence.checkId ? [finding.evidence.checkId] : []),
    ]);

    const mergedEvidence = {
      ...existing.evidence,
      ...finding.evidence,
      checkIds: [...checkIds].sort(),
      mergedEvidence: true,
    };
    delete mergedEvidence.checkId;

    merged.set(key, {
      ...existing,
      violationType: pickViolationType(existing.violationType, finding.violationType),
      evidence: mergedEvidence,
    });
  }

  return [...merged.values()].sort((left, right) => (
    findingScopeKey(left).localeCompare(findingScopeKey(right))
  ));
}

/**
 * @param {ViolationType} violationType
 * @param {Pick<RuleDescriptor, 'fix'>} rule
 * @returns {boolean}
 */
export function resolveFixDeterministic(violationType, rule) {
  if (UNCERTAIN_VIOLATION_TYPES.has(violationType)) {
    return false;
  }
  return violationType === VIOLATION_TYPES.CONFIRMED && rule.fix.deterministic === true;
}

/**
 * @param {Record<string, unknown>} candidate
 * @param {Pick<RuleDescriptor, 'id' | 'category' | 'publicCategory' | 'severity' | 'standard' | 'reporting' | 'fix'>} rule
 * @param {{ checkId?: string, profile?: string }=} meta
 * @returns {NormalizedFinding}
 */
export function normalizeFinding(candidate, rule, meta = {}) {
  const element = /** @type {Record<string, unknown>} */ (candidate.element || {});
  const violationType = /** @type {ViolationType} */ (candidate.violationType || 'confirmed');
  const candidateEvidence = /** @type {Record<string, unknown>} */ (candidate.evidence || {});
  const publicCategory = rule.publicCategory || rule.category || null;

  return {
    ruleId: rule.id,
    violationType,
    severity: {
      impact: rule.severity.impact,
      priority: rule.severity.priority,
      wcagRef: formatWcagRef(rule.standard),
    },
    element: {
      outerHTML: String(element.outerHTML || ''),
      selector: String(element.selector || ''),
      framePath: Array.isArray(element.framePath) ? [...element.framePath] : [],
      shadowPath: Array.isArray(element.shadowPath) ? [...element.shadowPath] : [],
    },
    recommendation: rule.reporting.recommendation,
    evidence: {
      ...candidateEvidence,
      ...(meta.checkId ? { check: meta.checkId, checkId: meta.checkId } : {}),
      ...(meta.profile ? { profile: meta.profile } : {}),
      ...(publicCategory ? { publicCategory } : {}),
      ...(rule.fix?.policy ? { fixPolicy: rule.fix.policy } : {}),
      violationType,
      ...(violationType === VIOLATION_TYPES.COMMERCIAL_PARITY && !candidateEvidence.classification
        ? { classification: 'commercial-parity-heuristic' }
        : {}),
    },
  };
}

/**
 * Adapts a normalized finding to the current createViolation shape without
 * breaking existing consumers. Evidence is preserved additively.
 *
 * @param {NormalizedFinding} finding
 * @param {{
 *   layer?: string,
 *   source?: Record<string, unknown>,
 *   fix?: Record<string, unknown>,
 *   rule?: Pick<RuleDescriptor, 'fix'>,
 * }} options
 */
export function toViolation(finding, options = {}) {
  const ruleFix = options.rule?.fix;
  const deterministic = options.fix?.deterministic ?? (
    ruleFix
      ? resolveFixDeterministic(finding.violationType, { fix: ruleFix })
      : false
  );

  const violation = createViolation({
    ruleId: finding.ruleId,
    layer: options.layer || 'accessScan',
    wcagRef: finding.severity.wcagRef,
    impact: finding.severity.impact,
    priority: finding.severity.priority,
    element: {
      outerHTML: finding.element.outerHTML,
      selector: finding.element.selector,
      scanId: null,
    },
    source: options.source || {},
    fix: {
      deterministic,
      hint: options.fix?.hint || finding.recommendation,
      patch: options.fix?.patch || null,
    },
  });

  violation.element.framePath = finding.element.framePath;
  violation.element.shadowPath = finding.element.shadowPath;

  violation.evidence = {
    ...(violation.evidence || {}),
    ...finding.evidence,
    violationType: finding.violationType,
  };

  return violation;
}
