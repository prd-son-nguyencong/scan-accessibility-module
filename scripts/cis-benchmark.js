#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import '../src/utils/config.js';
import {
  createCisTransportFromTrustedConfig,
  resolveTrustedCisConfig,
} from '../src/fix/cis/config.js';
import { CisTransportError, redactTransportErrorMessage } from '../src/fix/cis/transport.js';
import { ModelSelectionError } from '../src/fix/eval/model-selection.js';
import {
  startFixController,
  loadReportFromPath,
  createProposeCandidateOperation,
  createVerifyRegisteredCandidateOperation,
  resolveDefaultTrustedVerification,
} from '../src/fix/controller/index.js';
import { loadReviewState } from '../src/fix/review/state.js';
import { buildManualCheckAttestations } from '../src/fix/manual-checks.js';
import { writeAtomicFile } from '../src/fix/apply/transaction.js';
import { rankModelRuns, serializeBenchmarkRanking, BENCHMARK_SCORE_SCHEMA, BENCHMARK_MISSING_METRIC } from '../src/fix/eval/model-selection.js';
import { assertSerializedRedacted } from './lib/cis-redaction.js';

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const UNSAFE_REASON_CODES = new Set([
  'STALE_PREIMAGE',
  'SOURCE_PREIMAGE_MISMATCH',
  'PATH_OUTSIDE_LOCAL_ROOT',
  'OVERLAPPING_EDITS',
]);

const ALLOWED_OUTCOME_KEYS = new Set([
  'fixUnitId',
  'canonicalRuleId',
  'eligible',
  'proposed',
  'verified',
  'newCriticalSerious',
  'invalid',
  'unsafe',
  'unnecessaryCannotFix',
  'latencyMs',
  'totalTokens',
  'manualChecksRequired',
  'manualChecksHumanVerified',
  'reasonCode',
]);

/**
 * @param {import('../src/fix/canonical/fix-unit.js').FixUnit[]} proposable
 * @param {number} maxUnits
 */
export function selectProposableAccessibilityUnits(proposable, maxUnits) {
  return proposable
    .filter((unit) => unit.kind === 'accessibility')
    .sort((left, right) => left.fixUnitId.localeCompare(right.fixUnitId))
    .slice(0, maxUnits)
    .map((unit) => ({
      fixUnitId: unit.fixUnitId,
      canonicalRuleId: unit.canonicalRuleId,
      eligible: true,
    }));
}

/**
 * @param {string} reasonCode
 */
export function isInvalidBenchmarkReason(reasonCode) {
  const code = String(reasonCode || '');
  return code.includes('PARSER') || code.includes('INVALID_RESPONSE');
}

/**
 * @param {string} reasonCode
 */
export function isUnsafeBenchmarkReason(reasonCode) {
  return UNSAFE_REASON_CODES.has(String(reasonCode || ''));
}

/**
 * @param {Record<string, unknown>} outcome
 */
export function sanitizeBenchmarkOutcome(outcome) {
  const sanitized = {};
  for (const key of ALLOWED_OUTCOME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(outcome, key)) {
      sanitized[key] = outcome[key];
    }
  }
  sanitized.manualChecksHumanVerified = false;
  return Object.freeze(sanitized);
}

/**
 * @param {Array<{ modelId: string, outcomes: Array<Record<string, unknown>> }>} runs
 */
export function markUnnecessaryCannotFixOutcomes(runs) {
  const verifiedByUnit = new Set();
  for (const run of runs) {
    for (const outcome of run.outcomes) {
      if (
        outcome.proposed
        && outcome.verified
        && outcome.newCriticalSerious === 0
        && outcome.fixUnitId
      ) {
        verifiedByUnit.add(outcome.fixUnitId);
      }
    }
  }

  for (const run of runs) {
    for (const outcome of run.outcomes) {
      if (
        outcome._cannotFix
        && !outcome.proposed
        && !outcome.invalid
        && !outcome.unsafe
        && verifiedByUnit.has(outcome.fixUnitId)
      ) {
        outcome.unnecessaryCannotFix = true;
      }
    }
  }
}

