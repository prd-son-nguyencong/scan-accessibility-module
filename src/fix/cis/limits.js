/**
 * Immutable PoC limits for CIS advisory calls.
 * Milestone 4 transport must enforce these bounds; milestone 1 only defines them.
 */
export const CIS_POC_LIMITS = Object.freeze({
  maxContextRounds: 2,
  maxGenerationAttempts: 2,
  maxConcurrency: 2,
  requestTimeoutMs: 30_000,
  maxInputTokens: 8_192,
  maxOutputTokens: 2_048,
  sessionWallClockBudgetMs: 120_000,
  sessionCallBudget: 2,
});

/** Immutable bounds for live CIS model discovery responses. */
export const CIS_MODEL_DISCOVERY_LIMITS = Object.freeze({
  maxRows: 4096,
  maxResponseBytes: 4 * 1024 * 1024,
});

/** Immutable derived validation bounds for broker/parser/transport (Task 4). */
export const CIS_VALIDATION_LIMITS = Object.freeze({
  maxEditsPerPatch: 8,
  maxBlockBytes: 65_536,
  maxEditTextChars: 8_192,
  maxContextBlockIds: 8,
  maxReasonChars: 512,
  maxRationaleChars: 2_048,
  maxManualChecks: 8,
  maxManualCheckChars: 512,
  maxResponseBytes: 1_048_576,
  maxOutputChars: 8_192,
  allowedTextExtensions: Object.freeze(['.css', '.html', '.js', '.liquid']),
});
