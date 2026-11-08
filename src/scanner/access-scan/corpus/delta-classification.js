import { normalizeCorpusRuleId } from '../../../reporter/rule-aliases.js';
import {
  evidenceMappingDiffersForEntries,
  scopePathsDifferForEntries,
  semanticScopeFingerprintForEntry,
} from './pairing.js';

/** @typedef {'signal_extraction' | 'policy_mapping' | 'aliasing' | 'runtime_state' | 'oracle_drift'} DeltaCategory */

export const DELTA_CATEGORIES = Object.freeze([
  'signal_extraction',
  'policy_mapping',
  'aliasing',
  'runtime_state',
  'oracle_drift',
]);

/**
 * @typedef {'missing' | 'extra' | 'changed'} DeltaKind
 */

/**
 * @typedef {object} ClassifiedCorpusDelta
 * @property {DeltaKind} kind
 * @property {DeltaCategory} category
 * @property {string} ruleId
 * @property {string} fingerprint
 * @property {string | null=} expectedFingerprint
 * @property {string | null=} actualFingerprint
 * @property {string=} reason
 */

/**
 * @param {Record<string, unknown>} finding
 * @returns {Record<string, unknown>}
 */
function unwrapFinding(finding = {}) {
  return /** @type {Record<string, unknown>} */ (finding.finding || finding);
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {string}
 */
function getRuleId(finding = {}) {
  const raw = unwrapFinding(finding);
  return normalizeCorpusRuleId(String(
    raw.ruleId
    || raw.canonicalRuleId
    || raw.nativeRuleId
    || 'unknown-rule',
  ));
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {string}
 */
function getRawRuleId(finding = {}) {
  const raw = unwrapFinding(finding);
  return String(raw.ruleId || raw.canonicalRuleId || raw.nativeRuleId || 'unknown-rule');
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {boolean}
 */
function isAliasRulePair(left = {}, right = {}) {
  const leftRaw = getRawRuleId(left);
  const rightRaw = getRawRuleId(right);
  return normalizeCorpusRuleId(leftRaw) === normalizeCorpusRuleId(rightRaw) && leftRaw !== rightRaw;
}

/**
 * @param {Record<string, unknown>=} meta
 * @returns {Set<string>}
 */
export function parseOracleLimitationRules(meta = {}) {
  const notes = Array.isArray(meta.notes) ? meta.notes : [];
  /** @type {Set<string>} */
  const rules = new Set();
  for (const note of notes) {
    const match = String(note).match(/Limitation:\s*([^:]+)/i);
    if (!match) continue;
    rules.add(normalizeCorpusRuleId(match[1].trim()));
  }
  return rules;
}

/**
 * @param {Record<string, unknown>=} meta
 * @param {string} ruleId
 * @returns {boolean}
 */
export function hasOracleLimitationForRule(meta = {}, ruleId = '') {
  return parseOracleLimitationRules(meta).has(normalizeCorpusRuleId(ruleId));
}

/**
 * @param {Record<string, unknown>} entry
 * @param {DeltaKind} kind
 * @param {Record<string, unknown> | null=} counterpart
 * @returns {{ fingerprint: string, expectedFingerprint: string | null, actualFingerprint: string | null }}
 */
function resolveFingerprints(entry = {}, kind = 'missing', counterpart = null) {
  const fingerprint = String(entry.fingerprint ?? entry.key ?? '');
  const counterpartFingerprint = counterpart
    ? String(counterpart.fingerprint ?? counterpart.key ?? '')
    : null;

  if (kind === 'changed') {
    return {
      fingerprint,
      expectedFingerprint: fingerprint,
      actualFingerprint: counterpartFingerprint,
    };
  }

  return {
    fingerprint,
    expectedFingerprint: kind === 'missing' ? fingerprint : counterpartFingerprint,
    actualFingerprint: kind === 'extra' ? fingerprint : counterpartFingerprint,
  };
}

/**
 * @param {DeltaKind} kind
 * @param {Record<string, unknown>} entry
 * @param {Record<string, unknown>=} counterpart
 * @param {Record<string, unknown>=} caseMeta
 * @returns {ClassifiedCorpusDelta}
 */
export function classifyCorpusDeltaEntry(
  kind,
  entry = {},
  counterpart = null,
  caseMeta = {},
) {
  const ruleId = getRuleId(entry);
  const { fingerprint, expectedFingerprint, actualFingerprint } = resolveFingerprints(entry, kind, counterpart);

  if (kind === 'missing' && hasOracleLimitationForRule(caseMeta, ruleId)) {
    return {
      kind,
      category: 'oracle_drift',
      ruleId,
      fingerprint,
      expectedFingerprint,
      actualFingerprint,
      reason: 'documented_oracle_limitation',
    };
  }

  if (kind !== 'changed' && counterpart && isAliasRulePair(kind === 'extra' ? counterpart : entry, kind === 'extra' ? entry : counterpart)) {
    return {
      kind,
      category: 'aliasing',
      ruleId,
      fingerprint,
      expectedFingerprint,
      actualFingerprint,
      reason: 'commercial_alias_pair',
    };
  }

  if (kind === 'changed') {
    const expected = entry;
    const actual = counterpart || {};

    if (
      isAliasRulePair(expected, actual)
      && semanticScopeFingerprintForEntry(expected) === semanticScopeFingerprintForEntry(actual)
    ) {
      return {
        kind,
        category: 'aliasing',
        ruleId,
        fingerprint,
        expectedFingerprint,
        actualFingerprint,
        reason: 'commercial_alias_pair',
      };
    }
    if (
      semanticScopeFingerprintForEntry(expected) === semanticScopeFingerprintForEntry(actual)
      && scopePathsDifferForEntries(expected, actual)
    ) {
      return {
        kind,
        category: 'runtime_state',
        ruleId,
        fingerprint,
        expectedFingerprint,
        actualFingerprint,
        reason: 'frame_or_shadow_scope_delta',
      };
    }
    if (
      semanticScopeFingerprintForEntry(expected) === semanticScopeFingerprintForEntry(actual)
      && evidenceMappingDiffersForEntries(expected, actual)
    ) {
      return {
        kind,
        category: 'policy_mapping',
        ruleId,
        fingerprint,
        expectedFingerprint,
        actualFingerprint,
        reason: 'policy_projection_delta',
      };
    }
    return {
      kind,
      category: 'signal_extraction',
      ruleId,
      fingerprint,
      expectedFingerprint,
      actualFingerprint,
      reason: 'semantic_identity_delta',
    };
  }

  return {
    kind,
    category: 'signal_extraction',
    ruleId,
    fingerprint,
    expectedFingerprint,
    actualFingerprint,
    reason: kind === 'missing' ? 'expected_finding_not_emitted' : 'unexpected_finding_emitted',
  };
}

/**
 * @param {import('./diff.js').CorpusDiffResult} diff
 * @param {{ caseMeta?: Record<string, unknown> }=} options
 * @returns {{
 *   equivalent: boolean,
 *   deltas: ClassifiedCorpusDelta[],
 *   counts: Record<DeltaCategory, number>,
 * }}
 */
export function classifyCorpusDiff(diff = { equivalent: true, missing: [], extra: [], changed: [] }, options = {}) {
  const caseMeta = options.caseMeta || {};
  /** @type {ClassifiedCorpusDelta[]} */
  const deltas = [];

  for (const entry of diff.missing || []) {
    deltas.push(classifyCorpusDeltaEntry('missing', entry, null, caseMeta));
  }
  for (const entry of diff.extra || []) {
    deltas.push(classifyCorpusDeltaEntry('extra', entry, null, caseMeta));
  }
  for (const pair of diff.changed || []) {
    deltas.push(classifyCorpusDeltaEntry('changed', pair.expected, pair.actual, caseMeta));
  }

  /** @type {Record<DeltaCategory, number>} */
  const counts = Object.fromEntries(DELTA_CATEGORIES.map((category) => [category, 0]));
  for (const delta of deltas) {
    counts[delta.category] += 1;
  }

  return {
    equivalent: Boolean(diff.equivalent),
    deltas,
    counts,
  };
}

/**
 * Deterministic JSON-safe summary with no case/site identifiers.
 *
 * @param {ReturnType<typeof classifyCorpusDiff>} classified
 * @returns {Record<string, unknown>}
 */
export function serializeClassifiedCorpusDiff(classified) {
  return {
    equivalent: classified.equivalent,
    counts: classified.counts,
    deltas: classified.deltas.map((delta) => ({
      kind: delta.kind,
      category: delta.category,
      ruleId: delta.ruleId,
      fingerprint: delta.fingerprint,
      ...(delta.expectedFingerprint != null ? { expectedFingerprint: delta.expectedFingerprint } : {}),
      ...(delta.actualFingerprint != null ? { actualFingerprint: delta.actualFingerprint } : {}),
      ...(delta.reason ? { reason: delta.reason } : {}),
    })),
  };
}
