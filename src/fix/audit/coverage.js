export const REQUIRED_REVIEW_AUDIT_TYPES = Object.freeze([
  'state_initialized',
  'state_transition',
  'controller_started',
  'proposal_registered',
  'proposal_failed',
  'proposal_cannot_fix',
  'candidate_registered',
  'candidate_verified_registered',
  'verify_started',
  'verify_completed',
  'verify_failed',
  'manual_checks_acknowledged',
  'decision_accepted',
  'decision_rejected',
  'decision_pending',
  'revision_requested',
  'diff_approved',
  'apply_started',
  'apply_completed',
  'apply_failed',
  'post_verify_started',
  'post_verify_completed',
  'post_verify_failed',
  'apply_recovery_required',
]);

/** Audit types expected on a successful end-to-end path (failure alternatives are not required). */
export const SUCCESS_PATH_AUDIT_TYPES = Object.freeze([
  'state_initialized',
  'state_transition',
  'controller_started',
  'proposal_registered',
  'verify_started',
  'manual_checks_acknowledged',
  'verify_completed',
  'decision_accepted',
  'diff_approved',
  'apply_started',
  'post_verify_completed',
  'apply_completed',
]);

export function evaluateAuditCoverage(auditLog = [], requiredTypes = REQUIRED_REVIEW_AUDIT_TYPES) {
  if (!Array.isArray(auditLog) || auditLog.length === 0) {
    return { ok: false, reason: 'EMPTY_AUDIT_LOG', missing: requiredTypes.slice() };
  }
  const present = new Set(auditLog.map((event) => event.type).filter(Boolean));
  const missing = requiredTypes.filter((type) => !present.has(type));
  if (missing.length > 0) {
    return { ok: false, reason: 'AUDIT_COVERAGE_INCOMPLETE', missing };
  }
  return { ok: true, present: [...present] };
}

export function evaluateMonotonicStateRevision(events = []) {
  let lastRevision = -1;
  for (const event of events) {
    if (event.stateRevision == null) continue;
    if (!Number.isInteger(event.stateRevision) || event.stateRevision <= lastRevision) {
      return { ok: false, reason: 'STATE_REVISION_NOT_MONOTONIC', event };
    }
    lastRevision = event.stateRevision;
  }
  return { ok: true };
}

/** Failure-only audit types — acceptable alternatives on non-success paths. */
export const FAILURE_PATH_AUDIT_ALTERNATIVES = Object.freeze({
  verify_completed: ['verify_failed'],
  apply_completed: ['apply_failed', 'post_verify_failed'],
  post_verify_completed: ['post_verify_failed'],
  proposal_registered: ['proposal_failed', 'proposal_cannot_fix'],
});

/**
 * Validate success-path audit sequence: required types in order, monotonic revision,
 * chronological timestamps when present, and per-unit pairing for workflow events.
 */
export function evaluateSuccessPathAuditSequence(auditLog = [], requiredTypes = SUCCESS_PATH_AUDIT_TYPES) {
  if (!Array.isArray(auditLog) || auditLog.length === 0) {
    return { ok: false, reason: 'EMPTY_AUDIT_LOG' };
  }

  let lastIndex = -1;
  let lastAt = null;
  let lastRevision = -1;
  const present = new Set(auditLog.map((event) => event.type).filter(Boolean));

  for (const type of requiredTypes) {
    if (!present.has(type)) {
      const alternatives = FAILURE_PATH_AUDIT_ALTERNATIVES[type] || [];
      if (!alternatives.some((alt) => present.has(alt))) {
        return { ok: false, reason: 'SUCCESS_PATH_INCOMPLETE', missing: type };
      }
      continue;
    }
    const idx = auditLog.findIndex((event, index) => index > lastIndex && event.type === type);
    if (idx < 0) {
      return { ok: false, reason: 'SUCCESS_PATH_OUT_OF_ORDER', missing: type };
    }
    const event = auditLog[idx];
    if (event.at && lastAt && String(event.at) < String(lastAt)) {
      return { ok: false, reason: 'SUCCESS_PATH_NOT_CHRONOLOGICAL', type };
    }
    if (event.stateRevision != null) {
      if (!Number.isInteger(event.stateRevision) || event.stateRevision <= lastRevision) {
        return { ok: false, reason: 'SUCCESS_PATH_REVISION_REGRESSION', type, event };
      }
      lastRevision = event.stateRevision;
    }
    lastIndex = idx;
    if (event.at) lastAt = event.at;
  }

  const monotonic = evaluateMonotonicStateRevision(
    auditLog.filter((event) => event.stateRevision != null),
  );
  if (!monotonic.ok) return monotonic;

  const unitScoped = ['proposal_registered', 'verify_started', 'verify_completed', 'decision_accepted', 'diff_approved'];
  let pairedUnitId = null;
  for (const type of unitScoped) {
    const event = auditLog.find((row) => row.type === type);
    if (!event?.fixUnitId) continue;
    if (!pairedUnitId) {
      pairedUnitId = event.fixUnitId;
    } else if (event.fixUnitId !== pairedUnitId) {
      return { ok: false, reason: 'SUCCESS_PATH_UNIT_MISMATCH', type, expected: pairedUnitId, actual: event.fixUnitId };
    }
  }

  return { ok: true, fixUnitId: pairedUnitId };
}