/**
 * @param {Array<{ modelId: string, outcomes: Array<Record<string, unknown>> }>} runs
 */
export function sanitizeBenchmarkRuns(runs) {
  return runs.map((run) => ({
    modelId: run.modelId,
    outcomes: run.outcomes.map((outcome) => sanitizeBenchmarkOutcome(outcome)),
  }));
}

/**
 * @param {{
 *   modelIds: string[],
 *   cases: Array<Record<string, unknown>>,
 *   evaluateCase: (ctx: { modelId: string, benchmarkCase: Record<string, unknown> }) => Promise<Record<string, unknown>>,
 * }} params
 */
export async function runCisModelBenchmark({ modelIds, cases, evaluateCase }) {
  const runs = [];
  for (const modelId of modelIds) {
    const outcomes = [];
    for (const benchmarkCase of cases) {
      try {
        outcomes.push(await evaluateCase({ modelId, benchmarkCase }));
      } catch (error) {
        outcomes.push({
          fixUnitId: benchmarkCase.fixUnitId,
          canonicalRuleId: benchmarkCase.canonicalRuleId,
          eligible: benchmarkCase.eligible !== false,
          proposed: false,
          verified: false,
          newCriticalSerious: 0,
          invalid: isInvalidBenchmarkReason(error?.code),
          unsafe: isUnsafeBenchmarkReason(error?.code),
          unnecessaryCannotFix: false,
          latencyMs: null,
          totalTokens: null,
          manualChecksRequired: 0,
          manualChecksHumanVerified: false,
          reasonCode: error?.code || 'BENCHMARK_CASE_FAILED',
        });
      }
    }
    runs.push({ modelId, outcomes });
  }

  markUnnecessaryCannotFixOutcomes(runs);
  const sanitizedRuns = sanitizeBenchmarkRuns(runs);
  return { runs: sanitizedRuns, ranking: rankModelRuns(sanitizedRuns) };
}

/**
 * @param {string} timestamp
 */
export function sessionIdForBenchmarkBootstrap(timestamp) {
  return `cis-bench-bootstrap-${timestamp}`;
}

/**
 * @param {string} modelId
 * @param {string} timestamp
 */
export function sessionIdForBenchmarkModel(modelId, timestamp) {
  const slug = createHash('sha256').update(modelId).digest('hex').slice(0, 16);
  return `cis-bench-${slug}-${timestamp}`;
}

/**
 * @param {string} dateIso
 */
export function utcSafeBenchmarkTimestamp(dateIso) {
  return String(dateIso).replace(/:/g, '-').replace(/\..+$/, 'Z');
}

/**
 * @param {string[]} requested
 * @param {string[]} inventory
 */
export function findUnavailableModelIds(requested, inventory) {
  const available = new Set(inventory);
  return requested.filter((modelId) => !available.has(modelId));
}

/**
 * @param {string} modelsArg
 */
