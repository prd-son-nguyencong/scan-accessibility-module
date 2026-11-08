import { createHash } from 'node:crypto';

const CHECK_ID_PATTERN = /^mc_[a-f0-9]{16}$/;

export function digestManualCheckLabel(candidateHash, label) {
  return createHash('sha256').update(`${candidateHash}|${String(label)}`).digest('hex');
}

export function buildManualCheckRecord(candidateHash, label, index) {
  const normalizedLabel = String(label).trim();
  const digest = digestManualCheckLabel(candidateHash, normalizedLabel);
  const checkId = `mc_${createHash('sha256').update(`${candidateHash}|${index}|${digest}`).digest('hex').slice(0, 16)}`;
  return Object.freeze({
    checkId,
    label: normalizedLabel,
    digest,
  });
}

export function buildManualCheckAttestations(candidateHash, manualChecks = []) {
  if (!candidateHash || typeof candidateHash !== 'string') {
    throw Object.assign(new Error('CANDIDATE_HASH_REQUIRED'), { code: 'CANDIDATE_HASH_REQUIRED' });
  }
  if (!Array.isArray(manualChecks)) {
    throw Object.assign(new Error('MANUAL_CHECKS_INVALID'), { code: 'MANUAL_CHECKS_INVALID' });
  }
  return manualChecks.map((label, index) => buildManualCheckRecord(candidateHash, label, index));
}

export function validateAcknowledgedManualCheckIds(attestations = [], acknowledgedIds = [], {
  candidateHash = null,
} = {}) {
  if (!Array.isArray(attestations) || attestations.length === 0) {
    return { ok: true, acknowledgedIds: [] };
  }
  if (!Array.isArray(acknowledgedIds)) {
    return { ok: false, reason: 'MANUAL_CHECKS_INVALID_PAYLOAD' };
  }
  if (acknowledgedIds.length !== attestations.length) {
    return { ok: false, reason: 'MANUAL_CHECKS_INCOMPLETE' };
  }

  const expected = new Set(attestations.map((item) => item.checkId));
  const provided = new Set();
  for (const id of acknowledgedIds) {
    if (typeof id !== 'string' || !CHECK_ID_PATTERN.test(id) || !expected.has(id)) {
      return { ok: false, reason: 'MANUAL_CHECKS_UNKNOWN_ID' };
    }
    if (provided.has(id)) {
      return { ok: false, reason: 'MANUAL_CHECKS_DUPLICATE_ID' };
    }
    provided.add(id);
  }

  if (candidateHash) {
    for (const attestation of attestations) {
      const recomputed = buildManualCheckRecord(candidateHash, attestation.label, attestations.indexOf(attestation));
      if (recomputed.checkId !== attestation.checkId || recomputed.digest !== attestation.digest) {
        return { ok: false, reason: 'MANUAL_CHECKS_STALE_CANDIDATE' };
      }
    }
  }

  return { ok: true, acknowledgedIds: [...acknowledgedIds] };
}

export { CHECK_ID_PATTERN };
