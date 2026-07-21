import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  readdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LOCK_NAME } from '../apply/lock.js';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { readBoundedFile, SecureIoError } from './secure-io.js';
import {
  loadManualMappingsFromTraceAudit,
  TraceAuditError,
  validateManualMappingRecord,
} from './trace-audit.js';
import {
  applyManualMapping,
  traceAllFindings,
} from '../trace/inbox.js';
import {
  buildMergeOverlay,
  clone,
  editorLinkForUnit,
  eligibleMergeTargets,
  materializeEffectiveUnits,
  mergedAwayUnitIds,
  rootCauseMatches,
  validateMergeOverlayRecord,
  validateMergeOverlaySequence,
} from './effective-units.js';
import { validateAndBuildCandidate } from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { readAndVerifyArtifact } from '../verify/artifact.js';
import {
  buildManualCheckAttestations,
  validateAcknowledgedManualCheckIds,
} from '../manual-checks.js';
import { getCandidateDiffView } from './diff-view.js';
import { validateRelativeCandidatePath } from '../candidate/path.js';

export class ReviewStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewStateError';
    this.code = code;
  }
}

const REVIEW_STATE_SCHEMA = '1.0.0';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_SESSION_JSON_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SEARCH_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;
const MAX_MANUAL_CHECKS = 8;
const MAX_RATIONALE_LENGTH = 2048;
const MAX_CANDIDATE_DIFF_BYTES = 64 * 1024;
const MAX_AUDIT_EVENTS = 5000;
const MAX_SOURCE_FILTER_LENGTH = 260;
const MAX_SEVERITY_FILTER_LENGTH = 32;
const VALID_DECISIONS = new Set(['pending', 'accepted', 'rejected']);
const VALID_STATUS_FILTERS = new Set(['all', 'pending', 'accepted', 'rejected', 'blocked', 'verified']);
const VALID_TABS = new Set(['source', 'list', 'review']);
const VALID_TRANSPORT_SECURITY = new Set(['trusted', 'insecure-dev', 'disabled']);
const TRANSACTION_ID_PATTERN = /^transaction-\d+-[a-f0-9]+$/;
const SANDBOX_ARTIFACT_ERROR_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ARTIFACT_PATH_LENGTH = 512;

function normalizeTransportSecurity(value) {
  const normalized = String(value ?? 'disabled').trim();
  return VALID_TRANSPORT_SECURITY.has(normalized) ? normalized : 'disabled';
}

function normalizeDevAuthBypass(value) {
  return value === true;
}

function defaultSandboxBlock() {
  return {
    enabled: false,
    targetFile: null,
    transactionId: null,
    artifactPaths: null,
    artifactError: null,
    rollbackCompleted: false,
    rollbackResult: null,
  };
}

function normalizeProcessSandboxContext(sandboxContext) {
  if (!sandboxContext || typeof sandboxContext !== 'object') {
    return defaultSandboxBlock();
  }
  if (sandboxContext.enabled !== true) {
    return defaultSandboxBlock();
  }
  const targetFile = validateRelativeCandidatePath(sandboxContext.targetFile);
  return {
    enabled: true,
    targetFile,
    transactionId: null,
    artifactPaths: null,
    artifactError: null,
    rollbackCompleted: false,
    rollbackResult: null,
  };
}

function validateRelativeArtifactPath(value) {
  const normalized = validateRelativeCandidatePath(value);
  if (normalized.length > MAX_ARTIFACT_PATH_LENGTH) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox artifact path exceeds allowed length.');
  }
  return normalized;
}

function validateSandboxArtifactPaths(artifactPaths) {
  if (artifactPaths == null) return null;
  if (typeof artifactPaths !== 'object' || Array.isArray(artifactPaths)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox artifact paths are invalid.');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(artifactPaths)) {
    if (typeof key !== 'string' || !key || key.length > 64) {
      throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox artifact path key is invalid.');
    }
    normalized[key] = validateRelativeArtifactPath(value);
  }
  return normalized;
}

function validateSandboxArtifactError(value) {
  if (value == null) return null;
  const code = String(value);
  if (!SANDBOX_ARTIFACT_ERROR_PATTERN.test(code)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox artifact error code is invalid.');
  }
  return code;
}

function validateSandboxTransactionId(value) {
  if (value == null) return null;
  const id = String(value);
  if (!TRANSACTION_ID_PATTERN.test(id)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox transaction ID is invalid.');
  }
  return id;
}

function validateSandboxRollbackResult(result) {
  if (result == null) return null;
  if (typeof result !== 'object' || Array.isArray(result)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox rollback result is invalid.');
  }
  if (typeof result.transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(result.transactionId)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox rollback result transaction ID is invalid.');
  }
  validateRelativeCandidatePath(result.targetFile);
  if (typeof result.sandboxRestored !== 'boolean' || typeof result.originalUnchangedAfterRollback !== 'boolean') {
    throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox rollback result verification flags are invalid.');
  }
  if (result.restored != null) {
    if (!Array.isArray(result.restored)) {
      throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox rollback restored files are invalid.');
    }
    for (const entry of result.restored) {
      if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') {
        throw new ReviewStateError('CORRUPT_SESSION', 'Sandbox rollback restored file entry is invalid.');
      }
      validateRelativeCandidatePath(entry.file);
    }
  }
  return {
    transactionId: result.transactionId,
    targetFile: validateRelativeCandidatePath(result.targetFile),
    restored: Array.isArray(result.restored)
      ? result.restored.map((entry) => ({ file: validateRelativeCandidatePath(entry.file) }))
      : [],
    sandboxRestored: result.sandboxRestored,
    originalUnchangedAfterRollback: result.originalUnchangedAfterRollback,
  };
}

function validatePersistedSandboxBlock(persistedSandbox, processSandbox) {
  if (persistedSandbox == null) {
    return processSandbox.enabled ? clone(processSandbox) : defaultSandboxBlock();
  }
  if (typeof persistedSandbox !== 'object' || Array.isArray(persistedSandbox)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted sandbox block is invalid.');
  }
  if (!processSandbox.enabled) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted sandbox block is not allowed without process sandbox context.');
  }
  if (persistedSandbox.enabled !== true) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted sandbox block must be enabled when present.');
  }
  let targetFile;
  try {
    targetFile = validateRelativeCandidatePath(persistedSandbox.targetFile);
  } catch {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted sandbox target is invalid.');
  }
  if (processSandbox.enabled && processSandbox.targetFile !== targetFile) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted sandbox target does not match process context.');
  }
  if (typeof persistedSandbox.rollbackCompleted !== 'boolean') {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted sandbox rollbackCompleted is invalid.');
  }
  return {
    enabled: true,
    targetFile,
    transactionId: validateSandboxTransactionId(persistedSandbox.transactionId),
    artifactPaths: validateSandboxArtifactPaths(persistedSandbox.artifactPaths),
    artifactError: validateSandboxArtifactError(persistedSandbox.artifactError),
    rollbackCompleted: persistedSandbox.rollbackCompleted,
    rollbackResult: validateSandboxRollbackResult(persistedSandbox.rollbackResult),
  };
}

function serializeSandboxBlock(raw) {
  if (!raw.sandbox?.enabled) return undefined;
  return {
    enabled: true,
    targetFile: raw.sandbox.targetFile,
    transactionId: raw.sandbox.transactionId,
    artifactPaths: raw.sandbox.artifactPaths ? clone(raw.sandbox.artifactPaths) : null,
    artifactError: raw.sandbox.artifactError,
    rollbackCompleted: raw.sandbox.rollbackCompleted === true,
    rollbackResult: raw.sandbox.rollbackResult ? clone(raw.sandbox.rollbackResult) : null,
  };
}

function extractTransactionIdFromApplyResult(result) {
  if (!result?.transactionDir) return null;
  const id = basename(String(result.transactionDir));
  return TRANSACTION_ID_PATTERN.test(id) ? id : null;
}

function captureSandboxApplyMetadata(raw, result) {
  if (!raw.sandbox?.enabled) return;
  raw.sandbox.transactionId = extractTransactionIdFromApplyResult(result);
  if (result?.artifacts && typeof result.artifacts === 'object') {
    raw.sandbox.artifactPaths = validateSandboxArtifactPaths(result.artifacts);
  }
  if (result?.artifactError != null) {
    raw.sandbox.artifactError = validateSandboxArtifactError(result.artifactError);
  }
}

function buildSandboxSnapshot(raw) {
  if (!raw.sandbox?.enabled) return null;
  const hasTransaction = TRANSACTION_ID_PATTERN.test(raw.sandbox.transactionId || '');
  return {
    enabled: true,
    targetFile: raw.sandbox.targetFile,
    transactionId: raw.sandbox.transactionId,
    artifactPaths: raw.sandbox.artifactPaths ? clone(raw.sandbox.artifactPaths) : null,
    artifactError: raw.sandbox.artifactError || null,
    rollbackAvailable: Boolean(
      raw.applyCompleted
      && hasTransaction
      && !raw.sandbox.rollbackCompleted
      && !raw.rollbackInFlight,
    ),
    rollbackInFlight: Boolean(raw.rollbackInFlight),
    rollbackCompleted: raw.sandbox.rollbackCompleted === true,
    rollbackResult: raw.sandbox.rollbackResult ? clone(raw.sandbox.rollbackResult) : null,
  };
}

function sanitizeRollbackHandlerResult(result) {
  if (!result || typeof result !== 'object') {
    throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback result is invalid.');
  }
  validateRelativeCandidatePath(result.targetFile);
  if (!TRANSACTION_ID_PATTERN.test(String(result.transactionId || ''))) {
    throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback transaction ID is invalid.');
  }
  if (result.sandboxRestored !== true || result.originalUnchangedAfterRollback !== true) {
    throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback verification failed.');
  }
  const restored = Array.isArray(result.restored)
    ? result.restored.map((entry) => ({ file: validateRelativeCandidatePath(entry.file) }))
    : [];
  if (restored.length === 0) {
    throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback did not restore any files.');
  }
  return {
    transactionId: result.transactionId,
    targetFile: result.targetFile,
    restored,
    sandboxRestored: true,
    originalUnchangedAfterRollback: true,
  };
}

function assertRollbackResultMatchesSandbox(raw, sanitized) {
  if (sanitized.transactionId !== raw.sandbox.transactionId) {
    throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback transaction ID does not match session.');
  }
  if (sanitized.targetFile !== raw.sandbox.targetFile) {
    throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback target file does not match session.');
  }
}

function validateFixUnits(fixUnits = []) {
  const unitIds = new Set();
  const findingOwners = new Map();

  for (const unit of fixUnits) {
    if (!unit?.fixUnitId || typeof unit.fixUnitId !== 'string') {
      throw new ReviewStateError('INVALID_FIX_UNIT', 'Each fix unit must include fixUnitId.');
    }
    if (unitIds.has(unit.fixUnitId)) {
      throw new ReviewStateError(
        'DUPLICATE_FIX_UNIT_ID',
        `Duplicate fixUnitId ${unit.fixUnitId} is not allowed.`,
      );
    }
    unitIds.add(unit.fixUnitId);

    for (const findingId of unit.findingIds || []) {
      if (findingOwners.has(findingId)) {
        throw new ReviewStateError(
          'DUPLICATE_FINDING_ID',
          `Finding ${findingId} belongs to more than one fix unit.`,
        );
      }
      findingOwners.set(findingId, unit.fixUnitId);
    }
  }
}

