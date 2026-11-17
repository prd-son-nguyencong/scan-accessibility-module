import {
  buildValidatedCandidate,
  buildVerifiedCandidateRecord,
} from './helpers/candidate-fixture.js';

export function attachFixtureCandidate(unit, candidateRecord) {
  unit.candidate = structuredClone(candidateRecord);
  unit.candidateHash = candidateRecord.candidateHash;
  return unit;
}

export function attachVerifiedCandidate(unit, root, sessionDir, options = {}) {
  return attachFixtureCandidate(unit, buildVerifiedCandidateRecord(root, sessionDir, options));
}

export function withFixtureCandidates(fixUnits, root, sessionDir, { verified = false, reportId = 'sha256:fixture-report' } = {}) {
  const record = verified
    ? buildVerifiedCandidateRecord(root, sessionDir, { reportId })
    : buildValidatedCandidate(root, { reportId });
  return fixUnits.map((unit) => {
    const next = structuredClone(unit);
    if (unit.status === 'ready' && unit.kind === 'accessibility') {
      attachFixtureCandidate(next, structuredClone(record));
    }
    return next;
  });
}

export function registeredCandidateHash(state, fixUnitId) {
  const hash = state.raw?.candidates?.[fixUnitId]?.candidateHash;
  if (!hash) {
    throw new Error(`No registered candidate hash for ${fixUnitId}.`);
  }
  return hash;
}
