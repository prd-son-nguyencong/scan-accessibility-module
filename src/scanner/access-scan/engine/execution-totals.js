/**
 * @typedef {import('./runner.js').RuleExecutionRecord} RuleExecutionRecord
 * @typedef {import('./runner.js').CheckExecutionRecord} CheckExecutionRecord
 */

const RULE_STATUSES = ['complete', 'inapplicable', 'error', 'timeout', 'skipped'];
const CHECK_STATUSES = ['complete', 'inapplicable', 'error', 'timeout', 'skipped'];

/**
 * @typedef {object} AccessScanExecutionTotals
 * @property {{
 *   rules: { complete: number, inapplicable: number, error: number, timeout: number, skipped: number },
 *   checks: {
 *     complete: number,
 *     inapplicable: number,
 *     error: number,
 *     timeout: number,
 *     skipped: number,
 *     candidates: number,
 *     findings: number,
 *   },
 * }} aggregates
 * @property {Array<{
 *   checkId: string,
 *   status: string,
 *   statusCounts: Record<string, number>,
 *   candidateCount: number,
 *   findingCount: number,
 * }>} perCheck
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function coerceNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.trunc(numeric);
}

/**
 * @param {Record<string, number>} statusCounts
 * @returns {string}
 */
function deriveAggregatedCheckStatus(statusCounts) {
  const active = CHECK_STATUSES.filter((status) => (statusCounts[status] || 0) > 0);
  if (active.length === 0) {
    return 'inapplicable';
  }
  if (active.length === 1) {
    return active[0];
  }
  return 'mixed';
}

/**
 * @returns {AccessScanExecutionTotals['aggregates']}
 */
function emptyAggregates() {
  return {
    rules: { complete: 0, inapplicable: 0, error: 0, timeout: 0, skipped: 0 },
    checks: {
      complete: 0,
      inapplicable: 0,
      error: 0,
      timeout: 0,
      skipped: 0,
      candidates: 0,
      findings: 0,
    },
  };
}

/**
 * Deterministic per-check execution totals for accessScan runs.
 * Contains only check ids, statuses, and aggregate counts — no site or host data.
 *
 * @param {RuleExecutionRecord[]} executionRecords
 * @returns {AccessScanExecutionTotals}
 */
export function buildAccessScanExecutionTotals(executionRecords = []) {
  const aggregates = emptyAggregates();
  /** @type {AccessScanExecutionTotals['perCheck']} */
  const perCheck = [];

  for (const rule of executionRecords) {
    if (Object.hasOwn(aggregates.rules, rule.status)) {
      aggregates.rules[rule.status] += 1;
    }

    for (const check of rule.checks || []) {
      if (Object.hasOwn(aggregates.checks, check.status)) {
        aggregates.checks[check.status] += 1;
      }
      const candidateCount = coerceNonNegativeInteger(check.candidateCount);
      const findingCount = coerceNonNegativeInteger(check.findingCount);
      aggregates.checks.candidates += candidateCount;
      aggregates.checks.findings += findingCount;
      perCheck.push({
        checkId: check.checkId,
        status: check.status,
        statusCounts: { [check.status]: 1 },
        candidateCount,
        findingCount,
      });
    }
  }

  perCheck.sort((left, right) => left.checkId.localeCompare(right.checkId));

  return { aggregates, perCheck };
}

/**
 * @param {AccessScanExecutionTotals[]} totalsList
 * @returns {AccessScanExecutionTotals | null}
 */
export function mergeAccessScanExecutionTotals(totalsList = []) {
  const present = totalsList.filter(Boolean);
  if (present.length === 0) {
    return null;
  }

  const aggregates = emptyAggregates();
  /** @type {Map<string, { statusCounts: Record<string, number>, candidateCount: number, findingCount: number }>} */
  const perCheckMap = new Map();

  for (const totals of present) {
    for (const status of RULE_STATUSES) {
      aggregates.rules[status] += coerceNonNegativeInteger(totals.aggregates?.rules?.[status]);
    }
    for (const status of CHECK_STATUSES) {
      aggregates.checks[status] += coerceNonNegativeInteger(totals.aggregates?.checks?.[status]);
    }
    aggregates.checks.candidates += coerceNonNegativeInteger(totals.aggregates?.checks?.candidates);
    aggregates.checks.findings += coerceNonNegativeInteger(totals.aggregates?.checks?.findings);

    for (const check of totals.perCheck || []) {
      const existing = perCheckMap.get(check.checkId) || {
        statusCounts: Object.fromEntries(CHECK_STATUSES.map((status) => [status, 0])),
        candidateCount: 0,
        findingCount: 0,
      };
      for (const status of CHECK_STATUSES) {
        existing.statusCounts[status] += coerceNonNegativeInteger(check.statusCounts?.[status]);
        if (!check.statusCounts && check.status === status) {
          existing.statusCounts[status] += 1;
        }
      }
      existing.candidateCount += coerceNonNegativeInteger(check.candidateCount);
      existing.findingCount += coerceNonNegativeInteger(check.findingCount);
      perCheckMap.set(check.checkId, existing);
    }
  }

  const perCheck = [...perCheckMap.entries()]
    .map(([checkId, entry]) => ({
      checkId,
      status: deriveAggregatedCheckStatus(entry.statusCounts),
      statusCounts: Object.fromEntries(
        CHECK_STATUSES
          .map((status) => [status, entry.statusCounts[status] || 0])
          .filter(([, count]) => count > 0),
      ),
      candidateCount: entry.candidateCount,
      findingCount: entry.findingCount,
    }))
    .sort((left, right) => left.checkId.localeCompare(right.checkId));

  return { aggregates, perCheck };
}