function defaultDecision() {
  return {
    decision: 'pending',
    candidateHash: null,
    rejectReason: null,
    revisionNote: null,
    updatedAt: null,
  };
}

function normalizePreferences(preferences = {}) {
  const prefs = preferences && typeof preferences === 'object' ? preferences : {};
  const activeTab = prefs.activeTab === 'queue' ? 'list' : prefs.activeTab;
  const search = typeof prefs.search === 'string' ? prefs.search.slice(0, MAX_SEARCH_LENGTH) : '';
  const statusFilter = VALID_STATUS_FILTERS.has(prefs.statusFilter) ? prefs.statusFilter : 'all';
  return {
    mode: prefs.mode === 'performance' ? 'performance' : 'accessibility',
    search,
    sourceFilter: typeof prefs.sourceFilter === 'string' ? prefs.sourceFilter.slice(0, MAX_SOURCE_FILTER_LENGTH) : 'all',
    statusFilter,
    severityFilter: typeof prefs.severityFilter === 'string' ? prefs.severityFilter.slice(0, MAX_SEVERITY_FILTER_LENGTH) : 'all',
    typeFilter: VALID_TYPE_FILTERS.has(prefs.typeFilter) ? prefs.typeFilter : 'all',
    selectedUnitId: typeof prefs.selectedUnitId === 'string' ? prefs.selectedUnitId : null,
    activeTab: VALID_TABS.has(activeTab) ? activeTab : 'list',
  };
}

const VALID_MODES = new Set(['accessibility', 'performance']);
const VALID_TYPE_FILTERS = new Set(['all', 'accessibility', 'performance']);

function validatePreferencesStrict(preferences) {
  if (!preferences || typeof preferences !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences must be an object.');
  }
  if (!VALID_MODES.has(preferences.mode)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.mode is invalid.');
  }
  if (typeof preferences.search !== 'string' || preferences.search.length > MAX_SEARCH_LENGTH) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.search is invalid.');
  }
  if (typeof preferences.sourceFilter !== 'string' || preferences.sourceFilter.length > MAX_SOURCE_FILTER_LENGTH) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.sourceFilter is invalid.');
  }
  if (!VALID_STATUS_FILTERS.has(preferences.statusFilter)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.statusFilter is invalid.');
  }
  if (typeof preferences.severityFilter !== 'string' || preferences.severityFilter.length > MAX_SEVERITY_FILTER_LENGTH) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.severityFilter is invalid.');
  }
  if (!VALID_TYPE_FILTERS.has(preferences.typeFilter)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.typeFilter is invalid.');
  }
  if (preferences.selectedUnitId != null && typeof preferences.selectedUnitId !== 'string') {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.selectedUnitId is invalid.');
  }
  const activeTab = preferences.activeTab === 'queue' ? 'list' : preferences.activeTab;
  if (!VALID_TABS.has(activeTab)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'preferences.activeTab is invalid.');
  }
  return normalizePreferences(preferences);
}

function loadTrustedAuditMappings(sessionDir, reportId, knownFindingIds) {
  try {
    return loadManualMappingsFromTraceAudit(sessionDir, { reportId, knownFindingIds });
  } catch (error) {
    if (error instanceof TraceAuditError) {
      throw new ReviewStateError(
        error.code === 'SYMLINK_TRACE_AUDIT' ? 'SYMLINK_TRACE_AUDIT' : 'CORRUPT_TRACE_AUDIT',
        'Trace audit replay failed validation.',
      );
    }
    throw error;
  }
}

function findingOwnerMap(baseFixUnits = []) {
  const owners = new Map();
  for (const unit of baseFixUnits) {
    for (const findingId of unit.findingIds || []) {
      owners.set(findingId, unit.fixUnitId);
    }
  }
  return owners;
}

function baseFindingById(baseFixUnits, findingId) {
  for (const unit of baseFixUnits) {
    const finding = (unit.findings || []).find((item) => item.findingId === findingId);
    if (finding) return { unit, finding };
  }
  return null;
}

function isAttestedFindingSource(finding) {
  const source = finding?.source || {};
  return Boolean(
    source.file
    && source.line
    && source.preimageSha256
    && source.method !== 'manual-mapping',
  );
}

function hasRegisteredCandidate(state, fixUnitId) {
  const candidate = state.candidates?.[fixUnitId];
  return Boolean(candidate?.candidateHash);
}

function canApplyManualMapping(raw, findingId) {
  const located = baseFindingById(raw.baseFixUnits, findingId);
  if (!located) {
    throw new ReviewStateError('UNKNOWN_FINDING', 'Finding was not found.');
  }
  const { unit, finding } = located;
  if (unit.kind !== 'accessibility') {
    throw new ReviewStateError('MAPPING_NOT_ALLOWED', 'Only accessibility findings can be manually mapped.');
  }
  if (mergedAwayUnitIds(raw).has(unit.fixUnitId)) {
    throw new ReviewStateError('MAPPING_NOT_ALLOWED', 'Merged units cannot be manually mapped.');
  }
  const decision = raw.decisions[unit.fixUnitId] || defaultDecision();
  if (decision.decision !== 'pending' || decision.revisionNote || decision.rejectReason) {
    throw new ReviewStateError('MAPPING_NOT_ALLOWED', 'Only pending units without decisions can be manually mapped.');
  }
  if (hasRegisteredCandidate(raw, unit.fixUnitId)) {
    throw new ReviewStateError('MAPPING_NOT_ALLOWED', 'Units with registered candidates cannot be manually mapped.');
  }
  if (isAttestedFindingSource(finding)) {
    throw new ReviewStateError('MAPPING_NOT_ALLOWED', 'Attested findings are display-only.');
  }
  const traceEntry = raw.traceResults.find((entry) => entry.findingId === findingId);
  if (!traceEntry?.unresolved) {
    throw new ReviewStateError('MAPPING_NOT_ALLOWED', 'Only unresolved findings can be manually mapped.');
  }
  return { unit, finding, traceEntry };
}

function sessionPathFor(sessionDir) {
  return join(sessionDir, 'session.json');
}

function assertNotSymlink(filePath, code = 'SYMLINK_SESSION_FILE') {
  if (!existsSync(filePath)) return;
  if (lstatSync(filePath).isSymbolicLink()) {
    throw new ReviewStateError(code, `${filePath} must not be a symlink.`);
  }
}

function assertSessionDirSafe(sessionDir) {
  if (!existsSync(sessionDir)) return;
  assertNotSymlink(sessionDir, 'SYMLINK_SESSION_DIR');
}

function cleanupTempFiles(sessionDir) {
  try {
    for (const entry of readdirSync(sessionDir)) {
      if (entry.startsWith('session.json.') && entry.endsWith('.tmp')) {
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

function fsyncSessionDirectory(sessionDir) {
  const fd = openSync(sessionDir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeSessionFile(sessionDir, payload) {
  assertSessionDirSafe(sessionDir);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  assertNotSymlink(sessionPathFor(sessionDir));

  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_JSON_BYTES) {
    throw new ReviewStateError('SESSION_TOO_LARGE', 'Review session state exceeds size limit.');
  }

  const targetPath = sessionPathFor(sessionDir);
  const tempPath = `${targetPath}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeSync(fd, serialized);
    fsyncSync(fd);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
  try {
    renameSync(tempPath, targetPath);
    chmodSync(targetPath, 0o600);
    fsyncSessionDirectory(sessionDir);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

function readSessionFile(sessionDir) {
  assertSessionDirSafe(sessionDir);
  const sessionPath = sessionPathFor(sessionDir);
  assertNotSymlink(sessionPath);
  let raw;
  try {
    raw = readBoundedFile(sessionPath, MAX_SESSION_JSON_BYTES);
  } catch (error) {
    if (error instanceof SecureIoError) {
      throw new ReviewStateError(
        error.code === 'SYMLINK_FILE' ? 'SYMLINK_SESSION_FILE' : 'CORRUPT_SESSION',
        'Unable to read review session.',
      );
    }
    throw error;
  }
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReviewStateError('CORRUPT_SESSION', 'Unable to parse session.json.');
  }
}

function serializeState(state) {
  const payload = {
    schemaVersion: REVIEW_STATE_SCHEMA,
    reportId: state.reportId,
    sessionId: state.sessionId,
    stateRevision: state.stateRevision,
    applyStarted: state.applyStarted,
    applyCompleted: state.applyCompleted,
    preferences: clone(state.preferences),
    decisions: clone(state.decisions),
    candidates: clone(state.candidates),
    diffApprovals: clone(state.diffApprovals),
    mergeOverlays: clone(state.mergeOverlays),
    manualMappings: clone(state.manualMappings),
    auditLog: clone(state.auditLog),
  };
  const sandbox = serializeSandboxBlock(state);
  if (sandbox) payload.sandbox = sandbox;
  return payload;
}

function backupMutableState(raw) {
  return {
    applyStarted: raw.applyStarted,
    applyCompleted: raw.applyCompleted,
    preferences: clone(raw.preferences),
    decisions: clone(raw.decisions),
    candidates: clone(raw.candidates),
    diffApprovals: clone(raw.diffApprovals),
    mergeOverlays: clone(raw.mergeOverlays),
    manualMappings: clone(raw.manualMappings),
    auditLog: clone(raw.auditLog),
    traceResults: clone(raw.traceResults),
    stateRevision: raw.stateRevision,
    sandbox: clone(raw.sandbox),
    rollbackInFlight: raw.rollbackInFlight,
    rollbackPromise: raw.rollbackPromise,
  };
}

function restoreMutableState(raw, backup) {
  Object.assign(raw, backup);
  restoreManualMappings(raw);
}

function validateRelativeMappingPath(file) {
  const normalized = normalizeSourcePath(file);
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Manual mapping path must be relative and contained.');
  }
  return normalized;
}

function validateDecisionRecord(record, fixUnitId, candidates = {}) {
  if (!record || typeof record !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid decision record for ${fixUnitId}.`);
  }
  if (!VALID_DECISIONS.has(record.decision)) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid decision value for ${fixUnitId}.`);
  }
  if (record.candidateHash != null && !SHA256_PATTERN.test(record.candidateHash)) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate hash for ${fixUnitId}.`);
  }
  if (record.rejectReason != null && typeof record.rejectReason !== 'string') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid reject reason for ${fixUnitId}.`);
  }
  if (record.revisionNote != null && typeof record.revisionNote !== 'string') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid revision note for ${fixUnitId}.`);
  }
  if (record.decision === 'accepted') {
    if (!SHA256_PATTERN.test(record.candidateHash || '')) {
      throw new ReviewStateError('CORRUPT_SESSION', `Accepted decision requires candidate hash for ${fixUnitId}.`);
    }
    const registered = candidates[fixUnitId];
    if (!registered?.candidateHash || registered.candidateHash !== record.candidateHash) {
      throw new ReviewStateError('CORRUPT_SESSION', `Accepted decision candidate hash mismatch for ${fixUnitId}.`);
    }
  }
}

