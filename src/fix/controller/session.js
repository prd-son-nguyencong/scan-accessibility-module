export class FixControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FixControllerError';
    this.code = code;
  }
}

export const SESSION_STATES = Object.freeze({
  SCANNED: 'SCANNED',
  CANONICALIZED: 'CANONICALIZED',
  TRACE_REQUIRED: 'TRACE_REQUIRED',
  READY_FOR_POLICY: 'READY_FOR_POLICY',
  MANUAL_ONLY: 'MANUAL_ONLY',
  CONTEXT_READY: 'CONTEXT_READY',
  PROPOSED: 'PROPOSED',
  SHADOW_VERIFIED: 'SHADOW_VERIFIED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  DIFF_HASH_APPROVED: 'DIFF_HASH_APPROVED',
  APPLIED: 'APPLIED',
  POST_VERIFIED: 'POST_VERIFIED',
  ROLLED_BACK: 'ROLLED_BACK',
});

const TRANSITIONS = Object.freeze({
  [SESSION_STATES.SCANNED]: new Set([SESSION_STATES.CANONICALIZED]),
  [SESSION_STATES.CANONICALIZED]: new Set([
    SESSION_STATES.TRACE_REQUIRED,
    SESSION_STATES.READY_FOR_POLICY,
    SESSION_STATES.MANUAL_ONLY,
  ]),
  [SESSION_STATES.TRACE_REQUIRED]: new Set([SESSION_STATES.READY_FOR_POLICY]),
  [SESSION_STATES.READY_FOR_POLICY]: new Set([SESSION_STATES.CONTEXT_READY, SESSION_STATES.MANUAL_ONLY]),
  [SESSION_STATES.MANUAL_ONLY]: new Set([]),
  [SESSION_STATES.CONTEXT_READY]: new Set([SESSION_STATES.PROPOSED]),
  [SESSION_STATES.PROPOSED]: new Set([
    SESSION_STATES.SHADOW_VERIFIED,
    SESSION_STATES.VERIFICATION_FAILED,
    SESSION_STATES.REJECTED,
  ]),
  [SESSION_STATES.SHADOW_VERIFIED]: new Set([
    SESSION_STATES.ACCEPTED,
    SESSION_STATES.REJECTED,
  ]),
  [SESSION_STATES.VERIFICATION_FAILED]: new Set([SESSION_STATES.REJECTED]),
  [SESSION_STATES.ACCEPTED]: new Set([SESSION_STATES.DIFF_HASH_APPROVED, SESSION_STATES.REJECTED]),
  [SESSION_STATES.REJECTED]: new Set([]),
  [SESSION_STATES.DIFF_HASH_APPROVED]: new Set([SESSION_STATES.APPLIED]),
  [SESSION_STATES.APPLIED]: new Set([SESSION_STATES.POST_VERIFIED, SESSION_STATES.ROLLED_BACK]),
  [SESSION_STATES.POST_VERIFIED]: new Set([]),
  [SESSION_STATES.ROLLED_BACK]: new Set([]),
});

export function createFixSession({
  sessionId = null,
  reportId,
  capability,
  fixUnits = [],
  policyRoutes = [],
} = {}) {
  const session = {
    sessionId: sessionId || `fix-${Date.now()}`,
    reportId: reportId || null,
    capability: capability ? structuredClone(capability) : null,
    state: SESSION_STATES.SCANNED,
    fixUnits: structuredClone(fixUnits),
    policyRoutes: structuredClone(policyRoutes),
    auditLog: [],
    createdAt: new Date().toISOString(),
  };
  return appendAuditEvent(session, {
    type: 'state_initialized',
    state: session.state,
  });
}

export function transitionSession(session, nextState) {
  const allowed = TRANSITIONS[session.state];
  if (!allowed || !allowed.has(nextState)) {
    throw new FixControllerError(
      'INVALID_STATE_TRANSITION',
      `Cannot transition from ${session.state} to ${nextState}`,
    );
  }
  const updated = {
    ...session,
    state: nextState,
    updatedAt: new Date().toISOString(),
  };
  return appendAuditEvent(updated, {
    type: 'state_transition',
    from: session.state,
    to: nextState,
  });
}

export function appendAuditEvent(session, event) {
  const auditEvent = {
    ...event,
    at: new Date().toISOString(),
  };
  return {
    ...session,
    auditLog: [...(session.auditLog || []), auditEvent],
  };
}
