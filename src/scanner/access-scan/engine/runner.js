import { filterChecksForProfile, PROFILES } from './profiles.js';
import { dedupeFindings, normalizeFinding } from './finding.js';
import { resolveCheckClassification } from './classification.js';
import { createRuleDeadline } from './deadline.js';

/**
 * @typedef {import('./registry.js').RuleRegistry} RuleRegistry
 * @typedef {import('./schema.js').ProfileId} ProfileId
 * @typedef {import('./finding.js').NormalizedFinding} NormalizedFinding
 */

const DEFAULT_RULE_TIMEOUT_MS = 30_000;

/**
 * @typedef {'complete' | 'inapplicable' | 'error' | 'timeout'} ExecutionStatus
 *
 * @typedef {object} CheckExecutionRecord
 * @property {string} checkId
 * @property {ExecutionStatus} status
 * @property {number} durationMs
 * @property {number} candidateCount
 * @property {number} findingCount
 * @property {string=} errorCode
 *
 * @typedef {object} RuleExecutionRecord
 * @property {string} ruleId
 * @property {ExecutionStatus} status
 * @property {number} durationMs
 * @property {number} candidateCount
 * @property {number} findingCount
 * @property {string=} errorCode
 * @property {CheckExecutionRecord[]} checks
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function sanitizeErrorCode(error) {
  if (error && typeof error === 'object' && 'errorCode' in error && error.errorCode) {
    return String(error.errorCode);
  }
  return 'evaluator_failure';
}

/**
 * @param {unknown} raw
 */
function normalizeEvaluatorResult(raw) {
  if (raw === null || raw === undefined) {
    throw Object.assign(new Error('Invalid evaluator result'), { errorCode: 'evaluator_failure' });
  }

  if (Array.isArray(raw)) {
    return {
      status: 'complete',
      candidates: raw.length,
      candidatesScanned: raw.length,
      findings: raw,
    };
  }

  if (typeof raw !== 'object') {
    throw Object.assign(new Error('Invalid evaluator result'), { errorCode: 'evaluator_failure' });
  }

  const result = /** @type {Record<string, unknown>} */ (raw);
  if (
    result.status !== undefined
    && result.status !== 'complete'
    && result.status !== 'inapplicable'
  ) {
    throw Object.assign(new Error('Invalid evaluator result'), { errorCode: 'evaluator_failure' });
  }

  const findings = Array.isArray(result.findings)
    ? result.findings
    : (Array.isArray(result.candidates) ? result.candidates : []);
  const candidates = (
    typeof result.candidates === 'number'
      ? result.candidates
      : (typeof result.candidatesScanned === 'number' ? result.candidatesScanned : findings.length)
  );
  const candidatesScanned = (
    typeof result.candidatesScanned === 'number' ? result.candidatesScanned : candidates
  );

  return {
    status: result.status === 'inapplicable' ? 'inapplicable' : 'complete',
    candidates,
    candidatesScanned,
    findings,
  };
}

/**
 * @param {CheckExecutionRecord[]} checkRecords
 * @returns {ExecutionStatus}
 */
function deriveRuleStatus(checkRecords) {
  if (checkRecords.length === 0) {
    return 'inapplicable';
  }
  if (checkRecords.some((check) => check.status === 'timeout')) {
    return 'timeout';
  }
  if (checkRecords.some((check) => check.status === 'error')) {
    return 'error';
  }
  if (checkRecords.every((check) => check.status === 'inapplicable')) {
    return 'inapplicable';
  }
  return 'complete';
}

/**
 * @param {CheckExecutionRecord[]} checkRecords
 * @returns {string | undefined}
 */
function aggregateRuleErrorCode(checkRecords) {
  const codes = checkRecords.map((check) => check.errorCode).filter(Boolean);
  if (codes.includes('rule_timeout')) return 'rule_timeout';
  if (codes.includes('scan_cancelled')) return 'scan_cancelled';
  if (codes.includes('evaluator_failure')) return 'evaluator_failure';
  return undefined;
}