function validateAuditEventRecord(event, index) {
  if (!event || typeof event !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid audit event at index ${index}.`);
  }
  if (typeof event.type !== 'string' || !event.type) {
    throw new ReviewStateError('CORRUPT_SESSION', `Audit event type is invalid at index ${index}.`);
  }
  if (typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) {
    throw new ReviewStateError('CORRUPT_SESSION', `Audit event timestamp is invalid at index ${index}.`);
  }
}

function validateDiffApprovalRecord(record, fixUnitId, candidate) {
  if (record == null) return;
  if (typeof record !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid diff approval for ${fixUnitId}.`);
  }
  if (!SHA256_PATTERN.test(record.candidateHash || '') || !SHA256_PATTERN.test(record.diffHash || '')) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid diff approval hashes for ${fixUnitId}.`);
  }
  if (candidate?.candidateHash && record.candidateHash !== candidate.candidateHash) {
    throw new ReviewStateError('CORRUPT_SESSION', `Diff approval candidate hash mismatch for ${fixUnitId}.`);
  }
  if (candidate?.diffHash && record.diffHash !== candidate.diffHash) {
    throw new ReviewStateError('CORRUPT_SESSION', `Diff approval diff hash mismatch for ${fixUnitId}.`);
  }
}

function validateCandidateRecord(record, fixUnitId, { persisted = false } = {}) {
  if (!record || typeof record !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate record for ${fixUnitId}.`);
  }
  if (!SHA256_PATTERN.test(record.candidateHash || '')) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate hash for ${fixUnitId}.`);
  }
  if (typeof record.verified !== 'boolean' || typeof record.conflictFree !== 'boolean') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate flags for ${fixUnitId}.`);
  }
  if (record.diffHash != null && !SHA256_PATTERN.test(record.diffHash)) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid diff hash for ${fixUnitId}.`);
  }
  if (record.editIntents != null && !Array.isArray(record.editIntents)) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid edit intents for ${fixUnitId}.`);
  }
  if (persisted && record.verified === true && !record.verification?.artifactId) {
    throw new ReviewStateError('CORRUPT_SESSION', `Verified candidate missing artifact binding for ${fixUnitId}.`);
  }
  if (persisted && (!Array.isArray(record.editIntents) || record.editIntents.length === 0)) {
    throw new ReviewStateError('CORRUPT_SESSION', `Missing edit intents for ${fixUnitId}.`);
  }
  if (record.diff != null) {
    if (typeof record.diff !== 'string') {
      throw new ReviewStateError('CORRUPT_SESSION', `Candidate diff must be a string for ${fixUnitId}.`);
    }
    const diffBytes = Buffer.byteLength(record.diff, 'utf8');
    if (diffBytes > MAX_CANDIDATE_DIFF_BYTES) {
      throw new ReviewStateError('CORRUPT_SESSION', `Candidate diff too large for ${fixUnitId}.`);
    }
  }
  if (record.verification != null) {
    if (typeof record.verification !== 'object' || typeof record.verification.status !== 'string') {
      throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate verification for ${fixUnitId}.`);
    }
  }
  if (record.rationale != null && (typeof record.rationale !== 'string' || record.rationale.length > MAX_RATIONALE_LENGTH)) {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate rationale for ${fixUnitId}.`);
  }
  if (record.manualChecks != null) {
    if (!Array.isArray(record.manualChecks) || record.manualChecks.length > MAX_MANUAL_CHECKS) {
      throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate manualChecks for ${fixUnitId}.`);
    }
  }
  if (record.cisTelemetry != null && typeof record.cisTelemetry !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', `Invalid candidate telemetry for ${fixUnitId}.`);
  }
  if (persisted && record.diff != null && typeof record.diff !== 'string') {
    throw new ReviewStateError('CORRUPT_SESSION', `Candidate diff type invalid for ${fixUnitId}.`);
  }
}

function validateManualMappingRecordPersisted(mapping, findingId, knownFindingIds) {
  try {
    validateManualMappingRecord(mapping, findingId, knownFindingIds, { requireComputed: true });
  } catch (error) {
    if (error instanceof TraceAuditError) {
      throw new ReviewStateError('CORRUPT_SESSION', error.message);
    }
    throw error;
  }
}

function validateMergeOverlayPersisted(overlay, baseUnitIds) {
  if (!overlay || typeof overlay !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'Invalid merge overlay.');
  }
  if (!baseUnitIds.has(overlay.sourceFixUnitId) || !baseUnitIds.has(overlay.targetFixUnitId)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Merge overlay references unknown fix unit.');
  }
  if (overlay.sourceFixUnitId === overlay.targetFixUnitId) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Merge overlay source and target must differ.');
  }
  if (!TRACE_SHA256_PATTERN.test(overlay.sharedPreimageSha256 || '')) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Merge overlay shared preimage is invalid.');
  }
  if (typeof overlay.canonicalRuleId !== 'string' || !overlay.canonicalRuleId) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Merge overlay canonicalRuleId is invalid.');
  }
  if (typeof overlay.pageState !== 'string' || overlay.kind !== 'accessibility') {
    throw new ReviewStateError('CORRUPT_SESSION', 'Merge overlay identity fields are invalid.');
  }
  if (!Array.isArray(overlay.sourceFindingIds) || !Array.isArray(overlay.targetFindingIds)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Merge overlay finding IDs must be arrays.');
  }
}

const TRACE_SHA256_PATTERN = SHA256_PATTERN;

function validatePersistedState(persisted, { reportId, sessionId, baseFixUnits, policyRoutes = [] }) {
  if (!persisted || typeof persisted !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'Persisted review state is not an object.');
  }
  if (persisted.schemaVersion !== REVIEW_STATE_SCHEMA) {
    throw new ReviewStateError('CORRUPT_SESSION', 'Unsupported review state schema version.');
  }
  if (persisted.reportId !== reportId) {
    throw new ReviewStateError('REPORT_MISMATCH', 'Persisted review state reportId mismatch.');
  }
  if (persisted.sessionId !== sessionId) {
    throw new ReviewStateError('SESSION_MISMATCH', 'Persisted review state sessionId mismatch.');
  }
  if (typeof persisted.applyStarted !== 'boolean') {
    throw new ReviewStateError('CORRUPT_SESSION', 'applyStarted must be boolean.');
  }
  if (persisted.applyCompleted != null && typeof persisted.applyCompleted !== 'boolean') {
    throw new ReviewStateError('CORRUPT_SESSION', 'applyCompleted must be boolean.');
  }
  if (!Number.isInteger(persisted.stateRevision) || persisted.stateRevision < 0) {
    throw new ReviewStateError('CORRUPT_SESSION', 'stateRevision must be a non-negative integer.');
  }
  validatePreferencesStrict(persisted.preferences);
  if (!persisted.decisions || typeof persisted.decisions !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'decisions must be an object.');
  }
  if (!Array.isArray(persisted.auditLog)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'auditLog must be an array.');
  }
  if (persisted.auditLog.length > MAX_AUDIT_EVENTS) {
    throw new ReviewStateError('CORRUPT_SESSION', 'auditLog exceeds allowed size.');
  }
  persisted.auditLog.forEach((event, index) => validateAuditEventRecord(event, index));
  if (persisted.candidates != null && typeof persisted.candidates !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'candidates must be an object.');
  }
  if (persisted.diffApprovals != null && typeof persisted.diffApprovals !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'diffApprovals must be an object.');
  }
  if (persisted.manualMappings != null && typeof persisted.manualMappings !== 'object') {
    throw new ReviewStateError('CORRUPT_SESSION', 'manualMappings must be an object.');
  }
  if (persisted.mergeOverlays != null && !Array.isArray(persisted.mergeOverlays)) {
    throw new ReviewStateError('CORRUPT_SESSION', 'mergeOverlays must be an array.');
  }
  if (persisted.sandbox != null) {
    validatePersistedSandboxBlock(persisted.sandbox, { enabled: true, targetFile: persisted.sandbox.targetFile });
  }

  const unitIds = new Set(baseFixUnits.map((unit) => unit.fixUnitId));
  const knownFindingIds = new Set(baseFixUnits.flatMap((unit) => unit.findingIds || []));

  const policyByUnit = new Map((policyRoutes || []).map((route) => [route.fixUnitId, route]));

  for (const fixUnitId of Object.keys(persisted.decisions)) {
    if (!unitIds.has(fixUnitId)) {
      throw new ReviewStateError('CORRUPT_SESSION', `Unknown decision fixUnitId ${fixUnitId}.`);
    }
    validateDecisionRecord(persisted.decisions[fixUnitId], fixUnitId, persisted.candidates || {});
  }
  for (const unit of baseFixUnits) {
    if (!persisted.decisions[unit.fixUnitId]) {
      throw new ReviewStateError('CORRUPT_SESSION', `Missing decision for ${unit.fixUnitId}.`);
    }
  }

  for (const [fixUnitId, candidate] of Object.entries(persisted.candidates || {})) {
    if (!unitIds.has(fixUnitId)) {
      throw new ReviewStateError('CORRUPT_SESSION', `Unknown candidate fixUnitId ${fixUnitId}.`);
    }
    validateCandidateRecord(candidate, fixUnitId, { persisted: true });
    const policyRoute = policyByUnit.get(fixUnitId);
    if (policyRoute && !policyRoute.proposalAllowed) {
      throw new ReviewStateError('CORRUPT_SESSION', `Candidate registered for policy-blocked unit ${fixUnitId}.`);
    }
  }

  for (const [fixUnitId, approval] of Object.entries(persisted.diffApprovals || {})) {
    if (!unitIds.has(fixUnitId)) {
      throw new ReviewStateError('CORRUPT_SESSION', `Unknown diff approval fixUnitId ${fixUnitId}.`);
    }
    validateDiffApprovalRecord(approval, fixUnitId, persisted.candidates?.[fixUnitId] || null);
  }

  for (const [findingId, mapping] of Object.entries(persisted.manualMappings || {})) {
    validateManualMappingRecordPersisted(mapping, findingId, knownFindingIds);
  }

  for (const overlay of persisted.mergeOverlays || []) {
    validateMergeOverlayPersisted(overlay, unitIds);
  }

  try {
    validateMergeOverlaySequence(
      baseFixUnits,
      persisted.manualMappings || {},
      persisted.mergeOverlays || [],
    );
  } catch (error) {
    throw new ReviewStateError('CORRUPT_SESSION', error.message || 'Merge overlay replay failed.');
  }
}

function appendAudit(state, event) {
  const auditEvent = {
    ...event,
    at: new Date().toISOString(),
  };
  state.auditLog.push(auditEvent);
  return auditEvent;
}

function bumpRevision(raw) {
  raw.stateRevision += 1;
}

function effectiveUnitsFor(raw) {
  return materializeEffectiveUnits(raw);
}

function activeUnits(raw) {
  const hidden = mergedAwayUnitIds(raw);
  return effectiveUnitsFor(raw).filter((unit) => !hidden.has(unit.fixUnitId));
}

function unitById(raw, fixUnitId) {
  return effectiveUnitsFor(raw).find((unit) => unit.fixUnitId === fixUnitId) || null;
}

function policyForUnit(state, fixUnitId) {
  return state.policyRoutes.find((route) => route.fixUnitId === fixUnitId) || null;
}

function registeredCandidate(state, fixUnitId) {
  return state.candidates?.[fixUnitId] || null;
}

function diffApprovalFor(state, fixUnitId) {
  return state.diffApprovals?.[fixUnitId] || null;
}

function verificationPassed(raw, candidate) {
  if (!candidate?.verified || !candidate?.verification?.artifactId) return false;
  if (candidate.verification.status !== 'passed' && candidate.verification.status !== 'shadow_verified') {
    return false;
  }
  try {
    readAndVerifyArtifact(raw.sessionDir, candidate.verification.artifactId, {
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
    });
    return true;
  } catch {
    return false;
  }
}

function revalidateCandidateRecord(raw, payload, { allowVerified = false } = {}) {
  if (!allowVerified && payload.verified === true) {
    throw new ReviewStateError('VERIFIED_REGISTRATION_NOT_ALLOWED', 'Use registerVerifiedCandidate for verified candidates.');
  }
  if (!payload.editIntents || !Array.isArray(payload.editIntents) || payload.editIntents.length === 0) {
    throw new ReviewStateError('INVALID_CANDIDATE', 'Candidate edit intents are required.');
  }
  if (!raw.localRoot) {
    throw new ReviewStateError('LOCAL_ROOT_MISSING', 'Local root is required to validate candidates.');
  }
  const built = validateAndBuildCandidate({
    localRoot: raw.localRoot,
    reportId: raw.reportId,
    policyVersion: payload.policyVersion || '1',
    promptVersion: payload.promptVersion || '',
    modelId: payload.modelId || '',
    edits: payload.editIntents,
  });
  const enriched = attachDiffToCandidate(built);
  if (payload.candidateHash && payload.candidateHash !== enriched.candidateHash) {
    throw new ReviewStateError('CANDIDATE_HASH_MISMATCH', 'Candidate hash does not match validated edit intents.');
  }
  if (payload.diffHash && payload.diffHash !== enriched.diffHash) {
    throw new ReviewStateError('DIFF_HASH_MISMATCH', 'Diff hash does not match validated edit intents.');
  }
  const manualChecks = Array.isArray(payload.manualChecks)
    ? payload.manualChecks.slice(0, MAX_MANUAL_CHECKS)
    : [];
  const manualCheckAttestations = buildManualCheckAttestations(
    enriched.candidateHash,
    manualChecks,
  );
  return {
    candidateHash: enriched.candidateHash,
    diffHash: enriched.diffHash,
    diff: enriched.diff,
    editIntents: enriched.edits,
    policyVersion: enriched.policyVersion,
    promptVersion: enriched.promptVersion,
    modelId: enriched.modelId,
    rationale: payload.rationale || null,
    manualChecks,
    manualCheckAttestations,
    manualChecksAcknowledgedIds: Array.isArray(payload.manualChecksAcknowledgedIds)
      ? payload.manualChecksAcknowledgedIds.slice(0, MAX_MANUAL_CHECKS)
      : [],
    cisTelemetry: payload.cisTelemetry || null,
    verified: allowVerified ? true : false,
    conflictFree: payload.conflictFree !== false,
    verification: allowVerified
      ? {
          status: 'passed',
          artifactId: payload.verification.artifactId,
        }
      : { status: 'pending' },
  };
}

function invalidateCandidateApprovals(raw, fixUnitId, reason) {
  delete raw.diffApprovals[fixUnitId];
  const decision = raw.decisions[fixUnitId];
  if (decision?.decision === 'accepted') {
    raw.decisions[fixUnitId] = {
      ...defaultDecision(),
      updatedAt: new Date().toISOString(),
    };
    appendAudit(raw, { type: 'decision_invalidated', fixUnitId, reason });
  }
  appendAudit(raw, { type: 'diff_approval_invalidated', fixUnitId, reason });
}

function canAcceptUnit(state, unit) {
  if (!unit || mergedAwayUnitIds(state).has(unit.fixUnitId)) return false;
  if (unit.status === 'trace-required') return false;
  const policyRoute = policyForUnit(state, unit.fixUnitId);
  if (policyRoute && !policyRoute.proposalAllowed) return false;
  const candidate = registeredCandidate(state, unit.fixUnitId);
  return Boolean(candidate?.candidateHash);
}

function unitReviewStatus(unit, decisionRecord, policyRoute) {
  if (decisionRecord.decision === 'accepted') return 'accepted';
  if (decisionRecord.decision === 'rejected') return 'rejected';
  if (decisionRecord.revisionNote) return 'pending';
  if (unit.status === 'trace-required') return 'blocked';
  if (policyRoute && !policyRoute.proposalAllowed) return 'blocked';
  return 'pending';
}

function severityForUnit(unit) {
  const impacts = (unit.findings || []).map((finding) => finding.impact).filter(Boolean);
  if (impacts.includes('critical')) return 'critical';
  if (impacts.includes('serious')) return 'serious';
  if (impacts.includes('moderate')) return 'moderate';
  if (impacts.includes('minor')) return 'minor';
  return 'unknown';
}

function evidenceSummary(unit) {
  const primary = unit.evidence?.[0] || unit.findings?.[0]?.evidence;
  if (primary?.message) return String(primary.message).slice(0, 140);
  const hint = unit.findings?.[0]?.fix?.hint;
  if (hint) return String(hint).slice(0, 140);
  return unit.canonicalRuleId || unit.title;
}

function snippetsForUnit(unit) {
  return (unit.findings || []).map((finding) => ({
    findingId: finding.findingId,
    file: finding.source?.file || null,
    line: finding.source?.line || null,
    snippet: finding.source?.snippet || null,
    confidence: finding.source?.confidence || 'none',
    method: finding.source?.method || 'unresolved',
    preimageSha256: finding.source?.preimageSha256 || null,
  }));
}

function diffForUnit(unit, candidate) {
  if (candidate?.diff) {
    return {
      kind: 'candidate',
      text: candidate.diff,
      view: getCandidateDiffView(candidate),
    };
  }
  const patches = (unit.findings || []).map((finding) => finding.fix?.patch).filter(Boolean);
  if (patches.length > 0) {
    return { kind: 'patch', text: JSON.stringify(patches, null, 2), view: null };
  }
  const hints = [...new Set((unit.findings || []).map((finding) => finding.fix?.hint).filter(Boolean))];
  if (hints.length > 0) {
    return { kind: 'hint', text: hints.join('\n'), view: null };
  }
  return {
    kind: 'none',
    text: candidate
      ? 'Candidate registered. Run shadow verification before accept and exact diff approval.'
      : 'No candidate diff yet. Proposal generation is pending.',
    view: null,
  };
}

function performanceMetric(unit) {
  const primary = unit.findings?.[0] || {};
  return primary.metric
    || primary.opportunity
    || primary.canonicalRuleId
    || primary.nativeRuleId
    || unit.title;
}

function ownerCandidatesForUnit(unit, traceResults, localRoot) {
  const traceByFinding = new Map(traceResults.map((entry) => [entry.findingId, entry]));
  const candidates = [];
  for (const findingId of unit.findingIds || []) {
    const trace = traceByFinding.get(findingId);
    for (const partial of trace?.partials || []) {
      candidates.push({
        findingId,
        file: partial.file,
        line: partial.line,
        confidence: partial.confidence,
        method: partial.method,
        preimageSha256: partial.preimageSha256,
        editorLink: partial.editorLink || editorLinkForUnit({ localRoot }, {
          sourceOwner: { file: partial.file, line: partial.line },
        }),
      });
    }
  }
  const owner = unit.sourceOwner;
  if (owner?.file) {
    candidates.push({
      findingId: unit.findingIds?.[0] || null,
      file: owner.file,
      line: owner.line,
      confidence: owner.confidence,
      method: owner.method,
      preimageSha256: owner.preimageSha256,
      editorLink: editorLinkForUnit({ localRoot }, { sourceOwner: owner }),
    });
  }
  const deduped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.file}|${candidate.line}|${candidate.findingId}`;
    deduped.set(key, candidate);
  }
  return [...deduped.values()];
}