export function parseModelIdsArg(modelsArg) {
  return String(modelsArg || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * @param {{
 *   proposal: Record<string, unknown>,
 *   verifyResult?: Record<string, unknown> | null,
 *   benchmarkCase: Record<string, unknown>,
 *   startedAt: number,
 *   cannotFix?: boolean,
 *   verifyReason?: string | null,
 * }} params
 */
export function buildBenchmarkOutcomeFromResults({
  proposal,
  verifyResult = null,
  benchmarkCase,
  startedAt,
  cannotFix = false,
  verifyReason = null,
}) {
  const telemetry = proposal.telemetry || {};
  const latencyMs = Number.isFinite(telemetry?.latencyMs?.total)
    ? telemetry.latencyMs.total
    : Date.now() - startedAt;
  const totalTokens = Number.isFinite(telemetry?.tokens?.total) ? telemetry.tokens.total : null;

  if (!proposal.ok) {
    const reasonCode = proposal.reason || 'PROPOSAL_FAILED';
    return {
      fixUnitId: benchmarkCase.fixUnitId,
      canonicalRuleId: benchmarkCase.canonicalRuleId,
      eligible: benchmarkCase.eligible !== false,
      proposed: false,
      verified: false,
      newCriticalSerious: 0,
      invalid: isInvalidBenchmarkReason(reasonCode),
      unsafe: isUnsafeBenchmarkReason(reasonCode),
      unnecessaryCannotFix: false,
      latencyMs,
      totalTokens,
      manualChecksRequired: 0,
      manualChecksHumanVerified: false,
      reasonCode,
      _cannotFix: cannotFix,
    };
  }

  const manualChecks = Array.isArray(proposal.manualChecks) ? proposal.manualChecks : [];
  let verified = false;
  let newCriticalSerious = 0;
  let reasonCode = 'PROPOSED';

  if (verifyResult) {
    verified = Boolean(verifyResult.ok);
    const artifact = verifyResult.verification?.artifact || {};
    newCriticalSerious = Array.isArray(artifact.newCriticalSerious)
      ? artifact.newCriticalSerious.length
      : 0;
    reasonCode = verified
      ? 'VERIFIED'
      : verifyReason || verifyResult.reason || verifyResult.verification?.reason || 'VERIFICATION_FAILED';
  } else if (verifyReason) {
    verified = false;
    reasonCode = verifyReason;
  }

  return {
    fixUnitId: benchmarkCase.fixUnitId,
    canonicalRuleId: benchmarkCase.canonicalRuleId,
    eligible: benchmarkCase.eligible !== false,
    proposed: true,
    verified,
    newCriticalSerious,
    invalid: isInvalidBenchmarkReason(reasonCode),
    unsafe: isUnsafeBenchmarkReason(reasonCode),
    unnecessaryCannotFix: false,
    latencyMs,
    totalTokens,
    manualChecksRequired: manualChecks.length,
    manualChecksHumanVerified: false,
    reasonCode,
    _cannotFix: false,
  };
}

/**
 * @param {{
 *   report: import('../src/reporter/report-v2.js').ScanReportV2,
 *   localRoot: string,
 *   modelId: string,
 *   timestamp: string,
 *   transport: unknown,
 *   verification: Record<string, unknown>,
 *   startFixController?: typeof startFixController,
 *   loadReviewState?: typeof loadReviewState,
 *   createProposeCandidateOperation?: typeof createProposeCandidateOperation,
 *   createVerifyRegisteredCandidateOperation?: typeof createVerifyRegisteredCandidateOperation,
 * }} params
 */
export function createBenchmarkModelSession({
  report,
  localRoot,
  modelId,
  timestamp,
  transport,
  verification,
  startFixController: startFixControllerImpl = startFixController,
  loadReviewState: loadReviewStateImpl = loadReviewState,
  createProposeCandidateOperation: createProposeCandidateOperationImpl = createProposeCandidateOperation,
  createVerifyRegisteredCandidateOperation: createVerifyRegisteredCandidateOperationImpl = createVerifyRegisteredCandidateOperation,
}) {
  const controller = startFixControllerImpl({
    report,
    localRoot,
    sessionId: sessionIdForBenchmarkModel(modelId, timestamp),
  });

  if (controller.status !== 'pending') {
    throw Object.assign(new Error('Benchmark requires a proposable fix controller session.'), {
      code: 'BENCHMARK_SESSION_UNAVAILABLE',
    });
  }

  const reviewState = loadReviewStateImpl({
    sessionDir: controller.sessionDir,
    reportId: report.reportId,
    sessionId: controller.session.sessionId,
    fixUnits: controller.fixUnits,
    traceResults: controller.traceResults,
    policyRoutes: controller.policyRoutes,
    traceInbox: controller.traceInbox,
    localRoot,
    controllerAudit: controller.session?.auditLog || [],
  });

  const proposeCandidate = createProposeCandidateOperationImpl({
    reviewState,
    localRoot,
    reportId: report.reportId,
    transport,
    model: modelId,
  });

  const verifyRegisteredCandidate = createVerifyRegisteredCandidateOperationImpl({
    reviewState,
    localRoot,
    reportId: report.reportId,
    verification,
    fixUnits: controller.fixUnits,
  });

  return {
    controller,
    reviewState,
    proposeCandidate,
    verifyRegisteredCandidate,
  };
}

/**
 * @param {{
 *   session: ReturnType<typeof createBenchmarkModelSession>,
 *   benchmarkCase: Record<string, unknown>,
 *   buildManualCheckAttestations?: typeof buildManualCheckAttestations,
 *   now?: () => number,
 * }} params
 */
export async function evaluateBenchmarkCaseWithSession({
  session,
  benchmarkCase,
  buildManualCheckAttestations: buildManualCheckAttestationsImpl = buildManualCheckAttestations,
  now = () => Date.now(),
}) {
  const startedAt = now();
  const { reviewState, proposeCandidate, verifyRegisteredCandidate } = session;
  const proposal = await proposeCandidate(benchmarkCase.fixUnitId);

  if (!proposal.ok) {
    const cannotFix = proposal.advisory?.kind === 'cannot_fix';
    return buildBenchmarkOutcomeFromResults({
      proposal,
      benchmarkCase,
      startedAt,
      cannotFix,
    });
  }

  const candidate = reviewState.getCandidate(benchmarkCase.fixUnitId);
  const attestations = buildManualCheckAttestationsImpl(
    candidate.candidateHash,
    candidate.manualChecks || [],
  );
  const acknowledgedCheckIds = attestations.map((item) => item.checkId);

  let verifyResult = null;
  let verifyReason = null;
  try {
    verifyResult = await verifyRegisteredCandidate(benchmarkCase.fixUnitId, { acknowledgedCheckIds });
  } catch (error) {
    verifyReason = error?.code || 'VERIFY_FAILED';
  }

  return buildBenchmarkOutcomeFromResults({
    proposal,
    verifyResult,
    benchmarkCase,
    startedAt,
    verifyReason,
  });
}

/**
 * @param {{
 *   reportId: string,
 *   generatedAt: string,
 *   maxUnits: number,
 *   modelIds: string[],
 *   runs: Array<Record<string, unknown>>,
 *   ranking: Array<Record<string, unknown>>,
 * }} artifact
 */
export function buildBenchmarkArtifact(artifact) {
  return Object.freeze({
    scoreSchema: BENCHMARK_SCORE_SCHEMA,
    missingMetricValue: BENCHMARK_MISSING_METRIC,
    reportId: artifact.reportId,
    generatedAt: artifact.generatedAt,
    maxUnits: artifact.maxUnits,
    modelIds: [...artifact.modelIds],
    runs: artifact.runs,
    ranking: serializeBenchmarkRanking(artifact.ranking),
  });
}

/**
 * @param {string} localRoot
 * @param {string} timestamp
 * @param {Record<string, unknown>} artifact
 * @param {{
 *   writeAtomicFile?: typeof writeAtomicFile,
 *   mkdirSync?: typeof mkdirSync,
 *   chmodSync?: typeof chmodSync,
 * }} [deps]
 */
export function writeBenchmarkArtifact(localRoot, timestamp, artifact, {
  writeAtomicFile: writeAtomicFileImpl = writeAtomicFile,
  mkdirSync: mkdirSyncImpl = mkdirSync,
  chmodSync: chmodSyncImpl = chmodSync,
} = {}) {
  const dir = path.join(localRoot, 'scan-reports', 'cis-benchmarks', timestamp);
  mkdirSyncImpl(dir, { recursive: true, mode: 0o700 });
  chmodSyncImpl(dir, 0o700);
  const parent = path.dirname(dir);
  chmodSyncImpl(parent, 0o700);

  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  assertSerializedRedacted(serialized, 'cis-benchmark artifact');
  writeAtomicFileImpl(path.join(dir, 'results.json'), Buffer.from(serialized, 'utf8'), 0o600);
  return path.join(dir, 'results.json');
}

/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   stdoutWrite?: (chunk: string) => void,
 *   stderrWrite?: (chunk: string) => void,
 *   resolveConfig?: (env: NodeJS.ProcessEnv) => ReturnType<typeof resolveTrustedCisConfig>,
 *   createTransportBundle?: typeof createCisTransportFromTrustedConfig,
 *   loadReportFromPath?: typeof loadReportFromPath,
 *   resolveDefaultTrustedVerification?: typeof resolveDefaultTrustedVerification,
 *   startFixController?: typeof startFixController,
 *   loadReviewState?: typeof loadReviewState,
 *   createProposeCandidateOperation?: typeof createProposeCandidateOperation,
 *   createVerifyRegisteredCandidateOperation?: typeof createVerifyRegisteredCandidateOperation,
 *   runCisModelBenchmark?: typeof runCisModelBenchmark,
 *   writeBenchmarkArtifact?: typeof writeBenchmarkArtifact,
 *   now?: () => Date,
 * }} [options]
 */
