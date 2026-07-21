import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixSession } from '../../src/fix/controller/session.js';

test('createFixSession clones fixUnits and policyRoutes against caller mutation', () => {
  const fixUnits = [{ fixUnitId: 'u1', title: 'first' }];
  const policyRoutes = [{ fixUnitId: 'u1', proposalAllowed: true }];
  const session = createFixSession({
    reportId: 'sha256:report',
    fixUnits,
    policyRoutes,
  });

  fixUnits[0].title = 'mutated';
  policyRoutes[0].proposalAllowed = false;

  assert.equal(session.fixUnits[0].title, 'first');
  assert.equal(session.policyRoutes[0].proposalAllowed, true);
});