function recomputeTraceResults(raw) {
  if (!raw.traceInbox) return clone(raw.traceResults);
  const findings = effectiveUnitsFor(raw).flatMap((unit) => unit.findings || []);
  return traceAllFindings(raw.traceInbox, findings);
}

function buildTraceInboxModel(state) {
  const effective = effectiveUnitsFor(state);
  const findingOwners = new Map();
  for (const unit of effective) {
    for (const findingId of unit.findingIds || []) {
      findingOwners.set(findingId, unit.fixUnitId);
    }
  }
  return state.traceResults
    .filter((entry) => entry.unresolved || (entry.partials || []).length > 0)
    .map((entry) => ({
      findingId: entry.findingId,
      route: entry.route,
      unresolved: entry.unresolved,
      partials: clone(entry.partials || []),
      fixUnitId: findingOwners.get(entry.findingId) || null,
      mergeTargets: findingOwners.get(entry.findingId)
        ? eligibleMergeTargets(state, findingOwners.get(entry.findingId))
        : [],
    }));
}

function buildAccessibilityModel(state) {
  const byFile = new Map();
  for (const unit of activeUnits(state)) {
    if (unit.kind !== 'accessibility') continue;
    const file = unit.sourceOwner?.file || '(unmapped)';
    if (!byFile.has(file)) byFile.set(file, []);
    const decisionRecord = state.decisions[unit.fixUnitId] || defaultDecision();
    const policyRoute = policyForUnit(state, unit.fixUnitId);
    const candidate = registeredCandidate(state, unit.fixUnitId);
    byFile.get(file).push({
      fixUnitId: unit.fixUnitId,
      title: unit.title,
      reviewStatus: unitReviewStatus(unit, decisionRecord, policyRoute),
      severity: severityForUnit(unit),
      evidenceSummary: evidenceSummary(unit),
      snippets: snippetsForUnit(unit),
      evidence: clone(unit.evidence || []),
      diff: diffForUnit(unit, candidate),
      decision: clone(decisionRecord),
      candidate: candidate ? clone(candidate) : null,
      mergeTargets: eligibleMergeTargets(state, unit.fixUnitId),
      trace: (unit.findingIds || []).flatMap((findingId) => {
        const trace = state.traceResults.find((entry) => entry.findingId === findingId);
        return trace ? [{
          findingId: trace.findingId,
          route: trace.route,
          unresolved: trace.unresolved,
          partials: clone(trace.partials || []),
        }] : [];
      }),
    });
  }
  return {
    traceInbox: buildTraceInboxModel(state),
    sources: [...byFile.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, units]) => ({
        file,
        units: units.sort((a, b) => a.title.localeCompare(b.title)),
      })),
  };
}

