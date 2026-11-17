import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreModelRun,
  rankModelRuns,
  ModelSelectionError,
  BENCHMARK_SCORE_SCHEMA,
  BENCHMARK_MISSING_METRIC,
  serializeBenchmarkScore,
  serializeBenchmarkRanking,
  rehydrateBenchmarkScore,
} from '../../src/fix/eval/model-selection.js';

const baseOutcome = {
  eligible: true,
  proposed: true,
  verified: true,
  newCriticalSerious: 0,
  invalid: false,
  unsafe: false,
  unnecessaryCannotFix: false,
  latencyMs: 900,
  totalTokens: 120,
};

test('scoreModelRun counts verified resolution rate from eligible outcomes only', () => {
  const scored = scoreModelRun({
    modelId: 'model-a',
    outcomes: [
      { ...baseOutcome },
      {
        ...baseOutcome,
        proposed: true,
        verified: false,
        newCriticalSerious: 1,
        latencyMs: 800,
        totalTokens: 110,
      },
      {
        ...baseOutcome,
        eligible: false,
        proposed: true,
        verified: true,
        latencyMs: 50,
        totalTokens: 10,
      },
    ],
  });

  assert.equal(scored.modelId, 'model-a');
  assert.equal(scored.eligibleCount, 2);
  assert.equal(scored.verifiedCount, 1);
  assert.equal(scored.verifiedResolutionRate, 0.5);
  assert.equal(scored.invalidCount, 0);
  assert.equal(scored.unsafeCount, 0);
  assert.equal(scored.unnecessaryCannotFixCount, 0);
  assert.equal(scored.medianLatencyMs, 850);
  assert.equal(scored.totalTokens, 230);
});

test('rankModelRuns prefers higher verified resolution rate', () => {
  const runs = [
    {
      modelId: 'model-a',
      outcomes: [
        { ...baseOutcome },
        { ...baseOutcome, proposed: true, verified: false, newCriticalSerious: 1, latencyMs: 800, totalTokens: 110 },
      ],
    },
    {
      modelId: 'model-b',
      outcomes: [
        { ...baseOutcome, latencyMs: 1100, totalTokens: 140 },
        { ...baseOutcome, latencyMs: 1000, totalTokens: 130 },
      ],
    },
  ];

  const ranked = rankModelRuns(runs);
  assert.equal(ranked[0].modelId, 'model-b');
  assert.equal(ranked[0].verifiedResolutionRate, 1);
  assert.equal(ranked[1].modelId, 'model-a');
});

test('rankModelRuns tie-breaks on fewer invalid responses', () => {
  const ranked = rankModelRuns([
    {
      modelId: 'model-a',
      outcomes: [
        { ...baseOutcome, invalid: true, verified: false, proposed: false },
        { ...baseOutcome },
      ],
    },
    {
      modelId: 'model-b',
      outcomes: [{ ...baseOutcome }, { ...baseOutcome, latencyMs: 950, totalTokens: 125 }],
    },
  ]);
  assert.equal(ranked[0].modelId, 'model-b');
});

test('rankModelRuns tie-breaks on fewer unsafe attempts', () => {
  const ranked = rankModelRuns([
    {
      modelId: 'model-a',
      outcomes: [
        { ...baseOutcome, unsafe: true, verified: false, proposed: false },
        { ...baseOutcome },
      ],
    },
    {
      modelId: 'model-b',
      outcomes: [{ ...baseOutcome }, { ...baseOutcome, latencyMs: 950, totalTokens: 125 }],
    },
  ]);
  assert.equal(ranked[0].modelId, 'model-b');
});

test('rankModelRuns tie-breaks on fewer unnecessary cannot_fix outcomes', () => {
  const ranked = rankModelRuns([
    {
      modelId: 'model-a',
      outcomes: [
        { ...baseOutcome, proposed: false, verified: false, unnecessaryCannotFix: true },
        { ...baseOutcome },
      ],
    },
    {
      modelId: 'model-b',
      outcomes: [{ ...baseOutcome }, { ...baseOutcome, latencyMs: 950, totalTokens: 125 }],
    },
  ]);
  assert.equal(ranked[0].modelId, 'model-b');
});

test('rankModelRuns tie-breaks on lower median latency', () => {
  const ranked = rankModelRuns([
    {
      modelId: 'model-a',
      outcomes: [
        { ...baseOutcome, latencyMs: 1200, totalTokens: 100 },
        { ...baseOutcome, latencyMs: 1000, totalTokens: 100 },
      ],
    },
    {
      modelId: 'model-b',
      outcomes: [
        { ...baseOutcome, latencyMs: 900, totalTokens: 100 },
        { ...baseOutcome, latencyMs: 800, totalTokens: 100 },
      ],
    },
  ]);
  assert.equal(ranked[0].modelId, 'model-b');
  assert.equal(ranked[0].medianLatencyMs, 850);
});

test('rankModelRuns tie-breaks on lower total tokens', () => {
  const ranked = rankModelRuns([
    {
      modelId: 'model-a',
      outcomes: [
        { ...baseOutcome, latencyMs: 900, totalTokens: 200 },
        { ...baseOutcome, latencyMs: 900, totalTokens: 200 },
      ],
    },
    {
      modelId: 'model-b',
      outcomes: [
        { ...baseOutcome, latencyMs: 900, totalTokens: 150 },
        { ...baseOutcome, latencyMs: 900, totalTokens: 150 },
      ],
    },
  ]);
  assert.equal(ranked[0].modelId, 'model-b');
});

