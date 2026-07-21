const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;

export class ModelSelectionError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ModelSelectionError';
    this.code = code;
  }
}

function assertModelId(modelId) {
  if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) {
    throw new ModelSelectionError('INVALID_MODEL_ID', 'Model ID is invalid.');
  }
}

function assertOutcome(outcome, index) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new ModelSelectionError('MALFORMED_OUTCOME', `Outcome at index ${index} is malformed.`);
  }

  const requiredBooleans = ['eligible', 'proposed', 'verified', 'invalid', 'unsafe', 'unnecessaryCannotFix'];
  for (const key of requiredBooleans) {
    if (typeof outcome[key] !== 'boolean') {
      throw new ModelSelectionError('MALFORMED_OUTCOME', `Outcome at index ${index} is malformed.`);
    }
  }

  if (!Number.isInteger(outcome.newCriticalSerious) || outcome.newCriticalSerious < 0) {
    throw new ModelSelectionError('MALFORMED_OUTCOME', `Outcome at index ${index} is malformed.`);
  }

  if (outcome.latencyMs != null && !Number.isFinite(outcome.latencyMs)) {
    throw new ModelSelectionError('MALFORMED_OUTCOME', `Outcome at index ${index} is malformed.`);
  }

  if (outcome.totalTokens != null && !Number.isFinite(outcome.totalTokens)) {
    throw new ModelSelectionError('MALFORMED_OUTCOME', `Outcome at index ${index} is malformed.`);
  }
}

function assertRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new ModelSelectionError('MALFORMED_RUN', 'Model run is malformed.');
  }
  assertModelId(run.modelId);
  if (!Array.isArray(run.outcomes)) {
    throw new ModelSelectionError('MALFORMED_RUN', 'Model run outcomes must be an array.');
  }
  run.outcomes.forEach((outcome, index) => assertOutcome(outcome, index));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sumFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length
    ? finite.reduce((total, value) => total + value, 0)
    : Number.POSITIVE_INFINITY;
}

/** Persisted benchmark score schema version. */
export const BENCHMARK_SCORE_SCHEMA = '1.0.0';

/**
 * Null in JSON artifacts and stdout. Rehydrate to Number.POSITIVE_INFINITY for ranking.
 */
export const BENCHMARK_MISSING_METRIC = null;

/**
 * @param {number | null | undefined} value
 */
export function serializeBenchmarkMetric(value) {
  return Number.isFinite(value) ? value : BENCHMARK_MISSING_METRIC;
}

/**
 * @param {ReturnType<typeof scoreModelRun>} score
 */
export function serializeBenchmarkScore(score) {
  return Object.freeze({
    modelId: score.modelId,
    eligibleCount: score.eligibleCount,
    verifiedCount: score.verifiedCount,
    verifiedResolutionRate: score.verifiedResolutionRate,
    invalidCount: score.invalidCount,
    unsafeCount: score.unsafeCount,
    unnecessaryCannotFixCount: score.unnecessaryCannotFixCount,
    medianLatencyMs: serializeBenchmarkMetric(score.medianLatencyMs),
    totalTokens: serializeBenchmarkMetric(score.totalTokens),
  });
}

/**
 * @param {Array<ReturnType<typeof scoreModelRun>>} ranking
 */
export function serializeBenchmarkRanking(ranking) {
  return ranking.map((entry) => serializeBenchmarkScore(entry));
}

/**
 * @param {ReturnType<typeof serializeBenchmarkScore>} serialized
 */
export function rehydrateBenchmarkScore(serialized) {
  return {
    ...serialized,
    medianLatencyMs: serialized.medianLatencyMs == null
      ? Number.POSITIVE_INFINITY
      : serialized.medianLatencyMs,
    totalTokens: serialized.totalTokens == null
      ? Number.POSITIVE_INFINITY
      : serialized.totalTokens,
  };
}

/**
 * @param {{ modelId: string, outcomes: Array<Record<string, unknown>> }} run
 */
export function scoreModelRun(run) {
  assertRun(run);

  const eligible = run.outcomes.filter((outcome) => outcome.eligible);
  const verified = eligible.filter((outcome) =>
    outcome.proposed
    && outcome.verified
    && outcome.newCriticalSerious === 0);

  return {
    modelId: run.modelId,
    eligibleCount: eligible.length,
    verifiedCount: verified.length,
    verifiedResolutionRate: eligible.length ? verified.length / eligible.length : 0,
    invalidCount: eligible.filter((outcome) => outcome.invalid).length,
    unsafeCount: eligible.filter((outcome) => outcome.unsafe).length,
    unnecessaryCannotFixCount: eligible.filter((outcome) => outcome.unnecessaryCannotFix).length,
    medianLatencyMs: median(eligible.map((outcome) => outcome.latencyMs)),
    totalTokens: sumFinite(eligible.map((outcome) => outcome.totalTokens)),
  };
}

function compareScores(left, right) {
  return right.verifiedResolutionRate - left.verifiedResolutionRate
    || left.invalidCount - right.invalidCount
    || left.unsafeCount - right.unsafeCount
    || left.unnecessaryCannotFixCount - right.unnecessaryCannotFixCount
    || left.medianLatencyMs - right.medianLatencyMs
    || left.totalTokens - right.totalTokens
    || left.modelId.localeCompare(right.modelId);
}

/**
 * @param {Array<{ modelId: string, outcomes: Array<Record<string, unknown>> }>} runs
 */
export function rankModelRuns(runs) {
  if (!Array.isArray(runs)) {
    throw new ModelSelectionError('MALFORMED_RUN', 'Model runs must be an array.');
  }

  const seen = new Set();
  for (const run of runs) {
    assertRun(run);
    if (seen.has(run.modelId)) {
      throw new ModelSelectionError('DUPLICATE_MODEL_ID', 'Duplicate model ID is not allowed.');
    }
    seen.add(run.modelId);
  }

  return runs.map((run) => scoreModelRun(run)).sort(compareScores);
}
