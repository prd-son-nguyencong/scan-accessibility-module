import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildVerificationKey, compareVerificationFindings } from '../verify/verification-key.js';
import {
  aggregateCisTelemetryRecords,
  evaluateCisCallBudget,
  nearestRankP95,
} from '../cis/telemetry.js';
import {
  evaluateAuditCoverage,
  evaluateMonotonicStateRevision,
  evaluateSuccessPathAuditSequence,
  SUCCESS_PATH_AUDIT_TYPES,
} from '../audit/coverage.js';

const SECRET_VALUE_PATTERN = /(?:sk-[A-Za-z0-9]{10,}|(?:bearer|token|secret|apikey|api_key)\s*[:=]\s*['"]?[a-z0-9._-]{8,}|CIS_AUTH_TOKEN\s*=\s*\S+|CIS_FEATURE_KEY\s*=\s*\S+)/i;
const ABS_PATH_PATTERN = /(?:\/Users\/[^\s"'`]+|\/home\/[^\s"'`]+|C:\\Users\\[^\s"'`]+|\/private\/[^\s"'`]+|\/var\/[^\s"'`]+|file:\/\/[^\s"'`]+)/i;
const RAW_HTML_PATTERN = /<(?:html|head|body|script|button|main)[\s/>]/i;
const MODEL_OUTPUT_PATTERN = /(?:oldText|newText|modelOutput|outerHTML)\s*[:=]\s*['"][^'"]{20,}/i;

/** Scan captured logs/telemetry/audit text for redaction leaks (CI/release gate helper). */
export function scanOutputForRedactionLeaks(text = '') {
  const sample = String(text);
  if (SECRET_VALUE_PATTERN.test(sample)) return { ok: false, reason: 'SECRET_LEAK' };
  if (ABS_PATH_PATTERN.test(sample)) return { ok: false, reason: 'ABS_PATH_LEAK' };
  if (RAW_HTML_PATTERN.test(sample)) return { ok: false, reason: 'RAW_HTML_LEAK' };
  if (MODEL_OUTPUT_PATTERN.test(sample)) return { ok: false, reason: 'MODEL_OUTPUT_LEAK' };
  return { ok: true };
}

/** CI/release gate — not invoked per-user apply. */
export function evaluateSafetyGate(sample = {}) {
  const {
    preApplyBytesByFile = {},
    postApplyBytesByFile = {},
    staleRejections = 0,
    staleAttempts = 0,
    wrongCandidateRejections = 0,
    wrongCandidateAttempts = 0,
    rollbackRestored = true,
    urlOnlyBlocked = true,
    hybridUnattestedBlocked = true,
    logs = '',
    sessionArtifacts = [],
  } = sample;

  if (staleAttempts <= 0 || wrongCandidateAttempts <= 0) {
    return { ok: false, reason: 'SAFETY_DENOMINATOR_ZERO' };
  }
  if (staleRejections / staleAttempts !== 1) {
    return { ok: false, reason: 'STALE_REJECTION_RATE', rate: staleRejections / staleAttempts };
  }
  if (wrongCandidateRejections / wrongCandidateAttempts !== 1) {
    return { ok: false, reason: 'WRONG_CANDIDATE_REJECTION_RATE', rate: wrongCandidateRejections / wrongCandidateAttempts };
  }
  if (!rollbackRestored) return { ok: false, reason: 'ROLLBACK_NOT_BYTE_EXACT' };
  if (!urlOnlyBlocked || !hybridUnattestedBlocked) return { ok: false, reason: 'UNTRUSTED_MODE_NOT_SCAN_ONLY' };

  for (const [file, before] of Object.entries(preApplyBytesByFile)) {
    if (postApplyBytesByFile[file] !== before) {
      return { ok: false, reason: 'PRE_APPLY_SOURCE_MUTATION', file };
    }
  }

  const redaction = scanOutputForRedactionLeaks(logs);
  if (!redaction.ok) {
    return { ok: false, reason: 'LOG_REDACTION_FAILED', detail: redaction.reason };
  }

  for (const artifact of sessionArtifacts) {
    if (typeof artifact === 'string' && (artifact.includes('.ada-fix.apply.lock') || artifact.endsWith('.tmp') || artifact.endsWith('.rollback'))) {
      return { ok: false, reason: 'ARTIFACT_LEAK', artifact };
    }
  }

  return { ok: true };
}

/** CI/release gate — requires >=100 evaluated non-ambiguous trace cases at >=99% precision. */
export function evaluateTracePrecision(cases = [], { minPrecision = 0.99 } = {}) {
  if (!Array.isArray(cases) || cases.length < 100) {
    return { ok: false, reason: 'TRACE_CORPUS_TOO_SMALL', count: cases.length };
  }
  let correct = 0;
  let blockedAmbiguous = 0;
  for (const item of cases) {
    if (item.ambiguous) {
      blockedAmbiguous += 1;
      continue;
    }
    if (item.expectedFile === item.actualFile && item.expectedLine === item.actualLine) correct += 1;
  }
  const evaluated = cases.length - blockedAmbiguous;
  if (evaluated < 100) {
    return { ok: false, reason: 'TRACE_CORPUS_TOO_SMALL', count: evaluated };
  }
  const precision = correct / evaluated;
  if (precision < minPrecision) {
    return { ok: false, reason: 'TRACE_PRECISION_BELOW_THRESHOLD', precision, blockedAmbiguous };
  }
  return { ok: true, precision, blockedAmbiguous, count: evaluated };
}

/** CI/release quality gate — not per-user apply. */
export function evaluateQualityGate(sample = {}) {
  const {
    traceCases = [],
    acceptedBuildExitCodes = [],
    detectorTargets = [],
    detectorDetected = [],
    newCriticalSerious = [],
    manualChecksRetained = true,
    manualChecksAcknowledged = true,
    unitFindingIds = [],
  } = sample;

  const trace = evaluateTracePrecision(traceCases);
  if (!trace.ok) return trace;

  if (!acceptedBuildExitCodes.length || acceptedBuildExitCodes.some((code) => code !== 0)) {
    return { ok: false, reason: 'ACCEPTED_BUILD_FAILED' };
  }

  if (detectorTargets.length < 10) {
    return { ok: false, reason: 'DETECTOR_CORPUS_TOO_SMALL', count: detectorTargets.length };
  }

  const detectedSet = new Set(detectorDetected.map((item) => buildVerificationKey(item)));
  const closure = detectorTargets.filter((item) => detectedSet.has(buildVerificationKey(item))).length / detectorTargets.length;
  if (closure < 0.9) {
    return { ok: false, reason: 'DETECTOR_CLOSURE_BELOW_THRESHOLD', closure };
  }

  if (newCriticalSerious.length > 0) {
    return { ok: false, reason: 'NEW_CRITICAL_SERIOUS', count: newCriticalSerious.length };
  }
  if (!manualChecksRetained || !manualChecksAcknowledged) {
    return { ok: false, reason: 'MANUAL_CHECKS_NOT_RETAINED' };
  }

  const owners = new Map();
  for (const findingId of unitFindingIds) {
    if (owners.has(findingId)) return { ok: false, reason: 'DUPLICATE_FINDING_UI_UNIT', findingId };
    owners.set(findingId, true);
  }

  return { ok: true, precision: trace.precision, closure };
}

/** CI/release operational gate from actual telemetry NDJSON + session audit. */
export function evaluateOperationalGate(sample = {}) {
  const {
    telemetryRecords = [],
    auditLog = [],
    leftoverArtifacts = [],
    maxCalls = 2,
    requiredAuditTypes = SUCCESS_PATH_AUDIT_TYPES,
  } = sample;

  const budget = evaluateCisCallBudget(telemetryRecords, maxCalls);
  if (!budget.ok) return budget;

  const aggregate = aggregateCisTelemetryRecords(telemetryRecords);
  if (aggregate.tokens.total == null && telemetryRecords.some((record) => record.outcome === 'proposed')) {
    return { ok: false, reason: 'TELEMETRY_TOTALS_MISSING' };
  }

  const sequence = evaluateSuccessPathAuditSequence(auditLog, requiredAuditTypes);
  if (!sequence.ok) return sequence;

  const transitions = auditLog.filter((event) => event.type === 'state_transition');
  if (
    transitions.length === 0
    || transitions.some((event) => typeof event.from !== 'string' || typeof event.to !== 'string')
  ) {
    return { ok: false, reason: 'STATE_TRANSITION_AUDIT_INVALID' };
  }

  const monotonic = evaluateMonotonicStateRevision(
    auditLog.filter((event) => event.stateRevision != null),
  );
  if (!monotonic.ok) return monotonic;

  for (const artifact of leftoverArtifacts) {
    if (artifact) return { ok: false, reason: 'LEFTOVER_ARTIFACT', artifact };
  }

  return { ok: true, p95: budget.p95, aggregate };
}

export function collectLeftoverArtifacts(root) {
  if (!existsSync(root)) return [];
  const matches = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('ada-shadow-') || entry.name.startsWith('ada-post-apply-')) matches.push(full);
        walk(full);
        continue;
      }
      if (entry.name.includes('.ada-fix.apply.lock') || entry.name.endsWith('.tmp') || entry.name.endsWith('.rollback')) {
        matches.push(full);
      }
    }
  };
  walk(root);
  return matches;
}

export {
  nearestRankP95,
  compareVerificationFindings,
  evaluateCisCallBudget,
};
