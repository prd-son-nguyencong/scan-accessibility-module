import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalSha256, normalizeSelector } from '../../reporter/fingerprint.js';
import { assertPathContainedInRoot } from '../controller/local-attestation.js';

export class VerificationArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerificationArtifactError';
    this.code = code;
  }
}

export const ARTIFACT_ID_PATTERN = /^verification-\d+-[a-f0-9]{8}$/;
const MAX_ARTIFACT_BYTES = 128 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DIAGNOSTIC_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_DIAGNOSTIC_ID_LENGTH = 128;
const MAX_LAYER_LENGTH = 64;
const MAX_ROUTE_LENGTH = 512;
const MAX_SELECTOR_LENGTH = 512;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

function sanitizeDiagnosticToken(value, maxLength = MAX_DIAGNOSTIC_ID_LENGTH) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maxLength
    || CONTROL_CHARACTER_PATTERN.test(normalized)
    || !DIAGNOSTIC_TOKEN_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function sanitizeImpact(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return ['critical', 'serious', 'moderate', 'minor'].includes(normalized)
    ? normalized
    : 'unknown';
}

function sanitizeRoute(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) return null;
  const path = value.split(/[?#]/, 1)[0].trim();
  if (!path.startsWith('/') || path.length > MAX_ROUTE_LENGTH) return null;
  return path || '/';
}

function sanitizeSelector(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) return null;
  const normalized = normalizeSelector(value);
  if (!normalized || normalized.length > MAX_SELECTOR_LENGTH) return null;
  return normalized;
}

function sanitizeRegressionFinding(item = {}) {
  return {
    findingId: sanitizeDiagnosticToken(item.findingId || item.fingerprint),
    impact: sanitizeImpact(item.impact),
    canonicalRuleId: sanitizeDiagnosticToken(
      item.canonicalRuleId || item.ruleId,
    ),
    nativeRuleId: sanitizeDiagnosticToken(
      item.nativeRuleId || item.ruleId,
    ),
    layer: sanitizeDiagnosticToken(item.layer, MAX_LAYER_LENGTH),
    route: sanitizeRoute(item.route || item.pageRoute),
    selector: sanitizeSelector(
      item.selector || item.element?.selector,
    ),
  };
}

function sanitizeArtifact(artifact) {
  return {
    status: artifact.status,
    candidateHash: artifact.candidateHash,
    diffHash: artifact.diffHash,
    targetFindingIds: [...(artifact.targetFindingIds || [])].sort(),
    removedTargets: [...(artifact.removedTargets || [])].sort(),
    newCriticalSerious: (artifact.newCriticalSerious || []).map(
      sanitizeRegressionFinding,
    ),
    build: artifact.build ? { exitCode: artifact.build.exitCode } : null,
    format: artifact.format ? { exitCode: artifact.format.exitCode } : null,
    sourceTraceResolved: artifact.sourceTraceResolved === true,
    manualChecks: [...(artifact.manualChecks || [])],
    manualChecksAcknowledged: Boolean(artifact.manualChecksAcknowledged),
    environment: {
      shadow: true,
      localLighthouse: Boolean(artifact.environment?.localLighthouse),
      psiParity: false,
      provenance: artifact.environment?.provenance || 'local-shadow',
    },
    performance: artifact.performance ? {
      baseline: artifact.performance.baseline || null,
      after: artifact.performance.after || null,
    } : null,
  };
}

export function computeVerificationArtifactDigest(artifact) {
  return canonicalSha256(sanitizeArtifact(artifact));
}

function readBoundedJson(filePath, maxBytes) {
  const fd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new VerificationArtifactError('ARTIFACT_TOO_LARGE', 'Verification artifact exceeds size limit.');
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, null);
      if (read === 0) {
        throw new VerificationArtifactError('ARTIFACT_READ_INCOMPLETE', 'Verification artifact read was incomplete.');
      }
      offset += read;
    }
    return JSON.parse(buffer.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

export function persistVerificationArtifact(sessionDir, artifact) {
  const sanitized = sanitizeArtifact(artifact);
  const digest = computeVerificationArtifactDigest(sanitized);
  const payload = { ...sanitized, digest };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new VerificationArtifactError('ARTIFACT_TOO_LARGE', 'Verification artifact exceeds size limit.');
  }
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  const name = `verification-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
  if (!ARTIFACT_ID_PATTERN.test(name.slice(0, -5))) {
    throw new VerificationArtifactError('ARTIFACT_ID_INVALID', 'Verification artifact id is invalid.');
  }
  const targetPath = join(sessionDir, name);
  const tempPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tempPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
  try {
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, targetPath);
  chmodSync(targetPath, 0o600);
  return { artifactId: basename(name, '.json'), path: targetPath, artifact: payload };
}

export function readAndVerifyArtifact(sessionDir, artifactId, { candidateHash, diffHash }) {
  if (!ARTIFACT_ID_PATTERN.test(artifactId || '')) {
    throw new VerificationArtifactError('ARTIFACT_ID_INVALID', 'Verification artifact id is invalid.');
  }
  if (!SHA256_PATTERN.test(candidateHash || '') || !SHA256_PATTERN.test(diffHash || '')) {
    throw new VerificationArtifactError('HASH_MISMATCH', 'Candidate or diff hash is invalid.');
  }
  const contained = assertPathContainedInRoot(sessionDir, resolve(sessionDir, `${artifactId}.json`));
  if (!contained.ok) {
    throw new VerificationArtifactError('ARTIFACT_PATH_ESCAPE', 'Verification artifact path is not contained.');
  }
  const artifactPath = contained.resolvedPath;
  if (!existsSync(artifactPath)) {
    throw new VerificationArtifactError('ARTIFACT_NOT_FOUND', 'Verification artifact was not found.');
  }
  const parsed = readBoundedJson(artifactPath, MAX_ARTIFACT_BYTES);
  if (!parsed || typeof parsed !== 'object') {
    throw new VerificationArtifactError('ARTIFACT_CORRUPT', 'Verification artifact is corrupt.');
  }
  const expectedDigest = computeVerificationArtifactDigest(parsed);
  if (parsed.digest !== expectedDigest) {
    throw new VerificationArtifactError('ARTIFACT_DIGEST_MISMATCH', 'Verification artifact digest mismatch.');
  }
  if (parsed.status !== 'passed') {
    throw new VerificationArtifactError('ARTIFACT_NOT_PASSED', 'Verification artifact did not pass.');
  }
  if (parsed.candidateHash !== candidateHash || parsed.diffHash !== diffHash) {
    throw new VerificationArtifactError('ARTIFACT_HASH_BINDING_MISMATCH', 'Verification artifact hash binding mismatch.');
  }
  if (parsed.sourceTraceResolved !== true) {
    throw new VerificationArtifactError('SOURCE_TRACE_UNRESOLVED', 'Verification requires resolved source trace.');
  }
  if (parsed.environment?.psiParity === true) {
    throw new VerificationArtifactError('INVALID_PROVENANCE', 'Local verification cannot claim PSI parity.');
  }
  return parsed;
}

export function cleanupArtifactTemp(sessionDir) {
  try {
    for (const entry of readdirSync(sessionDir)) {
      if (entry.includes('.tmp')) {
        try {
          unlinkSync(join(sessionDir, entry));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}
