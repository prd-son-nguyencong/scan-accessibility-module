import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STATES,
  FixControllerError,
  createFixSession,
  transitionSession,
} from '../../src/fix/controller/session.js';

test('allowed plan transitions succeed in order', () => {
  let session = createFixSession({ reportId: 'sha256:report' });
  assert.equal(session.state, SESSION_STATES.SCANNED);

  session = transitionSession(session, SESSION_STATES.CANONICALIZED);
  session = transitionSession(session, SESSION_STATES.READY_FOR_POLICY);
  session = transitionSession(session, SESSION_STATES.CONTEXT_READY);
  session = transitionSession(session, SESSION_STATES.PROPOSED);
  session = transitionSession(session, SESSION_STATES.SHADOW_VERIFIED);
  session = transitionSession(session, SESSION_STATES.ACCEPTED);
  session = transitionSession(session, SESSION_STATES.DIFF_HASH_APPROVED);
  session = transitionSession(session, SESSION_STATES.APPLIED);
  session = transitionSession(session, SESSION_STATES.POST_VERIFIED);

  assert.equal(session.state, SESSION_STATES.POST_VERIFIED);
});

test('invalid transition throws typed FixControllerError', () => {
  const session = createFixSession({ reportId: 'sha256:report' });
  assert.throws(
    () => transitionSession(session, SESSION_STATES.PROPOSED),
    (error) => {
      assert.ok(error instanceof FixControllerError);
      assert.equal(error.code, 'INVALID_STATE_TRANSITION');
      assert.match(error.message, /SCANNED.*PROPOSED/);
      return true;
    },
  );
});

test('MANUAL_ONLY is terminal', () => {
  let session = createFixSession({ reportId: 'sha256:report' });
  session = transitionSession(session, SESSION_STATES.CANONICALIZED);
  session = transitionSession(session, SESSION_STATES.MANUAL_ONLY);
  assert.throws(
    () => transitionSession(session, SESSION_STATES.CONTEXT_READY),
    FixControllerError,
  );
});

test('createFixSession preserves an explicit resumable session id', () => {
  const session = createFixSession({
    reportId: 'sha256:report',
    sessionId: 'review-2026-07-16',
  });
  assert.equal(session.sessionId, 'review-2026-07-16');
});
