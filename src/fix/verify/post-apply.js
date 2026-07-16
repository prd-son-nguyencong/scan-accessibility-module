import { transitionSession, SESSION_STATES, appendAuditEvent } from '../controller/session.js';
import { compareVerificationFindings } from './verification-key.js';

/**
 * Post-apply session release gate (state transition only).
 * Per-apply scanning lives in runPostApplyTargetedVerification.
 */
export function evaluatePostApplyVerification(session, {
  targetFindingIds = [],
  afterFindings = [],
  baselineFindings = [],
  compareFindings = compareVerificationFindings,
}) {
  const delta = compareFindings(baselineFindings, afterFindings, targetFindingIds);
  if (!delta.targetsResolved || delta.newCriticalSerious.length > 0) {
    const failed = appendAuditEvent(session, {
      type: 'post_verify_failed',
      targetFindingIds,
      newCriticalSerious: delta.newCriticalSerious.map((item) => item.findingId || item.fingerprint),
    });
    return {
      ok: false,
      session: transitionSession(failed, SESSION_STATES.ROLLED_BACK),
      delta,
    };
  }

  const verified = appendAuditEvent(session, {
    type: 'post_verify_completed',
    targetFindingIds,
  });
  return {
    ok: true,
    session: transitionSession(verified, SESSION_STATES.POST_VERIFIED),
    delta,
  };
}