function buildPerformanceModel(state) {
  const metrics = new Map();
  for (const unit of activeUnits(state)) {
    if (unit.kind !== 'performance') continue;
    const metric = performanceMetric(unit);
    if (!metrics.has(metric)) metrics.set(metric, []);
    metrics.get(metric).push(unit);
  }

  return {
    metrics: [...metrics.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([metric, units]) => ({
        metric,
        opportunities: units.map((unit) => {
          const decisionRecord = state.decisions[unit.fixUnitId] || defaultDecision();
          const policyRoute = policyForUnit(state, unit.fixUnitId);
          const candidate = registeredCandidate(state, unit.fixUnitId);
          const primary = unit.findings?.[0] || {};
          const resources = [
            ...(primary.affectedResources || []),
            ...(primary.evidence?.affectedResources || []),
          ].filter(Boolean);
          return {
            fixUnitId: unit.fixUnitId,
            title: unit.title,
            routes: clone(unit.affectedRoutes || []),
            resources: [...new Set(resources.map(String))].sort(),
            ownerCandidates: ownerCandidatesForUnit(unit, state.traceResults, state.localRoot),
            plan: {
              files: [...new Set(
                ownerCandidatesForUnit(unit, state.traceResults, state.localRoot)
                  .map((entry) => entry.file)
                  .filter(Boolean),
              )].sort(),
              diff: diffForUnit(unit, candidate),
            },
            baseline: primary.evidence?.baseline || primary.evidence?.scores || null,
            after: primary.evidence?.after || null,
            reviewStatus: unitReviewStatus(unit, decisionRecord, policyRoute),
            severity: severityForUnit(unit),
            evidenceSummary: evidenceSummary(unit),
            decision: clone(decisionRecord),
            candidate: candidate ? clone(candidate) : null,
          };
        }),
      })),
  };
}

function buildUnitRows(state) {
  return activeUnits(state).map((unit) => {
    const decisionRecord = state.decisions[unit.fixUnitId] || defaultDecision();
    const policyRoute = policyForUnit(state, unit.fixUnitId);
    const candidate = registeredCandidate(state, unit.fixUnitId);
    const trace = (unit.findingIds || []).flatMap((findingId) => {
      const entry = state.traceResults.find((item) => item.findingId === findingId);
      return entry ? [{
        findingId: entry.findingId,
        route: entry.route,
        unresolved: entry.unresolved,
        partials: clone(entry.partials || []),
      }] : [];
    });
    const verified = Boolean(candidate?.verified && verificationPassed(state, candidate));
    const approval = diffApprovalFor(state, unit.fixUnitId);
    const diffApproved = Boolean(
      approval
      && candidate?.candidateHash
      && candidate?.diffHash
      && approval.candidateHash === candidate.candidateHash
      && approval.diffHash === candidate.diffHash,
    );
    const batchEligible = Boolean(
      verified
      && candidate?.conflictFree
      && decisionRecord.decision === 'pending'
      && canAcceptUnit(state, unit),
    );
    const ownerLink = editorLinkForUnit(state, unit);
    return {
      fixUnitId: unit.fixUnitId,
      kind: unit.kind,
      title: unit.title,
      canonicalRuleId: unit.canonicalRuleId,
      sourceFile: unit.sourceOwner?.file || null,
      reviewStatus: unitReviewStatus(unit, decisionRecord, policyRoute),
      severity: severityForUnit(unit),
      evidenceSummary: evidenceSummary(unit),
      decision: clone(decisionRecord),
      candidate: candidate ? clone({
        candidateHash: candidate.candidateHash,
        diffHash: candidate.diffHash || null,
        verified: candidate.verified,
        conflictFree: candidate.conflictFree,
        rationale: candidate.rationale || null,
        manualChecks: clone(candidate.manualChecks || []),
        manualCheckAttestations: clone(candidate.manualCheckAttestations || []),
        manualChecksAcknowledgedIds: clone(candidate.manualChecksAcknowledgedIds || []),
        cisTelemetry: candidate.cisTelemetry ? clone(candidate.cisTelemetry) : null,
        verification: clone(candidate.verification || null),
      }) : null,
      candidateHash: candidate?.candidateHash || null,
      diffHash: candidate?.diffHash || null,
      diffApproved,
      acceptAllowed: canAcceptUnit(state, unit),
      blockedReason: unit.status === 'trace-required'
        ? 'SOURCE_TRACE_REQUIRED'
        : (policyRoute && !policyRoute.proposalAllowed ? policyRoute.decision?.reasonCode || 'POLICY_BLOCKED' : null),
      trace,
      editorLink: ownerLink,
      editorLinks: ownerCandidatesForUnit(unit, state.traceResults, state.localRoot)
        .map((entry) => entry.editorLink)
        .filter(Boolean),
      verified,
      batchEligible,
      mergeTargets: eligibleMergeTargets(state, unit.fixUnitId),
    };
  });
}

function buildApplyGate(state) {
  const rows = buildUnitRows(state);
  const accepted = rows.filter((row) => row.reviewStatus === 'accepted');
  const rejected = rows.filter((row) => row.reviewStatus === 'rejected');
  const pending = rows.filter((row) => row.reviewStatus === 'pending');
  const blocked = rows.filter((row) => row.reviewStatus === 'blocked');
  const verified = rows.filter((row) => row.verified);
  const verifiedAccepted = accepted.filter((row) => row.verified);
  const batchEligible = rows.filter((row) => row.batchEligible).length;
  const diffApproved = accepted.filter((row) => row.diffApproved).length;

  let reason = 'READY';
  let blockedGate = false;
  if (state.applyCompleted) {
    reason = 'APPLY_COMPLETED';
    blockedGate = true;
  } else if (state.applyRecoveryRequired) {
    reason = 'APPLY_RECOVERY_REQUIRED';
    blockedGate = true;
  } else if (state.applyStarted || state.applyInFlight) {
    reason = 'APPLY_IN_PROGRESS';
    blockedGate = true;
  } else if (pending.length > 0) {
    reason = 'PENDING_DECISIONS';
    blockedGate = true;
  } else if (accepted.length === 0) {
    reason = 'NO_ACCEPTED_UNITS';
    blockedGate = true;
  } else if (verifiedAccepted.length < accepted.length) {
    reason = 'CANDIDATE_VERIFICATION_REQUIRED';
    blockedGate = true;
  } else if (diffApproved < accepted.length) {
    reason = 'DIFF_APPROVAL_REQUIRED';
    blockedGate = true;
  } else if (accepted.some((row) => !row.candidate?.conflictFree)) {
    reason = 'PATCH_CONFLICT';
    blockedGate = true;
  }

  const activeCount = rows.length - blocked.length;
  const dispositioned = accepted.length + rejected.length;
  if (!blockedGate && dispositioned < activeCount) {
    reason = 'PENDING_DECISIONS';
    blockedGate = true;
  }

  return {
    blocked: blockedGate,
    reason,
    pendingCount: pending.length,
    blockedCount: blocked.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    verifiedCount: verified.length,
    diffApprovedCount: diffApproved,
    batchEligibleCount: batchEligible,
    message: blockedGate
      ? `Apply blocked: ${reason}.`
      : 'Apply is enabled for verified, accepted, diff-approved candidates.',
  };
}

function trimDiffViews(snapshot) {
  if (!snapshot?.accessibility?.sources) return;
  for (const group of snapshot.accessibility.sources) {
    for (const unit of group.units || []) {
      if (unit.diff?.view) {
        unit.diff = {
          ...unit.diff,
          view: null,
          viewTrimmed: true,
        };
      }
    }
  }
  if (snapshot.performance?.metrics) {
    for (const metric of snapshot.performance.metrics) {
      for (const opportunity of metric.opportunities || []) {
        if (opportunity.plan?.diff?.view) {
          opportunity.plan.diff = {
            ...opportunity.plan.diff,
            view: null,
            viewTrimmed: true,
          };
        }
      }
    }
  }
}

function trimDiffText(snapshot) {
  if (snapshot?.accessibility?.sources) {
    for (const group of snapshot.accessibility.sources) {
      for (const unit of group.units || []) {
        if (unit.diff?.text && unit.diff.kind === 'candidate') {
          unit.diff = {
            kind: unit.diff.kind,
            text: String(unit.diff.text).slice(0, 4096) + (unit.diff.text.length > 4096 ? '\n… [diff truncated]' : ''),
            view: unit.diff.view?.ok === false
              ? unit.diff.view
              : null,
            viewTrimmed: unit.diff.viewTrimmed || null,
          };
        }
      }
    }
  }
  if (snapshot?.performance?.metrics) {
    for (const metric of snapshot.performance.metrics) {
      for (const opportunity of metric.opportunities || []) {
        const diff = opportunity.plan?.diff;
        if (diff?.text && diff.kind === 'candidate') {
          opportunity.plan.diff = {
            kind: diff.kind,
            text: String(diff.text).slice(0, 4096) + (diff.text.length > 4096 ? '\n… [diff truncated]' : ''),
            view: diff.view?.ok === false ? diff.view : null,
            viewTrimmed: diff.viewTrimmed || null,
          };
        }
      }
    }
  }
}

function trimSnapshotPayload(snapshot) {
  const measure = (payload) => Buffer.byteLength(JSON.stringify(payload), 'utf8');

  let payload = clone(snapshot);
  if (measure(payload) <= MAX_SNAPSHOT_BYTES) {
    return payload;
  }

  payload = clone(snapshot);
  for (const unit of payload.units || []) {
    unit.trace = (unit.trace || []).map((entry) => ({
      findingId: entry.findingId,
      route: entry.route,
      unresolved: entry.unresolved,
      partials: (entry.partials || []).map((partial) => ({
        file: partial.file,
        line: partial.line,
        confidence: partial.confidence,
        method: partial.method,
        preimageSha256: partial.preimageSha256,
      })),
    }));
    delete unit.editorLinks;
  }
  if (measure(payload) <= MAX_SNAPSHOT_BYTES) {
    return payload;
  }

  payload = clone(snapshot);
  trimDiffViews(payload);
  if (measure(payload) <= MAX_SNAPSHOT_BYTES) {
    return payload;
  }

  payload = clone(snapshot);
  trimDiffViews(payload);
  trimDiffText(payload);
  if (measure(payload) <= MAX_SNAPSHOT_BYTES) {
    payload.snapshotDiffTrimmed = true;
    return payload;
  }

  payload = clone(snapshot);
  payload.units = (payload.units || []).map((unit) => ({
    fixUnitId: unit.fixUnitId,
    kind: unit.kind,
    title: String(unit.title || '').slice(0, 140),
    reviewStatus: unit.reviewStatus,
    severity: unit.severity,
    sourceFile: unit.sourceFile,
    candidateHash: unit.candidateHash,
    acceptAllowed: unit.acceptAllowed,
    verified: unit.verified,
    batchEligible: unit.batchEligible,
    evidenceSummary: String(unit.evidenceSummary || '').slice(0, 140),
  }));
  payload.accessibility = {
    traceInbox: (payload.accessibility?.traceInbox || []).map((entry) => ({
      findingId: entry.findingId,
      route: entry.route,
      unresolved: entry.unresolved,
      fixUnitId: entry.fixUnitId,
      partials: [],
      mergeTargets: [],
    })),
    sources: [],
  };
  payload.performance = { metrics: [] };
  payload.truncated = true;
  payload.paginationRequired = true;
  payload.unitCount = snapshot.units?.length || 0;
  payload.message = 'Snapshot truncated due to size limits. Narrow filters or reload individual units.';
  if (measure(payload) <= MAX_SNAPSHOT_BYTES) {
    return payload;
  }

  throw new ReviewStateError('SNAPSHOT_TOO_LARGE', 'Review snapshot exceeds size limit.');
}

