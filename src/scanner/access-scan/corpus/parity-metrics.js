/**
 * @typedef {object} CommercialParityMetrics
 * @property {number} truePositives
 * @property {number} falsePositives
 * @property {number} falseNegatives
 * @property {number} expectedCount
 * @property {number} actualCount
 * @property {number} precision
 * @property {number} recall
 */

/**
 * Element-level commercial parity metrics keyed by canonical rule plus semantic
 * fingerprint. Changed pairs count as one false positive and one false negative.
 *
 * @param {import('./diff.js').CorpusDiffResult} diff
 * @param {{ expectedCount?: number, actualCount?: number }=} options
 * @returns {CommercialParityMetrics}
 */
export function computeCommercialParityMetrics(
  diff = { equivalent: true, missing: [], extra: [], changed: [] },
  options = {},
) {
  const missing = Array.isArray(diff.missing) ? diff.missing.length : 0;
  const extra = Array.isArray(diff.extra) ? diff.extra.length : 0;
  const changed = Array.isArray(diff.changed) ? diff.changed.length : 0;

  const falseNegatives = missing + changed;
  const falsePositives = extra + changed;
  const expectedCount = Number.isInteger(options.expectedCount)
    ? options.expectedCount
    : falseNegatives;
  const actualCount = Number.isInteger(options.actualCount)
    ? options.actualCount
    : falsePositives;
  const truePositives = Math.max(0, expectedCount - falseNegatives);

  const precision = actualCount === 0
    ? (expectedCount === 0 ? 1 : 0)
    : truePositives / actualCount;
  const recall = expectedCount === 0
    ? (actualCount === 0 ? 1 : 0)
    : truePositives / expectedCount;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    expectedCount,
    actualCount,
    precision,
    recall,
  };
}

/**
 * @param {CommercialParityMetrics} metrics
 * @returns {Record<string, number>}
 */
export function serializeCommercialParityMetrics(metrics) {
  return {
    truePositives: metrics.truePositives,
    falsePositives: metrics.falsePositives,
    falseNegatives: metrics.falseNegatives,
    expectedCount: metrics.expectedCount,
    actualCount: metrics.actualCount,
    precision: Number(metrics.precision.toFixed(6)),
    recall: Number(metrics.recall.toFixed(6)),
  };
}

/**
 * @param {CommercialParityMetrics} metrics
 * @param {{ precision?: number, recall?: number }=} thresholds
 * @returns {boolean}
 */
export function meetsCommercialParityThreshold(
  metrics,
  thresholds = { precision: 1, recall: 1 },
) {
  const precisionThreshold = thresholds.precision ?? 1;
  const recallThreshold = thresholds.recall ?? 1;
  return metrics.precision >= precisionThreshold && metrics.recall >= recallThreshold;
}
