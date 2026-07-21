import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewState, persistReviewState } from '../../src/fix/review/state.js';

function tempArtifacts(dir) {
  return readdirSync(dir).filter((name) => name.includes('.tmp') || name.includes('.rollback'));
}

test('persistReviewState writes mode 0600 session file without leaving temp artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-session-persist-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'persist');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const state = createReviewState({
    sessionDir,
    reportId: 'sha256:session-persist',
    sessionId: 'persist',
    fixUnits: [],
    traceResults: [],
    policyRoutes: [],
    localRoot: root,
  });
  try {
    persistReviewState(state);
    const sessionPath = join(sessionDir, 'session.json');
    assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
    assert.equal(tempArtifacts(sessionDir).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
