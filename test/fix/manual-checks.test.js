import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManualCheckAttestations,
  validateAcknowledgedManualCheckIds,
} from '../../src/fix/manual-checks.js';

test('manual check attestations require exact ID set', () => {
  const attestations = buildManualCheckAttestations('sha256:candidate', ['Check A', 'Check B']);
  assert.equal(validateAcknowledgedManualCheckIds(attestations, []).ok, false);
  assert.equal(validateAcknowledgedManualCheckIds(attestations, [attestations[0].checkId]).ok, false);
  assert.equal(validateAcknowledgedManualCheckIds(attestations, [attestations[0].checkId, 'mc_deadbeefdeadbeef']).ok, false);
  const pass = validateAcknowledgedManualCheckIds(attestations, attestations.map((item) => item.checkId), {
    candidateHash: 'sha256:candidate',
  });
  assert.equal(pass.ok, true);
});

test('stale candidate hash rejects acknowledgments', () => {
  const attestations = buildManualCheckAttestations('sha256:candidate-a', ['Check A']);
  const result = validateAcknowledgedManualCheckIds(attestations, [attestations[0].checkId], {
    candidateHash: 'sha256:candidate-b',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'MANUAL_CHECKS_STALE_CANDIDATE');
});