export async function runCisBenchmarkCli({
  argv = process.argv,
  env = process.env,
  stdoutWrite = (chunk) => process.stdout.write(chunk),
  stderrWrite = (chunk) => process.stderr.write(chunk),
  resolveConfig = (candidateEnv) => resolveTrustedCisConfig(candidateEnv, { requireModel: false }),
  createTransportBundle = createCisTransportFromTrustedConfig,
  loadReportFromPath: loadReportFromPathImpl = loadReportFromPath,
  resolveDefaultTrustedVerification: resolveDefaultTrustedVerificationImpl = resolveDefaultTrustedVerification,
  startFixController: startFixControllerImpl = startFixController,
  loadReviewState: loadReviewStateImpl = loadReviewState,
  createProposeCandidateOperation: createProposeCandidateOperationImpl = createProposeCandidateOperation,
  createVerifyRegisteredCandidateOperation: createVerifyRegisteredCandidateOperationImpl = createVerifyRegisteredCandidateOperation,
  runCisModelBenchmark: runCisModelBenchmarkImpl = runCisModelBenchmark,
  writeBenchmarkArtifact: writeBenchmarkArtifactImpl = writeBenchmarkArtifact,
  now = () => new Date(),
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv.slice(2),
      options: {
        report: { type: 'string' },
        'local-root': { type: 'string' },
        models: { type: 'string' },
        'max-units': { type: 'string' },
      },
      strict: true,
    }));
  } catch {
    stderrWrite('CIS_BENCHMARK_INVALID: CIS benchmark arguments are invalid.\n');
    return 1;
  }

  const reportPath = String(values.report || '').trim();
  const localRoot = path.resolve(String(values['local-root'] || '').trim());
  const modelIds = parseModelIdsArg(values.models);
  const maxUnits = Number.parseInt(String(values['max-units'] || ''), 10);

  if (!reportPath || !localRoot || modelIds.length === 0 || !Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 50) {
    stderrWrite('CIS_BENCHMARK_INVALID: CIS benchmark arguments are invalid.\n');
    return 1;
  }

  for (const modelId of modelIds) {
    if (!MODEL_ID_PATTERN.test(modelId)) {
      stderrWrite('CIS_BENCHMARK_INVALID: CIS benchmark arguments are invalid.\n');
      return 1;
    }
  }

  const config = resolveConfig(env);
  if (!config.ok) {
    stderrWrite(`${config.reason}: ${config.message}\n`);
    return 1;
  }

  const bundle = createTransportBundle(config);
  if (!bundle) {
    stderrWrite('CIS_CONFIG_MISSING: CIS benchmark is unavailable.\n');
    return 1;
  }

  /** @type {import('../src/fix/cis/transport.js').ReturnType<typeof import('../src/fix/cis/transport.js').createCisTransport> | null} */
  let transport = null;
  try {
    let report;
    try {
      report = loadReportFromPathImpl(reportPath);
    } catch {
      stderrWrite('CIS_BENCHMARK_INVALID: Scan report could not be loaded.\n');
      return 1;
    }

    transport = await bundle.importTransport();
    const { models: inventory } = await transport.listModels();
    const unavailable = findUnavailableModelIds(modelIds, inventory);
    if (unavailable.length > 0) {
      stderrWrite('CIS_MODEL_UNAVAILABLE: Requested CIS model IDs are not in live inventory.\n');
      return 1;
    }

    const timestamp = utcSafeBenchmarkTimestamp(now().toISOString());
    const bootstrap = startFixControllerImpl({
      report,
      localRoot,
      sessionId: sessionIdForBenchmarkBootstrap(timestamp),
    });
    if (bootstrap.status !== 'pending') {
      stderrWrite('CIS_BENCHMARK_INVALID: Benchmark report has no proposable fix units.\n');
      return 1;
    }

    const cases = selectProposableAccessibilityUnits(bootstrap.proposable, maxUnits);
    const verification = resolveDefaultTrustedVerificationImpl(localRoot);

    const sessions = new Map();
    for (const modelId of modelIds) {
      sessions.set(
        modelId,
        createBenchmarkModelSession({
          report,
          localRoot,
          modelId,
          timestamp,
          transport,
          verification,
          startFixController: startFixControllerImpl,
          loadReviewState: loadReviewStateImpl,
          createProposeCandidateOperation: createProposeCandidateOperationImpl,
          createVerifyRegisteredCandidateOperation: createVerifyRegisteredCandidateOperationImpl,
        }),
      );
    }

    const result = await runCisModelBenchmarkImpl({
      modelIds,
      cases,
      evaluateCase: async ({ modelId, benchmarkCase }) =>
        evaluateBenchmarkCaseWithSession({
          session: sessions.get(modelId),
          benchmarkCase,
        }),
    });

    const artifact = buildBenchmarkArtifact({
      reportId: report.reportId,
      generatedAt: now().toISOString(),
      maxUnits,
      modelIds,
      runs: result.runs,
      ranking: result.ranking,
    });

    writeBenchmarkArtifactImpl(localRoot, timestamp, artifact);

    stdoutWrite(`${JSON.stringify({
      scoreSchema: BENCHMARK_SCORE_SCHEMA,
      missingMetricValue: BENCHMARK_MISSING_METRIC,
      modelIds,
      ranking: serializeBenchmarkRanking(result.ranking).map((entry) => ({
        modelId: entry.modelId,
        verifiedResolutionRate: entry.verifiedResolutionRate,
        verifiedCount: entry.verifiedCount,
        eligibleCount: entry.eligibleCount,
        medianLatencyMs: entry.medianLatencyMs,
        totalTokens: entry.totalTokens,
      })),
    })}\n`);
    return 0;
  } catch (error) {
    stderrWrite(`${formatBenchmarkCliError(error)}\n`);
    return 1;
  } finally {
    if (transport) {
      await transport.close().catch(() => {});
    }
  }
}

/**
 * @param {unknown} error
 */
export function formatBenchmarkCliError(error) {
  if (error instanceof CisTransportError) {
    return redactTransportErrorMessage(error);
  }
  if (error instanceof ModelSelectionError) {
    return `${error.code}: ${error.message}`;
  }
  if (error && typeof error === 'object' && typeof error.code === 'string' && error.code) {
    return `${error.code}: ${error.message || 'CIS benchmark failed.'}`;
  }
  return redactTransportErrorMessage(error);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runCisBenchmarkCli().then((code) => {
    process.exitCode = code;
  });
}