function hydrateCandidates(state, fixUnits) {
  state.candidates = state.candidates || {};
  for (const unit of fixUnits) {
    if (unit.candidate?.candidateHash) {
      state.candidates[unit.fixUnitId] = clone(unit.candidate);
    }
  }
}

function restoreManualMappings(raw) {
  if (!raw.traceInbox) return;
  raw.traceInbox.manualMappings = new Map(
    Object.entries(raw.manualMappings || {}).map(([findingId, mapping]) => [findingId, mapping]),
  );
}

function commitMutation(api, mutateFn) {
  const backup = backupMutableState(api.raw);
  mutateFn();
  bumpRevision(api.raw);
  try {
    persistReviewState(api);
  } catch (error) {
    restoreMutableState(api.raw, backup);
    cleanupTempFiles(api.raw.sessionDir);
    throw error;
  }
}

function collectVerificationBaselineFindings(fixUnits = []) {
  const findings = [];
  const seenFindingIds = new Set();
  for (const unit of fixUnits) {
    for (const finding of unit.findings || []) {
      const findingId = finding.findingId || finding.fingerprint || null;
      if (findingId && seenFindingIds.has(findingId)) continue;
      if (findingId) seenFindingIds.add(findingId);
      findings.push(finding);
    }
  }
  return findings;
}

function cloneAndFreeze(value) {
  const cloned = clone(value);
  const seen = new WeakSet();

  function freezeDeep(current) {
    if (!current || typeof current !== 'object' || seen.has(current)) return current;
    seen.add(current);
    for (const child of Object.values(current)) freezeDeep(child);
    return Object.freeze(current);
  }

  return freezeDeep(cloned);
}

export function createReviewState({
  sessionDir,
  reportId,
  sessionId,
  fixUnits = [],
  traceResults = [],
  policyRoutes = [],
  traceInbox = null,
  localRoot = null,
  preferences = null,
  persisted = null,
  controllerAudit = [],
  transportSecurity = 'disabled',
  devAuthBypass = false,
  sandboxContext = null,
  verificationBaselineFindings = undefined,
} = {}) {
  validateFixUnits(fixUnits);
  assertSessionDirSafe(sessionDir);

  const knownFindingIds = new Set(fixUnits.flatMap((unit) => unit.findingIds || []));
  const auditMappings = loadTrustedAuditMappings(sessionDir, reportId, knownFindingIds);

  const state = {
    sessionDir,
    reportId,
    sessionId,
    localRoot,
    traceInbox,
    baseFixUnits: clone(fixUnits),
    verificationBaselineFindings: cloneAndFreeze(
      Array.isArray(verificationBaselineFindings)
        ? verificationBaselineFindings
        : collectVerificationBaselineFindings(fixUnits),
    ),
    traceResults: clone(traceResults),
    policyRoutes: clone(policyRoutes),
    stateRevision: 0,
    applyStarted: false,
    applyCompleted: false,
    applyRecoveryRequired: false,
    applyInFlight: false,
    preferences: normalizePreferences(preferences),
    decisions: {},
    candidates: {},
    diffApprovals: {},
    mergeOverlays: [],
    manualMappings: { ...auditMappings },
    auditLog: clone(controllerAudit),
    transportSecurity: normalizeTransportSecurity(transportSecurity),
    devAuthBypass: normalizeDevAuthBypass(devAuthBypass),
    sandbox: normalizeProcessSandboxContext(sandboxContext),
    rollbackInFlight: false,
    rollbackPromise: null,
  };

  hydrateCandidates(state, state.baseFixUnits);

  for (const unit of state.baseFixUnits) {
    state.decisions[unit.fixUnitId] = defaultDecision();
  }

  if (persisted) {
    validatePersistedState(persisted, {
      reportId,
      sessionId,
      baseFixUnits: state.baseFixUnits,
      policyRoutes: state.policyRoutes,
    });
    for (const [findingId, mapping] of Object.entries(auditMappings)) {
      validateManualMappingRecordPersisted(mapping, findingId, knownFindingIds);
    }
    for (const [findingId, mapping] of Object.entries(persisted.manualMappings || {})) {
      validateManualMappingRecordPersisted(mapping, findingId, knownFindingIds);
    }
    state.stateRevision = persisted.stateRevision;
    state.applyStarted = persisted.applyStarted;
    state.applyCompleted = persisted.applyCompleted === true;
    state.applyRecoveryRequired = persisted.applyRecoveryRequired === true;
    state.preferences = validatePreferencesStrict(persisted.preferences);
    state.auditLog = clone(persisted.auditLog);
    if (state.applyStarted && !state.applyCompleted) {
      state.applyRecoveryRequired = true;
      state.auditLog.push({
        type: 'apply_recovery_required',
        at: new Date().toISOString(),
        reason: 'Recovered stale in-progress apply after restart.',
      });
      if (localRoot) {
        const lockPath = join(localRoot, LOCK_NAME);
        if (existsSync(lockPath)) {
          state.auditLog.push({
            type: 'apply_recovery_lock_present',
            at: new Date().toISOString(),
            lockPath: LOCK_NAME,
          });
        }
        try {
          const txDirs = readdirSync(sessionDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('transaction-'))
            .map((entry) => entry.name)
            .sort();
          const latestTx = txDirs.at(-1);
          if (latestTx && existsSync(join(sessionDir, latestTx, 'journal.ndjson'))) {
            state.auditLog.push({
              type: 'apply_recovery_journal_present',
              at: new Date().toISOString(),
              transactionDir: latestTx,
            });
          }
        } catch {
          // ignore unreadable session dir during recovery probe
        }
      }
    }
    state.candidates = clone(persisted.candidates || {});
    state.diffApprovals = clone(persisted.diffApprovals || {});
    state.mergeOverlays = clone(persisted.mergeOverlays || []);
    state.manualMappings = { ...auditMappings, ...clone(persisted.manualMappings || {}) };
    state.sandbox = validatePersistedSandboxBlock(persisted.sandbox, state.sandbox);
    for (const unit of state.baseFixUnits) {
      const saved = persisted.decisions[unit.fixUnitId];
      state.decisions[unit.fixUnitId] = {
        decision: saved.decision,
        candidateHash: saved.candidateHash || null,
        rejectReason: saved.rejectReason || null,
        revisionNote: saved.revisionNote || null,
        updatedAt: saved.updatedAt || null,
      };
    }
    if (localRoot) {
      for (const [fixUnitId, candidate] of Object.entries(state.candidates || {})) {
        try {
          const allowVerified = candidate.verified === true;
          const revalidated = revalidateCandidateRecord(state, candidate, { allowVerified });
          if (allowVerified) {
            readAndVerifyArtifact(state.sessionDir, revalidated.verification.artifactId, {
              candidateHash: revalidated.candidateHash,
              diffHash: revalidated.diffHash,
            });
          }
          state.candidates[fixUnitId] = revalidated;
        } catch (error) {
          if (error instanceof ReviewStateError) throw error;
          throw new ReviewStateError('CORRUPT_SESSION', `Candidate revalidation failed for ${fixUnitId}.`);
        }
      }
    }
  }

  restoreManualMappings(state);
  state.traceResults = recomputeTraceResults(state);
  return wrapReviewState(state);
}

export function loadReviewState(options) {
  assertSessionDirSafe(options.sessionDir);
  const persisted = readSessionFile(options.sessionDir);
  if (!persisted) {
    return createReviewState(options);
  }
  return createReviewState({ ...options, persisted });
}

export function persistReviewState(state) {
  try {
    writeSessionFile(state.sessionDir, serializeState(state.raw));
  } catch (error) {
    throw new ReviewStateError('PERSIST_FAILED', error.message || 'Unable to persist review session.');
  }
}