/**
 * @param {string} errorCode
 * @returns {ExecutionStatus}
 */
function statusForErrorCode(errorCode) {
  return errorCode === 'rule_timeout' ? 'timeout' : 'error';
}

/**
 * @param {{
 *   registry: RuleRegistry,
 *   profile?: ProfileId,
 *   context: unknown,
 *   skipRules?: string[],
 *   ruleTimeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function runRules({
  registry,
  profile = PROFILES.STANDARDS,
  context,
  skipRules = [],
  ruleTimeoutMs = DEFAULT_RULE_TIMEOUT_MS,
  signal,
}) {
  const evaluators = registry.getEvaluators();
  const skip = new Set(skipRules);
  /** @type {NormalizedFinding[]} */
  const findings = [];
  /** @type {RuleExecutionRecord[]} */
  const executionRecords = [];

  for (const rule of registry.listRules()) {
    if (skip.has(rule.id) || !registry.isEmittingRule(rule.id)) {
      continue;
    }

    const checks = filterChecksForProfile(rule.checks, profile);
    const startedAt = Date.now();

    if (checks.length === 0) {
      executionRecords.push({
        ruleId: rule.id,
        status: 'inapplicable',
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        findingCount: 0,
        checks: [],
      });
      continue;
    }

    /** @type {CheckExecutionRecord[]} */
    const checkRecords = [];

    for (const check of checks) {
      const evaluator = evaluators.get(check.evaluator);
      const checkStartedAt = Date.now();
      const deadline = createRuleDeadline({ timeoutMs: ruleTimeoutMs, parentSignal: signal });
      /** @type {CheckExecutionRecord} */
      const checkRecord = {
        checkId: check.id,
        status: 'complete',
        durationMs: 0,
        candidateCount: 0,
        findingCount: 0,
      };

      try {
        const raw = await deadline.run(
          evaluator.evaluate(context, check, { signal: deadline.signal }),
        );
        const result = normalizeEvaluatorResult(raw);

        checkRecord.status = result.status === 'inapplicable' ? 'inapplicable' : 'complete';
        checkRecord.candidateCount = result.candidatesScanned ?? result.candidates ?? 0;
        checkRecord.findingCount = result.findings.length;

        const violationType = resolveCheckClassification(rule, check);
        const checkProfile = check.profiles.includes(PROFILES.COMMERCIAL_PARITY)
          && !check.profiles.includes(PROFILES.STANDARDS)
          ? PROFILES.COMMERCIAL_PARITY
          : profile;
        for (const candidate of result.findings) {
          findings.push(
            normalizeFinding(
              {
                ...candidate,
                violationType,
              },
              rule,
              { checkId: check.id, profile: checkProfile },
            ),
          );
        }
      } catch (error) {
        const errorCode = sanitizeErrorCode(error);
        checkRecord.status = statusForErrorCode(errorCode);
        checkRecord.errorCode = errorCode;
      } finally {
        checkRecord.durationMs = Date.now() - checkStartedAt;
        checkRecords.push(checkRecord);
      }
    }

    const ruleStatus = deriveRuleStatus(checkRecords);
    const ruleErrorCode = aggregateRuleErrorCode(checkRecords);

    /** @type {RuleExecutionRecord} */
    const record = {
      ruleId: rule.id,
      status: ruleStatus,
      durationMs: Date.now() - startedAt,
      candidateCount: checkRecords.reduce((sum, check) => sum + check.candidateCount, 0),
      findingCount: checkRecords.reduce((sum, check) => sum + check.findingCount, 0),
      checks: checkRecords,
    };
    if (ruleErrorCode && (ruleStatus === 'error' || ruleStatus === 'timeout')) {
      record.errorCode = ruleErrorCode;
    }
    executionRecords.push(record);
  }

  return { findings: dedupeFindings(findings), executionRecords };
}