test('rankModelRuns tie-breaks lexically on modelId', () => {
  const ranked = rankModelRuns([
    {
      modelId: 'model-z',
      outcomes: [{ ...baseOutcome }],
    },
    {
      modelId: 'model-a',
      outcomes: [{ ...baseOutcome }],
    },
  ]);
  assert.equal(ranked[0].modelId, 'model-a');
  assert.equal(ranked[1].modelId, 'model-z');
});

test('scoreModelRun treats missing latency and tokens as Infinity for ranking', () => {
  const scored = scoreModelRun({
    modelId: 'model-a',
    outcomes: [{ ...baseOutcome, latencyMs: null, totalTokens: null }],
  });
  assert.equal(scored.medianLatencyMs, Number.POSITIVE_INFINITY);
  assert.equal(scored.totalTokens, Number.POSITIVE_INFINITY);
});

test('scoreModelRun handles empty eligible outcomes', () => {
  const scored = scoreModelRun({
    modelId: 'model-a',
    outcomes: [{ ...baseOutcome, eligible: false }],
  });
  assert.equal(scored.eligibleCount, 0);
  assert.equal(scored.verifiedCount, 0);
  assert.equal(scored.verifiedResolutionRate, 0);
  assert.equal(scored.medianLatencyMs, Number.POSITIVE_INFINITY);
  assert.equal(scored.totalTokens, Number.POSITIVE_INFINITY);
});

test('rankModelRuns rejects duplicate model IDs', () => {
  assert.throws(
    () => rankModelRuns([
      { modelId: 'model-a', outcomes: [{ ...baseOutcome }] },
      { modelId: 'model-a', outcomes: [{ ...baseOutcome }] },
    ]),
    (error) => error instanceof ModelSelectionError && error.code === 'DUPLICATE_MODEL_ID',
  );
});

test('rankModelRuns rejects invalid model IDs', () => {
  assert.throws(
    () => rankModelRuns([{ modelId: 'not a model!', outcomes: [{ ...baseOutcome }] }]),
    (error) => error instanceof ModelSelectionError && error.code === 'INVALID_MODEL_ID',
  );
});

test('scoreModelRun rejects malformed outcomes', () => {
  assert.throws(
    () => scoreModelRun({ modelId: 'model-a', outcomes: [{ eligible: 'yes' }] }),
    (error) => error instanceof ModelSelectionError && error.code === 'MALFORMED_OUTCOME',
  );
});

test('rankModelRuns does not mutate input runs', () => {
  const runs = [
    {
      modelId: 'model-b',
      outcomes: [{ ...baseOutcome }],
    },
    {
      modelId: 'model-a',
      outcomes: [{ ...baseOutcome }],
    },
  ];
  const snapshot = structuredClone(runs);
  rankModelRuns(runs);
  assert.deepEqual(runs, snapshot);
});

test('serializeBenchmarkScore maps non-finite metrics to explicit null sentinel', () => {
  const scored = scoreModelRun({
    modelId: 'model-a',
    outcomes: [{ ...baseOutcome, latencyMs: null, totalTokens: null }],
  });
  const serialized = serializeBenchmarkScore(scored);
  assert.equal(serialized.medianLatencyMs, BENCHMARK_MISSING_METRIC);
  assert.equal(serialized.totalTokens, BENCHMARK_MISSING_METRIC);
  assert.equal(JSON.stringify(serialized).includes('Infinity'), false);
});

test('serializeBenchmarkRanking preserves ordering fields while nulling missing metrics', () => {
  const ranking = rankModelRuns([
    {
      modelId: 'model-a',
      outcomes: [{ ...baseOutcome, latencyMs: null, totalTokens: null }],
    },
    {
      modelId: 'model-b',
      outcomes: [{ ...baseOutcome, latencyMs: 100, totalTokens: 10 }],
    },
  ]);
  const serialized = serializeBenchmarkRanking(ranking);
  assert.equal(serialized[0].modelId, 'model-b');
  assert.equal(serialized[0].medianLatencyMs, 100);
  assert.equal(serialized[1].medianLatencyMs, BENCHMARK_MISSING_METRIC);
  assert.equal(JSON.stringify(serialized).includes('Infinity'), false);
});

test('rehydrateBenchmarkScore restores Infinity ordering semantics from null sentinel', () => {
  const serialized = serializeBenchmarkScore({
    modelId: 'model-a',
    eligibleCount: 1,
    verifiedCount: 0,
    verifiedResolutionRate: 0,
    invalidCount: 0,
    unsafeCount: 0,
    unnecessaryCannotFixCount: 0,
    medianLatencyMs: Number.POSITIVE_INFINITY,
    totalTokens: Number.POSITIVE_INFINITY,
  });
  const restored = rehydrateBenchmarkScore(serialized);
  assert.equal(restored.medianLatencyMs, Number.POSITIVE_INFINITY);
  assert.equal(restored.totalTokens, Number.POSITIVE_INFINITY);
});

test('BENCHMARK_SCORE_SCHEMA is a stable version marker', () => {
  assert.match(BENCHMARK_SCORE_SCHEMA, /^\d+\.\d+\.\d+$/);
});
