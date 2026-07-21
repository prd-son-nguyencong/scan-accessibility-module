import { normalizeSelector } from '../../reporter/fingerprint.js';
import { normalizeCorpusRuleId } from '../../reporter/rule-aliases.js';

/**
 * Stable verification identity for finding equivalence during shadow rescan.
 * Target closure prefers selector-based keys; without a stable selector any
 * same rule+route/pageState finding in after-scan counts as unresolved.
 * Release-gate evaluators (99%/90%) are CI thresholds — per-apply safety uses
 * the conservative comparator below, not corpus aggregates.
 */

export function stableSelector(finding = {}) {
  const raw = finding.selector
    || finding.element?.selector
    || (Array.isArray(finding.element?.target) ? finding.element.target.join(' > ') : finding.element?.target)
    || '';
  const normalized = normalizeSelector(raw);
  if (!normalized || normalized.length > 512) return null;
  return normalized;
}

export function buildRuleRouteKey(finding = {}) {
  const rawRule = finding.canonicalRuleId
    || finding.ruleId
    || finding.nativeRuleId
    || 'unknown-rule';
  const rule = normalizeCorpusRuleId(rawRule);
  const route = finding.route || finding.pageRoute || '/';
  const pageState = finding.pageState || 'initial';
  return `${rule}|${route}|${pageState}`;
}

export function buildVerificationKey(finding = {}) {
  const selector = stableSelector(finding);
  const base = buildRuleRouteKey(finding);
  if (selector) return `${base}|sel:${selector}`;
  return `${base}|nosel`;
}

export function buildSeverityCountKey(finding = {}) {
  const impact = normalizeImpact(finding.impact);
  return `${buildRuleRouteKey(finding)}|${impact}`;
}

function normalizeImpact(impact) {
  const value = String(impact || 'unknown').toLowerCase();
  if (['critical', 'serious', 'moderate', 'minor'].includes(value)) return value;
  return 'unknown';
}

export function indexFindingsByVerificationKey(findings = []) {
  const byKey = new Map();
  for (const finding of findings) {
    const key = buildVerificationKey(finding);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(finding);
  }
  return byKey;
}

export function indexFindingsByExactId(findings = []) {
  const byId = new Map();
  for (const finding of findings) {
    const id = finding.findingId || finding.fingerprint;
    if (id) byId.set(id, finding);
  }
  return byId;
}

export function countByKey(findings = [], keyFn = buildSeverityCountKey) {
  const counts = new Map();
  for (const finding of findings) {
    const key = keyFn(finding);
    const count = Number.isSafeInteger(finding.count) && finding.count > 0
      ? finding.count
      : 1;
    counts.set(key, (counts.get(key) || 0) + count);
  }
  return counts;
}

export function findingsEquivalent(left, right) {
  if (!left || !right) return false;
  const leftId = left.findingId || left.fingerprint;
  const rightId = right.findingId || right.fingerprint;
  if (leftId && rightId && leftId === rightId) return true;
  return buildVerificationKey(left) === buildVerificationKey(right);
}

function isTargetResolved(baseline, afterFindings, afterById, afterByClosureKey) {
  const targetId = baseline.findingId || baseline.fingerprint;
  if (targetId && afterById.has(targetId)) {
    return { resolved: false, reason: 'EXACT_ID_REMAINING' };
  }

  const selector = stableSelector(baseline);
  if (selector) {
    const closureKey = buildVerificationKey(baseline);
    if (afterByClosureKey.has(closureKey)) {
      return { resolved: false, reason: 'CLOSURE_KEY_REMAINING' };
    }
    return { resolved: true };
  }

  const ruleRouteKey = buildRuleRouteKey(baseline);
  const stillPresent = afterFindings.some((item) => buildRuleRouteKey(item) === ruleRouteKey);
  if (stillPresent) {
    return { resolved: false, reason: 'RULE_ROUTE_STATE_REMAINING' };
  }
  return { resolved: true };
}

export function compareVerificationFindings(baselineFindings, afterFindings, targetFindingIds = []) {
  const baselineById = indexFindingsByExactId(baselineFindings);
  const afterById = indexFindingsByExactId(afterFindings);
  const baselineByClosureKey = indexFindingsByVerificationKey(baselineFindings);
  const afterByClosureKey = indexFindingsByVerificationKey(afterFindings);
  const baselineCounts = countByKey(baselineFindings, buildSeverityCountKey);
  const afterCounts = countByKey(afterFindings, buildSeverityCountKey);

  const targetDetails = [];
  let targetsResolved = true;

  for (const id of targetFindingIds) {
    const baseline = baselineById.get(id);
    if (!baseline) {
      targetsResolved = false;
      targetDetails.push({ findingId: id, resolved: false, reason: 'UNKNOWN_TARGET' });
      continue;
    }
    const outcome = isTargetResolved(baseline, afterFindings, afterById, afterByClosureKey);
    targetDetails.push({ findingId: id, ...outcome });
    if (!outcome.resolved) targetsResolved = false;
  }

  const newCriticalSerious = [];
  const seenRegressionKeys = new Set();

  for (const [countKey, afterCount] of afterCounts.entries()) {
    const baselineCount = baselineCounts.get(countKey) || 0;
    if (afterCount <= baselineCount) continue;
    const impact = countKey.split('|').pop();
    if (impact !== 'critical' && impact !== 'serious') continue;
    if (seenRegressionKeys.has(countKey)) continue;
    seenRegressionKeys.add(countKey);
    const sample = afterFindings.find((item) => buildSeverityCountKey(item) === countKey);
    if (sample) newCriticalSerious.push(sample);
  }

  for (const afterFinding of afterFindings) {
    const impact = normalizeImpact(afterFinding.impact);
    if (impact !== 'critical' && impact !== 'serious') continue;

    const id = afterFinding.findingId || afterFinding.fingerprint;
    if (id && baselineById.has(id)) continue;

    const closureKey = buildVerificationKey(afterFinding);
    if (baselineByClosureKey.has(closureKey)) continue;

    const countKey = buildSeverityCountKey(afterFinding);
    if (seenRegressionKeys.has(countKey)) continue;

    const baselineHasCollapsedOccurrences = baselineFindings.some((item) =>
      buildSeverityCountKey(item) === countKey
      && Number.isSafeInteger(item.count)
      && item.count > 1
    );
    if (baselineHasCollapsedOccurrences
      && (afterCounts.get(countKey) || 0) <= (baselineCounts.get(countKey) || 0)) {
      continue;
    }

    if (stableSelector(afterFinding)) {
      newCriticalSerious.push(afterFinding);
      continue;
    }

    const ruleRouteKey = buildRuleRouteKey(afterFinding);
    const baselineSame = baselineFindings.filter((item) => buildRuleRouteKey(item) === ruleRouteKey).length;
    const afterSame = afterFindings.filter((item) => buildRuleRouteKey(item) === ruleRouteKey).length;
    if (afterSame > baselineSame) {
      newCriticalSerious.push(afterFinding);
    }
  }

  return { targetsResolved, targetDetails, newCriticalSerious };
}