function wrapReviewState(raw) {
  const api = {
    get raw() { return raw; },
    get sessionDir() { return raw.sessionDir; },
    get reportId() { return raw.reportId; },
    get sessionId() { return raw.sessionId; },
    get fixUnits() { return effectiveUnitsFor(raw); },
    get baseFixUnits() { return raw.baseFixUnits; },
    get traceResults() { return raw.traceResults; },
    get policyRoutes() { return raw.policyRoutes; },
    get auditLog() { return raw.auditLog; },
    get stateRevision() { return raw.stateRevision; },

    getDecision(fixUnitId) {
      return clone(raw.decisions[fixUnitId] || defaultDecision());
    },

    getCandidate(fixUnitId) {
      const candidate = registeredCandidate(raw, fixUnitId);
      return candidate ? clone(candidate) : null;
    },

    recordAuditEvent(event) {
      commitMutation(api, () => {
        appendAudit(raw, event);
      });
      return clone(raw.auditLog[raw.auditLog.length - 1]);
    },

    setPreferences(nextPreferences = {}) {
      commitMutation(api, () => {
        raw.preferences = normalizePreferences({ ...raw.preferences, ...nextPreferences });
      });
      return clone(raw.preferences);
    },

    registerCandidate(fixUnitId, candidate, { replace = false } = {}) {
      if (!raw.decisions[fixUnitId]) {
        throw new ReviewStateError('UNKNOWN_FIX_UNIT', `Unknown fix unit ${fixUnitId}.`);
      }
      if (mergedAwayUnitIds(raw).has(fixUnitId)) {
        throw new ReviewStateError('MERGED_UNIT', 'Merged fix units cannot register candidates.');
      }
      const unit = unitById(raw, fixUnitId);
      if (!unit || unit.status === 'trace-required') {
        throw new ReviewStateError('ACCEPT_NOT_ALLOWED', 'Blocked units cannot register candidates.');
      }
      const policyRoute = policyForUnit(raw, fixUnitId);
      if (policyRoute && !policyRoute.proposalAllowed) {
        throw new ReviewStateError('POLICY_BLOCKED', 'Policy blocks candidate registration for this unit.');
      }
      const validated = revalidateCandidateRecord(raw, candidate, { allowVerified: false });
      validateCandidateRecord(validated, fixUnitId, { persisted: true });
      const stored = {
        ...validated,
        rationale: typeof candidate.rationale === 'string' ? candidate.rationale.slice(0, MAX_RATIONALE_LENGTH) : null,
        manualChecks: Array.isArray(candidate.manualChecks) ? candidate.manualChecks.slice(0, MAX_MANUAL_CHECKS) : [],
        manualCheckAttestations: buildManualCheckAttestations(
          validated.candidateHash,
          Array.isArray(candidate.manualChecks) ? candidate.manualChecks.slice(0, MAX_MANUAL_CHECKS) : [],
        ),
        manualChecksAcknowledgedIds: [],
        cisTelemetry: candidate.cisTelemetry && typeof candidate.cisTelemetry === 'object'
          ? clone(candidate.cisTelemetry)
          : null,
      };
      const existing = raw.candidates[fixUnitId];
      if (existing?.candidateHash) {
        if (existing.candidateHash === stored.candidateHash) {
          return clone(existing);
        }
        if (!replace) {
          throw new ReviewStateError('CANDIDATE_ALREADY_REGISTERED', 'Candidate replacement requires explicit replace flag.');
        }
        commitMutation(api, () => {
          raw.candidates[fixUnitId] = clone(stored);
          invalidateCandidateApprovals(raw, fixUnitId, 'candidate_replaced');
          appendAudit(raw, {
            type: 'candidate_replaced',
            fixUnitId,
            previousHash: existing.candidateHash,
            candidateHash: stored.candidateHash,
          });
        });
        return clone(raw.candidates[fixUnitId]);
      }
      commitMutation(api, () => {
        raw.candidates[fixUnitId] = clone(stored);
        appendAudit(raw, { type: 'candidate_registered', fixUnitId, candidateHash: stored.candidateHash });
      });
      return clone(raw.candidates[fixUnitId]);
    },

    registerVerifiedCandidate(fixUnitId, candidate, { replace = false, acknowledgedCheckIds = [] } = {}) {
      if (!raw.decisions[fixUnitId]) {
        throw new ReviewStateError('UNKNOWN_FIX_UNIT', `Unknown fix unit ${fixUnitId}.`);
      }
      if (!candidate?.verification?.artifactId) {
        throw new ReviewStateError('VERIFICATION_REQUIRED', 'Verified registration requires a verification artifact id.');
      }
      const existingCandidate = raw.candidates[fixUnitId];
      const attestations = existingCandidate?.manualCheckAttestations
        || buildManualCheckAttestations(candidate.candidateHash, candidate.manualChecks || []);
      if (attestations.length > 0) {
        const ack = validateAcknowledgedManualCheckIds(attestations, acknowledgedCheckIds, {
          candidateHash: candidate.candidateHash,
        });
        if (!ack.ok) {
          throw new ReviewStateError(ack.reason, 'All manual checks must be acknowledged with current check IDs.');
        }
      }
      const validated = revalidateCandidateRecord(raw, candidate, { allowVerified: true });
      readAndVerifyArtifact(raw.sessionDir, validated.verification.artifactId, {
        candidateHash: validated.candidateHash,
        diffHash: validated.diffHash,
      });
      validateCandidateRecord(validated, fixUnitId, { persisted: true });
      const existing = raw.candidates[fixUnitId];
      if (existing?.candidateHash && existing.candidateHash !== validated.candidateHash && !replace) {
        throw new ReviewStateError('CANDIDATE_ALREADY_REGISTERED', 'Candidate replacement requires explicit replace flag.');
      }
      commitMutation(api, () => {
        if (existing?.candidateHash && existing.candidateHash !== validated.candidateHash) {
          invalidateCandidateApprovals(raw, fixUnitId, 'candidate_replaced');
        }
        raw.candidates[fixUnitId] = {
          ...clone(validated),
          manualCheckAttestations: attestations,
          manualChecksAcknowledgedIds: acknowledgedCheckIds.slice(),
        };
        appendAudit(raw, {
          type: 'manual_checks_acknowledged',
          fixUnitId,
          candidateHash: validated.candidateHash,
          acknowledgedCheckIds: acknowledgedCheckIds.slice(),
        });
        appendAudit(raw, {
          type: 'candidate_verified_registered',
          fixUnitId,
          candidateHash: validated.candidateHash,
          artifactId: validated.verification.artifactId,
        });
      });
      return clone(raw.candidates[fixUnitId]);
    },

    approveExactDiff(fixUnitId, candidateHash, diffHash) {
      if (!raw.decisions[fixUnitId]) {
        throw new ReviewStateError('UNKNOWN_FIX_UNIT', `Unknown fix unit ${fixUnitId}.`);
      }
      const candidate = registeredCandidate(raw, fixUnitId);
      if (!candidate?.candidateHash || candidate.candidateHash !== candidateHash) {
        throw new ReviewStateError('CANDIDATE_HASH_MISMATCH', 'Candidate hash does not match registered value.');
      }
      if (!candidate?.diffHash || candidate.diffHash !== diffHash) {
        throw new ReviewStateError('DIFF_HASH_MISMATCH', 'Diff hash does not match registered value.');
      }
      if (!verificationPassed(raw, candidate)) {
        throw new ReviewStateError('VERIFICATION_REQUIRED', 'Exact diff approval requires successful verification.');
      }
      readAndVerifyArtifact(raw.sessionDir, candidate.verification.artifactId, {
        candidateHash,
        diffHash,
      });
      const decision = raw.decisions[fixUnitId];
      if (decision.decision !== 'accepted' || decision.candidateHash !== candidateHash) {
        throw new ReviewStateError('ACCEPT_REQUIRED', 'Exact diff approval requires an accepted decision.');
      }
      const existing = diffApprovalFor(raw, fixUnitId);
      if (
        existing
        && existing.candidateHash === candidateHash
        && existing.diffHash === diffHash
      ) {
        return clone(existing);
      }
      commitMutation(api, () => {
        raw.diffApprovals[fixUnitId] = {
          candidateHash,
          diffHash,
          approvedAt: new Date().toISOString(),
        };
        appendAudit(raw, { type: 'diff_approved', fixUnitId, candidateHash, diffHash });
      });
      return clone(raw.diffApprovals[fixUnitId]);
    },

    invalidateVerification(fixUnitId, reason = 'verification_rerun') {
      if (!raw.candidates[fixUnitId]) return null;
      commitMutation(api, () => {
        raw.candidates[fixUnitId] = {
          ...raw.candidates[fixUnitId],
          verified: false,
          verification: { status: 'pending' },
        };
        invalidateCandidateApprovals(raw, fixUnitId, reason);
      });
      return clone(raw.candidates[fixUnitId]);
    },

    getApplyEligibility() {
      const gate = buildApplyGate(raw);
      if (gate.blocked) {
        return { allowed: false, reason: gate.reason, gate };
      }
      const acceptedRows = buildUnitRows(raw).filter((row) => row.reviewStatus === 'accepted');
      return {
        allowed: true,
        reason: 'READY',
        gate,
        units: acceptedRows.map((row) => ({
          fixUnitId: row.fixUnitId,
          candidateHash: row.candidateHash,
          diffHash: row.diffHash,
        })),
      };
    },

    async applyAcceptedCandidates(applyHandler, { baselineByUnit = null, verification = null } = {}) {
      if (typeof applyHandler !== 'function') {
        throw new ReviewStateError('APPLY_HANDLER_REQUIRED', 'Apply requires a trusted handler callback.');
      }
      if (raw.applyCompleted) {
        throw new ReviewStateError('APPLY_ALREADY_COMPLETED', 'Apply already completed for this session.');
      }
      if (raw.applyInFlight) {
        throw new ReviewStateError('APPLY_IN_PROGRESS', 'Apply is already in progress.');
      }
      const eligibility = api.getApplyEligibility();
      if (!eligibility.allowed) {
        throw new ReviewStateError('APPLY_BLOCKED', `Apply gate is closed: ${eligibility.reason}.`);
      }
      commitMutation(api, () => {
        raw.applyStarted = true;
        raw.applyInFlight = true;
        appendAudit(raw, { type: 'apply_started', units: eligibility.units, stateRevision: raw.stateRevision });
      });
      try {
        appendAudit(raw, { type: 'post_verify_started', units: eligibility.units.map((u) => u.fixUnitId) });
        const fullBaseline = clone(raw.verificationBaselineFindings);
        const baselineMap = baselineByUnit || new Map(
          eligibility.units.map((unit) => [unit.fixUnitId, clone(fullBaseline)]),
        );
        const result = await applyHandler({
          sessionDir: raw.sessionDir,
          localRoot: raw.localRoot,
          reportId: raw.reportId,
          units: eligibility.units.map((unit) => {
            const baseUnit = unitById(raw, unit.fixUnitId);
            return {
              ...unit,
              findingIds: baseUnit?.findingIds || [],
              affectedRoutes: baseUnit?.affectedRoutes || ['/'],
            };
          }),
          candidates: eligibility.units.map((unit) => ({
            fixUnitId: unit.fixUnitId,
            candidate: clone(raw.candidates[unit.fixUnitId]),
          })),
          baselineByUnit: baselineMap,
          verification,
        });
        if (result?.status !== 'committed') {
          throw Object.assign(new Error('APPLY_FAILED'), { code: 'APPLY_FAILED', result });
        }
        commitMutation(api, () => {
          raw.applyStarted = false;
          raw.applyInFlight = false;
          raw.applyCompleted = true;
          raw.applyRecoveryRequired = false;
          captureSandboxApplyMetadata(raw, result);
          appendAudit(raw, {
            type: result.postVerified ? 'post_verify_completed' : 'post_verify_skipped',
            units: eligibility.units.map((u) => u.fixUnitId),
          });
          appendAudit(raw, { type: 'apply_completed', result: { status: result.status, postVerified: Boolean(result.postVerified) } });
        });
        return result;
      } catch (error) {
        commitMutation(api, () => {
          raw.applyStarted = false;
          raw.applyInFlight = false;
          appendAudit(raw, {
            type: error.code === 'POST_VERIFY_FAILED' ? 'post_verify_failed' : 'apply_failed',
            error: error.code || error.message,
          });
        });
        throw error;
      }
    },

    async rollbackSandboxTransaction(rollbackHandler) {
      if (typeof rollbackHandler !== 'function') {
        throw new ReviewStateError('ROLLBACK_HANDLER_REQUIRED', 'Rollback requires a trusted handler callback.');
      }
      if (!raw.sandbox?.enabled) {
        throw new ReviewStateError('ROLLBACK_NOT_AVAILABLE', 'Sandbox rollback is not available for this session.');
      }
      if (!raw.applyCompleted || !TRANSACTION_ID_PATTERN.test(raw.sandbox.transactionId || '')) {
        throw new ReviewStateError('ROLLBACK_NOT_AVAILABLE', 'Sandbox rollback requires a committed apply transaction.');
      }
      if (raw.sandbox.rollbackCompleted) {
        throw new ReviewStateError('ROLLBACK_ALREADY_COMPLETED', 'Sandbox rollback has already completed.');
      }
      if (raw.rollbackInFlight && raw.rollbackPromise) {
        return raw.rollbackPromise;
      }
      if (raw.rollbackInFlight) {
        throw new ReviewStateError('ROLLBACK_IN_PROGRESS', 'Sandbox rollback is already in progress.');
      }

      try {
        commitMutation(api, () => {
          raw.rollbackInFlight = true;
          appendAudit(raw, { type: 'rollback_started', transactionId: raw.sandbox.transactionId });
        });
      } catch (error) {
        raw.rollbackInFlight = false;
        raw.rollbackPromise = null;
        throw error;
      }
      const rollbackRun = (async () => {
        try {
          const handlerResult = await rollbackHandler({ transactionId: raw.sandbox.transactionId });
          const sanitized = sanitizeRollbackHandlerResult(handlerResult);
          assertRollbackResultMatchesSandbox(raw, sanitized);
          commitMutation(api, () => {
            raw.rollbackInFlight = false;
            raw.rollbackPromise = null;
            raw.sandbox.rollbackCompleted = true;
            raw.sandbox.rollbackResult = sanitized;
            appendAudit(raw, { type: 'rollback_completed', transactionId: sanitized.transactionId });
          });
          return sanitized;
        } catch (error) {
          const code = error instanceof ReviewStateError
            ? error.code
            : String(error?.code || 'ROLLBACK_VERIFICATION_FAILED');
          commitMutation(api, () => {
            raw.rollbackInFlight = false;
            raw.rollbackPromise = null;
            appendAudit(raw, { type: 'rollback_failed', error: code });
          });
          if (error instanceof ReviewStateError) throw error;
          if (code === 'ROLLBACK_CONFLICTED') {
            throw new ReviewStateError('ROLLBACK_CONFLICTED', 'Rollback conflicted with concurrent user edits.');
          }
          if (code === 'ROLLBACK_VERIFICATION_FAILED') {
            throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback verification failed.');
          }
          throw new ReviewStateError('ROLLBACK_VERIFICATION_FAILED', 'Rollback verification failed.');
        }
      })();
      raw.rollbackPromise = rollbackRun;
      return rollbackRun;
    },

    accept(fixUnitId, candidateHash) {
      return api.setDecision(fixUnitId, 'accepted', { candidateHash });
    },

    reject(fixUnitId, rejectReason) {
      return api.setDecision(fixUnitId, 'rejected', { rejectReason });
    },

    requestRevision(fixUnitId, revisionNote) {
      return api.setDecision(fixUnitId, 'revision_requested', { revisionNote });
    },

    undo(fixUnitId) {
      return api.setDecision(fixUnitId, 'pending', {});
    },

    applyManualMapping(payload) {
      if (!raw.traceInbox) {
        throw new ReviewStateError('TRACE_INBOX_MISSING', 'Trace inbox is unavailable.');
      }
      canApplyManualMapping(raw, payload.findingId);
      const result = applyManualMapping(raw.traceInbox, {
        ...payload,
        reportId: raw.reportId,
      });
      if (!result.ok) {
        throw new ReviewStateError(result.reason || 'MAPPING_FAILED', result.reason || 'Manual mapping failed.');
      }

      commitMutation(api, () => {
        raw.manualMappings[payload.findingId] = clone(result.mapping);
        raw.traceResults = recomputeTraceResults(raw);
        if (result.auditEvent) appendAudit(raw, result.auditEvent);
        appendAudit(raw, {
          type: 'manual_mapping_applied',
          findingId: payload.findingId,
          file: result.mapping.file,
          line: result.mapping.line,
        });
      });
      return clone(result.mapping);
    },

    mergeIntoUnit(sourceFixUnitId, targetFixUnitId) {
      const source = unitById(raw, sourceFixUnitId);
      const target = unitById(raw, targetFixUnitId);
      if (!source || !target) {
        throw new ReviewStateError('UNKNOWN_FIX_UNIT', 'Source or target fix unit was not found.');
      }
      if (source.kind !== 'accessibility' || target.kind !== 'accessibility') {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Only accessibility units can be merged.');
      }
      if (sourceFixUnitId === targetFixUnitId) {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Source and target must differ.');
      }
      const sourceDecision = raw.decisions[sourceFixUnitId] || defaultDecision();
      const targetDecision = raw.decisions[targetFixUnitId] || defaultDecision();
      if (sourceDecision.decision !== 'pending' || targetDecision.decision !== 'pending') {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Only pending units can be merged.');
      }
      if (sourceDecision.revisionNote || targetDecision.revisionNote || sourceDecision.rejectReason || targetDecision.rejectReason) {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Units with revision or reject state cannot be merged.');
      }
      if (hasRegisteredCandidate(raw, sourceFixUnitId) || hasRegisteredCandidate(raw, targetFixUnitId)) {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Units with registered candidates cannot be merged.');
      }
      if (source.status !== 'ready' || target.status !== 'ready') {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Only mapped ready units can be merged.');
      }
      if (!rootCauseMatches(source, target)) {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Units must share the same root-cause identity.');
      }
      if (raw.mergeOverlays.some((overlay) => overlay.sourceFixUnitId === sourceFixUnitId)) {
        throw new ReviewStateError('MERGE_ALREADY_APPLIED', 'Merge overlay already exists.');
      }
      if (raw.mergeOverlays.some((overlay) => overlay.targetFixUnitId === sourceFixUnitId)) {
        throw new ReviewStateError('MERGE_NOT_ALLOWED', 'Merge overlay chain is not allowed.');
      }

      const overlay = buildMergeOverlay(source, target);
      validateMergeOverlayRecord(overlay, source, target);

      commitMutation(api, () => {
        raw.mergeOverlays.push(overlay);
        raw.traceResults = recomputeTraceResults(raw);
        appendAudit(raw, {
          type: 'unit_merged',
          sourceFixUnitId,
          targetFixUnitId,
          findingCount: overlay.sourceFindingIds.length + overlay.targetFindingIds.length,
        });
      });

      return clone(unitById(raw, targetFixUnitId));
    },

    batchAccept(unitIds = []) {
      const ids = [...new Set(unitIds)];
      if (ids.length === 0) {
        throw new ReviewStateError('BATCH_NOT_ELIGIBLE', 'Batch accept requires at least one unit.');
      }
      const rows = buildUnitRows(raw);
      const rowById = new Map(rows.map((row) => [row.fixUnitId, row]));
      for (const fixUnitId of ids) {
        const row = rowById.get(fixUnitId);
        if (!row?.batchEligible || !row.candidateHash) {
          throw new ReviewStateError('BATCH_NOT_ELIGIBLE', `Unit ${fixUnitId} is not batch-eligible.`);
        }
      }

      commitMutation(api, () => {
        for (const fixUnitId of ids) {
          const row = rowById.get(fixUnitId);
          raw.decisions[fixUnitId] = {
            decision: 'accepted',
            candidateHash: row.candidateHash,
            rejectReason: null,
            revisionNote: null,
            updatedAt: new Date().toISOString(),
          };
          appendAudit(raw, { type: 'decision_accepted', fixUnitId, candidateHash: row.candidateHash, batch: true });
        }
      });
      return ids.map((fixUnitId) => api.getDecision(fixUnitId));
    },

    setDecision(fixUnitId, decision, { candidateHash = null, rejectReason = null, revisionNote = null } = {}) {
      if (!raw.decisions[fixUnitId]) {
        throw new ReviewStateError('UNKNOWN_FIX_UNIT', `Unknown fix unit ${fixUnitId}.`);
      }
      if (raw.applyStarted && (decision === 'pending' || decision === 'revision_requested')) {
        throw new ReviewStateError('APPLY_STARTED', 'Decisions cannot be changed after apply starts.');
      }

      const unit = unitById(raw, fixUnitId);
      const current = raw.decisions[fixUnitId];

      if (decision === 'accepted') {
        if (current.decision === 'rejected') {
          throw new ReviewStateError('INVALID_DECISION_TRANSITION', 'Rejected units must be undone before accept.');
        }
        if (!canAcceptUnit(raw, unit)) {
          throw new ReviewStateError('ACCEPT_NOT_ALLOWED', 'Unit is blocked or lacks a registered candidate.');
        }
        const registered = registeredCandidate(raw, fixUnitId);
        if (!SHA256_PATTERN.test(candidateHash || '') || candidateHash !== registered.candidateHash) {
          throw new ReviewStateError('CANDIDATE_HASH_MISMATCH', 'Accepted hash must match registered candidate hash.');
        }
        if (current.decision === 'accepted' && current.candidateHash === candidateHash) {
          return clone(current);
        }
        commitMutation(api, () => {
          raw.decisions[fixUnitId] = {
            decision: 'accepted',
            candidateHash,
            rejectReason: null,
            revisionNote: null,
            updatedAt: new Date().toISOString(),
          };
          appendAudit(raw, { type: 'decision_accepted', fixUnitId, candidateHash });
        });
      } else if (decision === 'rejected') {
        if (current.decision === 'accepted') {
          throw new ReviewStateError('INVALID_DECISION_TRANSITION', 'Accepted units must be undone before reject.');
        }
        const reason = String(rejectReason || '').trim().slice(0, MAX_NOTE_LENGTH);
        if (!reason) {
          throw new ReviewStateError('INVALID_REJECT_REASON', 'Rejected decisions require a reason.');
        }
        if (current.decision === 'rejected' && current.rejectReason === reason) {
          return clone(current);
        }
        commitMutation(api, () => {
          raw.decisions[fixUnitId] = {
            decision: 'rejected',
            candidateHash: null,
            rejectReason: reason,
            revisionNote: null,
            updatedAt: new Date().toISOString(),
          };
          appendAudit(raw, { type: 'decision_rejected', fixUnitId, rejectReason: reason });
        });
      } else if (decision === 'revision_requested') {
        const note = String(revisionNote || '').trim().slice(0, MAX_NOTE_LENGTH);
        if (!note) {
          throw new ReviewStateError('INVALID_REVISION_NOTE', 'Revision requests require a note.');
        }
        if (current.decision === 'accepted') {
          throw new ReviewStateError('INVALID_DECISION_TRANSITION', 'Accepted units must be undone before revise.');
        }
        commitMutation(api, () => {
          raw.decisions[fixUnitId] = {
            decision: 'pending',
            candidateHash: null,
            rejectReason: null,
            revisionNote: note,
            updatedAt: new Date().toISOString(),
          };
          appendAudit(raw, { type: 'revision_requested', fixUnitId, revisionNote: note });
        });
      } else if (decision === 'pending') {
        if (current.decision === 'pending' && !current.revisionNote && !current.rejectReason) {
          return clone(current);
        }
        commitMutation(api, () => {
          raw.decisions[fixUnitId] = defaultDecision();
          raw.decisions[fixUnitId].updatedAt = new Date().toISOString();
          appendAudit(raw, { type: 'decision_pending', fixUnitId, previous: clone(current) });
        });
      } else {
        throw new ReviewStateError('INVALID_DECISION', `Unsupported decision ${decision}.`);
      }

      return api.getDecision(fixUnitId);
    },

    markApplyStarted() {
      commitMutation(api, () => {
        raw.applyStarted = true;
        appendAudit(raw, { type: 'apply_started' });
      });
    },

    refreshTraceResults() {
      commitMutation(api, () => {
        raw.traceResults = recomputeTraceResults(raw);
        appendAudit(raw, {
          type: 'trace_refreshed',
          findingCount: effectiveUnitsFor(raw).flatMap((unit) => unit.findings || []).length,
          tracedCount: raw.traceResults.length,
        });
      });
      return clone(raw.traceResults);
    },

    getSnapshot() {
      const snapshot = {
        schemaVersion: REVIEW_STATE_SCHEMA,
        reportId: raw.reportId,
        sessionId: raw.sessionId,
        stateRevision: raw.stateRevision,
        transportSecurity: raw.transportSecurity,
        devAuthBypass: raw.devAuthBypass,
        preferences: raw.preferences,
        applyGate: buildApplyGate(raw),
        sandbox: buildSandboxSnapshot(raw),
        units: buildUnitRows(raw),
        accessibility: buildAccessibilityModel(raw),
        performance: buildPerformanceModel(raw),
      };
      return trimSnapshotPayload(snapshot);
    },
  };

  return api;
}

export { buildTraceInboxModel, MAX_SNAPSHOT_BYTES, trimSnapshotPayload };
