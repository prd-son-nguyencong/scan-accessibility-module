import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertPathContainedInRoot, resolveTrustedRoot } from '../controller/local-attestation.js';
import {
  assertDestinationContained,
  readSecureFileBytes,
  validateRelativeCandidatePath,
} from '../candidate/path.js';
import {
  CANDIDATE_LIMITS,
  applyEditsToBytes,
  hashFileBytes,
} from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { validateAndBuildCandidate } from '../candidate/intent.js';
import { restoreTransactionFiles } from '../apply/rollback.js';

export class DemoArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DemoArtifactError';
    this.code = code;
  }
}

const EVIDENCE_SCHEMA_VERSION = 1;
const MAX_EVIDENCE_BYTES = 32 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^transaction-\d+-[a-f0-9]+$/;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const VERIFICATION_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const { O_WRONLY, O_CREAT, O_EXCL, O_RDONLY, O_NOFOLLOW } = constants;

const ARTIFACT_PATCH_REL = 'artifacts/candidate.patch';
const ARTIFACT_EVIDENCE_REL = 'artifacts/evidence.json';

/** Internal test hooks — not request-controlled. */
export const __artifactTestHooks = {
  writeExclusiveLeaf: null,
  beforeFinalLeafWrite: null,
  defaultWriteExclusiveLeaf: null,
  beforePersistEvidenceAfterRollback: null,
  renameEvidenceLeaf: null,
};

function fsyncDirectory(dirPath) {
  const fd = openSync(dirPath, O_RDONLY | O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeExclusiveArtifactLeafImpl(leafPath, bytes, mode = 0o600) {
  let fd;
  try {
    fd = openSync(leafPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new DemoArtifactError('ARTIFACT_ALREADY_EXISTS', 'Artifact path already exists.');
    }
    throw error;
  } finally {
    if (fd != null) closeSync(fd);
  }
  chmodSync(leafPath, mode);
  fsyncDirectory(dirname(leafPath));
}

function writeExclusiveArtifactLeaf(leafPath, bytes, mode = 0o600) {
  const beforeWrite = __artifactTestHooks.beforeFinalLeafWrite;
  if (typeof beforeWrite === 'function') {
    beforeWrite(leafPath, bytes, mode);
  }
  const writeFn = __artifactTestHooks.writeExclusiveLeaf || writeExclusiveArtifactLeafImpl;
  writeFn(leafPath, bytes, mode);
}

__artifactTestHooks.defaultWriteExclusiveLeaf = writeExclusiveArtifactLeafImpl;

function assertSha256(value, code, message) {
  if (!SHA256_PATTERN.test(String(value || ''))) {
    throw new DemoArtifactError(code, message);
  }
}

function validateVerificationArtifactId(value) {
  if (value == null || value === '') return null;
  const id = String(value);
  if (!VERIFICATION_ARTIFACT_ID_PATTERN.test(id)) {
    throw new DemoArtifactError('INVALID_VERIFICATION_ARTIFACT', 'Verification artifact ID is invalid.');
  }
  return id;
}

function assertSessionId(sessionId) {
  const value = String(sessionId ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new DemoArtifactError('INVALID_SESSION_ID', 'Session ID is invalid.');
  }
  return value;
}

function toPosixRelative(baseDir, absolutePath) {
  const rel = relative(baseDir, absolutePath);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new DemoArtifactError('PATH_TRAVERSAL', 'Path escapes session directory.');
  }
  return rel.split('\\').join('/');
}

function assertRegularNoFollow(filePath, code = 'INVALID_FILE') {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new DemoArtifactError(code, 'Expected a regular file.');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DemoArtifactError(code, 'Expected a regular file.');
  }
}

function assertDirectoryNoFollow(dirPath, code = 'INVALID_DIRECTORY') {
  let stat;
  try {
    stat = lstatSync(dirPath);
  } catch {
    throw new DemoArtifactError(code, 'Expected a directory.');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DemoArtifactError(code, 'Expected a directory.');
  }
}

function assertPathContainedInTrustedRoot(root, candidatePath, code = 'PATH_TRAVERSAL') {
  const contained = assertPathContainedInRoot(root, candidatePath);
  if (!contained.ok) {
    throw new DemoArtifactError(code, 'Path escapes trusted root.');
  }
  return contained.resolvedPath;
}

function resolveTrustedDemoRoot(root, code = 'LOCAL_ROOT_MISSING') {
  const rootCheck = resolveTrustedRoot(root);
  if (!rootCheck.ok) {
    throw new DemoArtifactError(code, 'Trusted root is unavailable.');
  }
  return rootCheck.localRoot;
}

function validateDemoContext(context) {
  if (!context || typeof context !== 'object') {
    throw new DemoArtifactError('INVALID_CONTEXT', 'Demo artifact context is invalid.');
  }

  const originalRoot = resolveTrustedDemoRoot(context.originalRoot);
  const sandboxRoot = resolveTrustedDemoRoot(context.sandboxRoot);
  const sessionDir = resolveTrustedDemoRoot(context.sessionDir);
  const artifactsDir = resolveTrustedDemoRoot(context.artifactsDir);
  const sessionId = assertSessionId(context.sessionId);
  const targetFile = validateRelativeCandidatePath(context.targetFile);

  assertPathContainedInTrustedRoot(originalRoot, join(originalRoot, targetFile));
  assertPathContainedInTrustedRoot(sandboxRoot, join(sandboxRoot, targetFile));
  assertPathContainedInTrustedRoot(sessionDir, artifactsDir);
  assertDirectoryNoFollow(artifactsDir, 'INVALID_ARTIFACTS_DIR');

  const originalCheckpoint = context.checkpoints?.original?.fileSha256;
  const sandboxCheckpoint = context.checkpoints?.sandbox?.fileSha256;
  assertSha256(originalCheckpoint, 'INVALID_CHECKPOINT', 'Original checkpoint hash is invalid.');
  assertSha256(sandboxCheckpoint, 'INVALID_CHECKPOINT', 'Sandbox checkpoint hash is invalid.');

  return {
    originalRoot,
    sandboxRoot,
    sessionDir,
    artifactsDir,
    sessionId,
    targetFile,
    checkpoints: {
      original: { fileSha256: originalCheckpoint },
      sandbox: { fileSha256: sandboxCheckpoint },
    },
  };
}

export function readBoundedFileNoFollow(filePath, maxBytes) {
  if (!filePath) {
    throw new DemoArtifactError('INVALID_FILE', 'File path is required.');
  }
  assertRegularNoFollow(filePath);
  const bytes = readSecureFileBytes(filePath, maxBytes);
  return bytes.toString('utf8');
}

function assertPathComponentIsRealDirectory(dirPath, code = 'SYMLINK_ARTIFACT_PARENT') {
  let stat;
  try {
    stat = lstatSync(dirPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new DemoArtifactError(code, 'Artifact parent path must not be a symlink.');
  }
  if (!stat.isDirectory()) {
    throw new DemoArtifactError('INVALID_ARTIFACT_PARENT', 'Artifact parent path must be a directory.');
  }
  return true;
}

function validateArtifactPathParents(sessionDir, relativePath) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  const normalized = validateRelativeCandidatePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  let current = resolvedSession;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]);
    if (!assertPathComponentIsRealDirectory(current)) {
      return;
    }
  }
}

function assertArtifactLeafWritable(sessionDir, relativePath) {
  validateArtifactPathParents(sessionDir, relativePath);
  const leafPath = resolveArtifactRelativePath(sessionDir, relativePath);
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  const rel = relative(resolvedSession, leafPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new DemoArtifactError('PATH_TRAVERSAL', 'Artifact path escapes session directory.');
  }
  if (existsSync(leafPath)) {
    const stat = lstatSync(leafPath);
    if (stat.isSymbolicLink()) {
      throw new DemoArtifactError('SYMLINK_DESTINATION', 'Artifact destination must not be a symlink.');
    }
    throw new DemoArtifactError('ARTIFACT_ALREADY_EXISTS', 'Artifact path already exists.');
  }
  return leafPath;
}

function ensureSafeArtifactParentChain(sessionDir, relativePath) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  const normalized = validateRelativeCandidatePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const createdDirs = [];
  let current = resolvedSession;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]);
    if (assertPathComponentIsRealDirectory(current)) {
      continue;
    }
    mkdirSync(current, { mode: 0o700 });
    chmodSync(current, 0o700);
    if (!assertPathComponentIsRealDirectory(current)) {
      throw new DemoArtifactError('INVALID_ARTIFACT_PARENT', 'Artifact parent directory creation failed.');
    }
    createdDirs.push(current);
  }
  const leafPath = join(current, segments[segments.length - 1]);
  return { leafPath, createdDirs };
}

function resolveArtifactRelativePath(sessionDir, relativePath) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  const normalized = validateRelativeCandidatePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  return join(resolvedSession, ...segments);
}

function assertPathContainedInSession(sessionRoot, targetPath) {
  const resolvedRoot = resolveTrustedDemoRoot(sessionRoot);
  let resolvedTarget;
  try {
    resolvedTarget = existsSync(targetPath) ? resolveTrustedDemoRoot(targetPath) : resolve(String(targetPath));
  } catch {
    return false;
  }
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.includes('..')) {
    return false;
  }
  return true;
}

function safeRemoveCreatedArtifactFile(sessionRoot, filePath) {
  if (!assertPathContainedInSession(sessionRoot, filePath)) return;
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    unlinkSync(filePath);
  } catch {
    // ignore cleanup errors
  }
}

function safeRemoveCreatedArtifactDirectory(sessionRoot, dirPath) {
  if (!assertPathContainedInSession(sessionRoot, dirPath)) return;
  try {
    const stat = lstatSync(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (readdirSync(dirPath).length > 0) return;
    rmdirSync(dirPath);
  } catch {
    // ignore cleanup errors
  }
}

function rollbackArtifactAttempt(sessionRoot, created) {
  for (const filePath of [...(created.files || [])].reverse()) {
    safeRemoveCreatedArtifactFile(sessionRoot, filePath);
  }
  for (const dirPath of [...(created.dirs || [])].reverse()) {
    safeRemoveCreatedArtifactDirectory(sessionRoot, dirPath);
  }
}

function writeArtifactSet(sessionDir, entries) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  for (const entry of entries) {
    assertArtifactLeafWritable(resolvedSession, entry.relativePath);
  }

  const created = { files: [], dirs: [] };
  const seenDirs = new Set();
  try {
    for (const entry of entries) {
      const { leafPath, createdDirs } = ensureSafeArtifactParentChain(resolvedSession, entry.relativePath);
      for (const dirPath of createdDirs) {
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          created.dirs.push(dirPath);
        }
      }
      writeExclusiveArtifactLeaf(leafPath, entry.bytes, entry.mode ?? 0o600);
      created.files.push(leafPath);
    }
    return created;
  } catch (error) {
    rollbackArtifactAttempt(resolvedSession, created);
    throw error;
  }
}

function readBoundedBytesNoFollow(filePath, maxBytes) {
  assertRegularNoFollow(filePath);
  return readSecureFileBytes(filePath, maxBytes);
}

function assertTransactionContained(sessionDir, transactionDir) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  const provided = resolve(String(transactionDir));
  const transactionId = basename(provided);
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new DemoArtifactError('INVALID_TRANSACTION', 'Transaction identifier is invalid.');
  }
  const normalizedTransaction = join(resolvedSession, transactionId);

  if (existsSync(provided)) {
    let providedResolved;
    try {
      providedResolved = resolveTrustedDemoRoot(provided);
    } catch {
      throw new DemoArtifactError('INVALID_TRANSACTION', 'Transaction directory is unavailable.');
    }
    const rel = relative(resolvedSession, providedResolved);
    if (rel.startsWith('..') || rel.includes('..') || rel !== transactionId) {
      throw new DemoArtifactError('INVALID_TRANSACTION', 'Transaction directory must be a direct session child.');
    }
    assertDirectoryNoFollow(providedResolved, 'INVALID_TRANSACTION');
    return { transactionDir: providedResolved, transactionId };
  }

  const relProvided = relative(resolvedSession, provided);
  if (relProvided.startsWith('..') || relProvided.includes('..') || relProvided !== transactionId) {
    throw new DemoArtifactError('INVALID_TRANSACTION', 'Transaction directory must be a direct session child.');
  }
  return { transactionDir: normalizedTransaction, transactionId };
}

function fixedArtifactRelativePath(targetFile) {
  return `artifacts/fixed/${targetFile}`;
}

function buildEvidenceObject({
  sessionId,
  targetFile,
  modelId,
  candidateHash,
  diffHash,
  transactionId,
  originalPreimageSha256,
  originalAfterApplySha256,
  sandboxPreimageSha256,
  sandboxPreparePreimageSha256,
  sandboxPostApplySha256,
  verificationArtifactId,
}) {
  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sessionId,
    targetFile,
    modelId,
    candidateHash,
    diffHash,
    transactionId,
    artifactPaths: Object.freeze({
      patch: ARTIFACT_PATCH_REL,
      fixed: fixedArtifactRelativePath(targetFile),
      evidence: ARTIFACT_EVIDENCE_REL,
    }),
    original: Object.freeze({
      preimageSha256: originalPreimageSha256,
      afterApplySha256: originalAfterApplySha256,
    }),
    sandbox: Object.freeze({
      preimageSha256: sandboxPreimageSha256,
      preparePreimageSha256: sandboxPreparePreimageSha256,
      postApplySha256: sandboxPostApplySha256,
    }),
    originalUnchangedAfterApply: originalPreimageSha256 === originalAfterApplySha256,
    originalUnchangedAfterRollback: null,
    sandboxRestored: null,
    verificationArtifactId: verificationArtifactId || null,
  });
}

const RECOVERY_ARTIFACT_ERROR = 'ARTIFACT_EXPORT_FAILED';

function validateEvidenceArtifactPathValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\')) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence artifact paths are invalid.');
  }
  if (value.startsWith('/') || value.includes('..')) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence artifact paths are invalid.');
  }
}

function validateEvidenceArtifactPaths(paths, { allowRecoveryPaths = false } = {}) {
  if (!paths || typeof paths !== 'object') {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence artifact paths are invalid.');
  }
  if (!allowRecoveryPaths) {
    for (const key of ['patch', 'fixed', 'evidence']) {
      validateEvidenceArtifactPathValue(paths[key]);
    }
    return;
  }
  if (typeof paths.evidence !== 'string') {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Recovery evidence path is invalid.');
  }
  validateEvidenceArtifactPathValue(paths.evidence);
  for (const key of ['patch', 'fixed']) {
    if (paths[key] != null) {
      validateEvidenceArtifactPathValue(paths[key]);
    }
  }
}

function validateEvidencePayload(parsed, { allowRollbackFields = false, allowRecoveryEvidence = false } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence payload is invalid.');
  }
  if (parsed.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence schema version is unsupported.');
  }
  assertSessionId(parsed.sessionId);
  validateRelativeCandidatePath(parsed.targetFile);
  if (allowRecoveryEvidence) {
    if (parsed.modelId != null && (typeof parsed.modelId !== 'string' || !MODEL_ID_PATTERN.test(parsed.modelId))) {
      throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence model ID is invalid.');
    }
    if (parsed.artifactError !== RECOVERY_ARTIFACT_ERROR) {
      throw new DemoArtifactError('INVALID_EVIDENCE', 'Recovery evidence artifact error is invalid.');
    }
  } else if (typeof parsed.modelId !== 'string' || !MODEL_ID_PATTERN.test(parsed.modelId)) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence model ID is invalid.');
  }
  assertSha256(parsed.candidateHash, 'INVALID_EVIDENCE', 'Evidence candidate hash is invalid.');
  assertSha256(parsed.diffHash, 'INVALID_EVIDENCE', 'Evidence diff hash is invalid.');
  if (!TRANSACTION_ID_PATTERN.test(String(parsed.transactionId || ''))) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence transaction ID is invalid.');
  }
  validateEvidenceArtifactPaths(parsed.artifactPaths, { allowRecoveryPaths: allowRecoveryEvidence });
  const original = parsed.original;
  if (!original || typeof original !== 'object') {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence original hash block is invalid.');
  }
  assertSha256(original.preimageSha256, 'INVALID_EVIDENCE', 'Evidence original preimage hash is invalid.');
  assertSha256(original.afterApplySha256, 'INVALID_EVIDENCE', 'Evidence original after-apply hash is invalid.');
  const sandbox = parsed.sandbox;
  if (!sandbox || typeof sandbox !== 'object') {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence sandbox hash block is invalid.');
  }
  assertSha256(sandbox.preimageSha256, 'INVALID_EVIDENCE', 'Evidence sandbox preimage hash is invalid.');
  assertSha256(sandbox.preparePreimageSha256, 'INVALID_EVIDENCE', 'Evidence sandbox prepare preimage hash is invalid.');
  assertSha256(sandbox.postApplySha256, 'INVALID_EVIDENCE', 'Evidence sandbox post-apply hash is invalid.');
  if (typeof parsed.originalUnchangedAfterApply !== 'boolean') {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence originalUnchangedAfterApply is invalid.');
  }
  if (allowRollbackFields) {
    if (typeof parsed.originalUnchangedAfterRollback !== 'boolean') {
      throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence originalUnchangedAfterRollback is invalid.');
    }
    if (typeof parsed.sandboxRestored !== 'boolean') {
      throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence sandboxRestored is invalid.');
    }
    if (original.afterRollbackSha256 != null) {
      assertSha256(original.afterRollbackSha256, 'INVALID_EVIDENCE', 'Evidence original after-rollback hash is invalid.');
    }
    if (sandbox.afterRollbackSha256 != null) {
      assertSha256(sandbox.afterRollbackSha256, 'INVALID_EVIDENCE', 'Evidence sandbox after-rollback hash is invalid.');
    }
  } else {
    if (parsed.originalUnchangedAfterRollback !== null) {
      throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence originalUnchangedAfterRollback must be null initially.');
    }
    if (parsed.sandboxRestored !== null) {
      throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence sandboxRestored must be null initially.');
    }
  }
  if (parsed.verificationArtifactId != null) {
    validateVerificationArtifactId(parsed.verificationArtifactId);
  }
  return parsed;
}

function parseJournalLines(transactionDir) {
  const journalPath = join(transactionDir, 'journal.ndjson');
  if (!existsSync(journalPath)) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction journal is missing.');
  }
  const raw = readBoundedFileNoFollow(journalPath, MAX_JOURNAL_BYTES);
  const lines = raw.split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new DemoArtifactError('INVALID_JOURNAL', `Transaction journal line ${index} is malformed.`);
    }
  });
}

function readTransactionWriteEvent(transactionDir, targetFile) {
  for (const event of parseJournalLines(transactionDir)) {
    if (event?.action !== 'write' || event.file !== targetFile) {
      continue;
    }
    assertSha256(event.preHash, 'INVALID_JOURNAL', 'Transaction journal pre-hash is invalid.');
    assertSha256(event.postHash, 'INVALID_JOURNAL', 'Transaction journal post-hash is invalid.');
    return {
      file: event.file,
      preHash: event.preHash,
      postHash: event.postHash,
    };
  }
  throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction write event was not found.');
}

function parseDemoRollbackJournal(transactionDir, targetFile) {
  const events = parseJournalLines(transactionDir);
  let beginEvent = null;
  let writeEvent = null;
  let commitEvent = null;
  let writeCount = 0;

  for (const event of events) {
    if (event?.action === 'begin') {
      if (beginEvent) {
        throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction journal contains duplicate begin events.');
      }
      beginEvent = event;
      continue;
    }
    if (event?.action === 'write') {
      writeCount += 1;
      if (event.file === targetFile) {
        if (writeEvent) {
          throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction journal contains duplicate target writes.');
        }
        writeEvent = event;
      }
      continue;
    }
    if (event?.action === 'commit') {
      if (commitEvent) {
        throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction journal contains duplicate commit events.');
      }
      commitEvent = event;
    }
  }

  if (!beginEvent || !writeEvent || !commitEvent) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction journal is missing begin, write, or commit events.');
  }
  if (writeCount !== 1) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Demo rollback requires exactly one journal write event.');
  }
  if (!Array.isArray(beginEvent.files) || beginEvent.files.length !== 1 || beginEvent.files[0] !== targetFile) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction begin files do not match demo target.');
  }
  if (!Array.isArray(beginEvent.entries) || beginEvent.entries.length !== 1) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction begin entries must contain exactly one candidate.');
  }
  if (!Array.isArray(commitEvent.files) || commitEvent.files.length !== 1 || commitEvent.files[0] !== targetFile) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction commit files do not match demo target.');
  }

  const entry = beginEvent.entries[0];
  assertSha256(entry.candidateHash, 'INVALID_JOURNAL', 'Transaction journal candidate hash is invalid.');
  assertSha256(entry.diffHash, 'INVALID_JOURNAL', 'Transaction journal diff hash is invalid.');
  const verificationArtifactId = validateVerificationArtifactId(entry.verificationArtifactId);
  assertSha256(writeEvent.preHash, 'INVALID_JOURNAL', 'Transaction journal pre-hash is invalid.');
  assertSha256(writeEvent.postHash, 'INVALID_JOURNAL', 'Transaction journal post-hash is invalid.');
  if (writeEvent.file !== targetFile) {
    throw new DemoArtifactError('INVALID_JOURNAL', 'Transaction write target does not match demo file.');
  }

  return Object.freeze({
    candidateHash: entry.candidateHash,
    diffHash: entry.diffHash,
    verificationArtifactId,
    preHash: writeEvent.preHash,
    postHash: writeEvent.postHash,
  });
}

function buildDemoScopeRecord(validated, stored, reportId) {
  const candidate = validateRegisteredCandidateAgainstSandbox(
    stored,
    validated.sandboxRoot,
    reportId,
    validated.targetFile,
  );
  const sandboxFilePath = assertDestinationContained(validated.sandboxRoot, validated.targetFile);
  const preApplySandboxBytes = readBoundedBytesNoFollow(sandboxFilePath, CANDIDATE_LIMITS.maxFileBytes);
  const preApplySandboxHash = hashFileBytes(preApplySandboxBytes);
  const expectedPostApplyBytes = applyEditsToBytes(preApplySandboxBytes, candidate.edits);
  const expectedPostApplyHash = hashFileBytes(expectedPostApplyBytes);
  const verificationArtifactId = validateVerificationArtifactId(stored.verification?.artifactId);

  return Object.freeze({
    targetFile: validated.targetFile,
    candidate,
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    diff: candidate.diff,
    modelId: candidate.modelId,
    verificationArtifactId,
    preApplySandboxHash,
    expectedPostApplyHash,
    expectedPostApplyBytes,
  });
}

export function writeDemoEvidence(sessionDir, evidence) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  validateEvidencePayload(evidence);
  const serialized = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new DemoArtifactError('EVIDENCE_TOO_LARGE', 'Evidence payload exceeds allowed size.');
  }
  writeArtifactSet(resolvedSession, [{
    relativePath: ARTIFACT_EVIDENCE_REL,
    bytes: Buffer.from(serialized, 'utf8'),
    mode: 0o600,
  }]);
  return ARTIFACT_EVIDENCE_REL;
}

function evidencePathForSession(sessionDir) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  validateArtifactPathParents(resolvedSession, ARTIFACT_EVIDENCE_REL);
  return resolveArtifactRelativePath(resolvedSession, ARTIFACT_EVIDENCE_REL);
}

function evidenceValidationOptions(parsed) {
  const allowRecoveryEvidence = parsed?.artifactError === RECOVERY_ARTIFACT_ERROR;
  const allowRollbackFields = parsed?.originalUnchangedAfterRollback !== null
    || parsed?.sandboxRestored !== null
    || allowRecoveryEvidence;
  return { allowRollbackFields, allowRecoveryEvidence };
}

function tryReadDemoEvidenceOptional(sessionDir) {
  const evidencePath = evidencePathForSession(sessionDir);
  if (!existsSync(evidencePath)) {
    return null;
  }
  const raw = readBoundedFileNoFollow(evidencePath, MAX_EVIDENCE_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence payload is malformed.');
  }
  return validateEvidencePayload(parsed, evidenceValidationOptions(parsed));
}

export function readDemoEvidence(sessionDir) {
  const evidence = tryReadDemoEvidenceOptional(sessionDir);
  if (!evidence) {
    throw new DemoArtifactError('INVALID_EVIDENCE', 'Evidence payload is missing.');
  }
  return evidence;
}

function buildRecoveryEvidenceObject({
  sessionId,
  targetFile,
  candidateHash,
  diffHash,
  transactionId,
  originalPreimageSha256,
  sandboxPreimageSha256,
  sandboxPreparePreimageSha256,
  sandboxPostApplySha256,
  verificationArtifactId,
  originalAfterRollbackSha256,
  sandboxAfterRollbackSha256,
}) {
  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sessionId,
    targetFile,
    modelId: null,
    candidateHash,
    diffHash,
    transactionId,
    artifactPaths: Object.freeze({
      evidence: ARTIFACT_EVIDENCE_REL,
    }),
    artifactError: RECOVERY_ARTIFACT_ERROR,
    original: Object.freeze({
      preimageSha256: originalPreimageSha256,
      afterApplySha256: originalPreimageSha256,
      afterRollbackSha256: originalAfterRollbackSha256,
    }),
    sandbox: Object.freeze({
      preimageSha256: sandboxPreimageSha256,
      preparePreimageSha256: sandboxPreparePreimageSha256,
      postApplySha256: sandboxPostApplySha256,
      afterRollbackSha256: sandboxAfterRollbackSha256,
    }),
    originalUnchangedAfterApply: true,
    originalUnchangedAfterRollback: true,
    sandboxRestored: true,
    verificationArtifactId: verificationArtifactId || null,
  });
}

function persistDemoEvidenceAfterRollback(sessionDir, evidence, { existed }) {
  const beforePersist = __artifactTestHooks.beforePersistEvidenceAfterRollback;
  if (typeof beforePersist === 'function') {
    beforePersist({ sessionDir, evidence, existed });
  }
  validateEvidencePayload(evidence, { allowRollbackFields: true, allowRecoveryEvidence: evidence.artifactError === RECOVERY_ARTIFACT_ERROR });
  const serialized = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new DemoArtifactError('EVIDENCE_TOO_LARGE', 'Evidence payload exceeds allowed size.');
  }
  if (existed) {
    rewriteDemoEvidenceLeaf(sessionDir, evidence);
    return;
  }
  writeArtifactSet(resolveTrustedDemoRoot(sessionDir), [{
    relativePath: ARTIFACT_EVIDENCE_REL,
    bytes: Buffer.from(serialized, 'utf8'),
    mode: 0o600,
  }]);
}

function resolveRollbackExpectations(validated, evidence, journalRecord) {
  if (evidence) {
    assertEvidenceMatchesContext(evidence, validated);
    if (evidence.transactionId !== journalRecord.transactionId) {
      throw new DemoArtifactError('EVIDENCE_TRANSACTION_MISMATCH', 'Evidence transaction does not match journal.');
    }
    if (evidence.candidateHash !== journalRecord.candidateHash || evidence.diffHash !== journalRecord.diffHash) {
      throw new DemoArtifactError('JOURNAL_INCOHERENT', 'Transaction journal candidate lineage does not match evidence.');
    }
    if (evidence.sandbox.preimageSha256 !== journalRecord.preHash) {
      throw new DemoArtifactError('JOURNAL_INCOHERENT', 'Transaction journal pre-hash does not match evidence.');
    }
    if (evidence.sandbox.postApplySha256 !== journalRecord.postHash) {
      throw new DemoArtifactError('JOURNAL_INCOHERENT', 'Transaction journal post-hash does not match evidence.');
    }
    return {
      expectedSandboxRestoredHash: evidence.sandbox.preimageSha256,
      expectedOriginalHash: evidence.original.preimageSha256,
      journalRecord,
    };
  }

  return {
    expectedSandboxRestoredHash: journalRecord.preHash,
    expectedOriginalHash: validated.checkpoints.original.fileSha256,
    journalRecord,
  };
}

function rewriteDemoEvidenceLeaf(sessionDir, evidence) {
  const resolvedSession = resolveTrustedDemoRoot(sessionDir);
  validateEvidencePayload(evidence, evidenceValidationOptions(evidence));
  const serialized = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new DemoArtifactError('EVIDENCE_TOO_LARGE', 'Evidence payload exceeds allowed size.');
  }
  const evidencePath = resolveArtifactRelativePath(resolvedSession, ARTIFACT_EVIDENCE_REL);
  assertRegularNoFollow(evidencePath, 'INVALID_EVIDENCE');
  const tempPath = `${evidencePath}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    writeSync(fd, Buffer.from(serialized, 'utf8'));
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
  const renameFn = __artifactTestHooks.renameEvidenceLeaf || renameSync;
  try {
    renameFn(tempPath, evidencePath);
    chmodSync(evidencePath, 0o600);
    fsyncDirectory(dirname(evidencePath));
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
    throw error;
  }
}

function assertEvidenceMatchesContext(evidence, validated) {
  if (evidence.sessionId !== validated.sessionId) {
    throw new DemoArtifactError('EVIDENCE_SESSION_MISMATCH', 'Evidence session does not match demo context.');
  }
  if (evidence.targetFile !== validated.targetFile) {
    throw new DemoArtifactError('EVIDENCE_TARGET_MISMATCH', 'Evidence target does not match demo context.');
  }
  if (evidence.original?.preimageSha256 !== validated.checkpoints.original.fileSha256) {
    throw new DemoArtifactError('EVIDENCE_CHECKPOINT_MISMATCH', 'Evidence original checkpoint does not match context.');
  }
}

export function createDemoRollbackHandler(context) {
  return async function rollbackDemoTransaction({ transactionId }) {
    const validated = validateDemoContext(context);
    const normalizedId = String(transactionId ?? '');
    if (!TRANSACTION_ID_PATTERN.test(normalizedId)) {
      throw new DemoArtifactError('INVALID_TRANSACTION', 'Transaction identifier is invalid.');
    }

    const { transactionDir, transactionId: resolvedTransactionId } = assertTransactionContained(
      validated.sessionDir,
      join(validated.sessionDir, normalizedId),
    );

    const journalRecord = {
      ...parseDemoRollbackJournal(transactionDir, validated.targetFile),
      transactionId: resolvedTransactionId,
    };

    const evidencePath = evidencePathForSession(validated.sessionDir);
    const evidenceExisted = existsSync(evidencePath);
    let evidence = null;
    if (evidenceExisted) {
      try {
        evidence = tryReadDemoEvidenceOptional(validated.sessionDir);
      } catch (error) {
        if (error instanceof DemoArtifactError) {
          throw error;
        }
        throw error;
      }
      if (evidence.transactionId !== resolvedTransactionId) {
        throw new DemoArtifactError('EVIDENCE_TRANSACTION_MISMATCH', 'Evidence transaction does not match rollback request.');
      }
    }

    const expectations = resolveRollbackExpectations(validated, evidence, journalRecord);

    const rollback = await restoreTransactionFiles({
      localRoot: validated.sandboxRoot,
      transactionDir,
    });
    if (rollback.conflicts.length > 0) {
      throw new DemoArtifactError('ROLLBACK_CONFLICTED', 'Rollback conflicted with concurrent user edits.');
    }

    const sandboxFilePath = assertDestinationContained(validated.sandboxRoot, validated.targetFile);
    const originalFilePath = assertDestinationContained(validated.originalRoot, validated.targetFile);
    const sandboxBytes = readBoundedBytesNoFollow(sandboxFilePath, CANDIDATE_LIMITS.maxFileBytes);
    const originalBytes = readBoundedBytesNoFollow(originalFilePath, CANDIDATE_LIMITS.maxFileBytes);
    const sandboxAfterRollbackSha256 = hashFileBytes(sandboxBytes);
    const originalAfterRollbackSha256 = hashFileBytes(originalBytes);

    if (sandboxAfterRollbackSha256 !== expectations.expectedSandboxRestoredHash) {
      throw new DemoArtifactError('ROLLBACK_VERIFICATION_FAILED', 'Sandbox rollback hash verification failed.');
    }
    if (originalAfterRollbackSha256 !== expectations.expectedOriginalHash) {
      throw new DemoArtifactError('ROLLBACK_VERIFICATION_FAILED', 'Original source hash verification failed.');
    }

    let updatedEvidence;
    if (evidence) {
      updatedEvidence = Object.freeze({
        ...evidence,
        original: Object.freeze({
          ...evidence.original,
          afterRollbackSha256: originalAfterRollbackSha256,
        }),
        sandbox: Object.freeze({
          ...evidence.sandbox,
          afterRollbackSha256: sandboxAfterRollbackSha256,
        }),
        originalUnchangedAfterRollback: true,
        sandboxRestored: true,
      });
    } else {
      updatedEvidence = buildRecoveryEvidenceObject({
        sessionId: validated.sessionId,
        targetFile: validated.targetFile,
        candidateHash: journalRecord.candidateHash,
        diffHash: journalRecord.diffHash,
        transactionId: resolvedTransactionId,
        originalPreimageSha256: validated.checkpoints.original.fileSha256,
        sandboxPreimageSha256: journalRecord.preHash,
        sandboxPreparePreimageSha256: validated.checkpoints.sandbox.fileSha256,
        sandboxPostApplySha256: journalRecord.postHash,
        verificationArtifactId: journalRecord.verificationArtifactId,
        originalAfterRollbackSha256,
        sandboxAfterRollbackSha256,
      });
    }
    persistDemoEvidenceAfterRollback(validated.sessionDir, updatedEvidence, { existed: evidenceExisted });

    return Object.freeze({
      transactionId: resolvedTransactionId,
      targetFile: validated.targetFile,
      restored: Object.freeze(rollback.restored.map((entry) => Object.freeze({ file: entry.file }))),
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });
  };
}

function assertSingleScopedCandidate(context, payload) {
  const units = payload?.units;
  const candidates = payload?.candidates;
  if (!Array.isArray(units) || units.length !== 1) {
    throw new DemoArtifactError('DEMO_CANDIDATE_SCOPE_VIOLATION', 'Demo apply requires exactly one fix unit.');
  }
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    throw new DemoArtifactError('DEMO_CANDIDATE_SCOPE_VIOLATION', 'Demo apply requires exactly one candidate.');
  }
  if (candidates[0].fixUnitId !== units[0].fixUnitId) {
    throw new DemoArtifactError('DEMO_CANDIDATE_SCOPE_VIOLATION', 'Demo candidate does not match the accepted unit.');
  }
  return candidates[0].candidate;
}

function validateRegisteredCandidateAgainstSandbox(stored, sandboxRoot, reportId, targetFile) {
  if (!stored?.editIntents?.length) {
    throw new DemoArtifactError('DEMO_CANDIDATE_SCOPE_VIOLATION', 'Demo candidate is incomplete.');
  }

  for (const edit of stored.editIntents) {
    const file = validateRelativeCandidatePath(edit.file);
    if (file !== targetFile) {
      throw new DemoArtifactError('DEMO_CANDIDATE_SCOPE_VIOLATION', 'Demo candidate edits must target the demo file only.');
    }
  }

  const rebuilt = attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: sandboxRoot,
    reportId: reportId || stored.reportId || 'demo-report',
    policyVersion: stored.policyVersion || '1',
    promptVersion: stored.promptVersion || '',
    modelId: stored.modelId || '',
    edits: stored.editIntents,
  }));

  if (stored.candidateHash && rebuilt.candidateHash !== stored.candidateHash) {
    throw new DemoArtifactError('CANDIDATE_HASH_MISMATCH', 'Candidate hash does not match registered value.');
  }
  if (stored.diffHash && rebuilt.diffHash !== stored.diffHash) {
    throw new DemoArtifactError('DIFF_HASH_MISMATCH', 'Diff hash does not match registered value.');
  }
  if (typeof stored.diff === 'string' && stored.diff !== rebuilt.diff) {
    throw new DemoArtifactError('DIFF_MISMATCH', 'Registered diff does not match canonical diff.');
  }

  return rebuilt;
}

export function assertDemoCandidateScope(context, payload) {
  const validated = validateDemoContext(context);
  const stored = assertSingleScopedCandidate(validated, payload);
  return buildDemoScopeRecord(validated, stored, payload?.reportId);
}

export function exportDemoArtifacts(context, payload, result, scopeRecord) {
  const validated = validateDemoContext(context);
  const scope = scopeRecord || buildDemoScopeRecord(
    validated,
    assertSingleScopedCandidate(validated, payload),
    payload?.reportId,
  );

  if (!result || result.status !== 'committed' || !result.transactionDir) {
    throw new DemoArtifactError('INVALID_RESULT', 'Committed apply result is required.');
  }

  const { transactionDir, transactionId } = assertTransactionContained(validated.sessionDir, result.transactionDir);

  if (!Array.isArray(result.written) || result.written.length !== 1) {
    throw new DemoArtifactError('INVALID_RESULT', 'Committed apply must write exactly one file.');
  }
  const written = result.written[0];
  if (written.file !== validated.targetFile || written.file !== scope.targetFile) {
    throw new DemoArtifactError('INVALID_RESULT', 'Committed write target does not match demo file.');
  }
  assertSha256(written.postHash, 'INVALID_RESULT', 'Committed post-apply hash is invalid.');
  if (written.postHash !== scope.expectedPostApplyHash) {
    throw new DemoArtifactError('APPLY_RESULT_INCOHERENT', 'Committed post-apply hash does not match scoped candidate.');
  }

  const journalWrite = readTransactionWriteEvent(transactionDir, validated.targetFile);
  if (
    journalWrite.preHash !== scope.preApplySandboxHash
    || journalWrite.postHash !== scope.expectedPostApplyHash
  ) {
    throw new DemoArtifactError('JOURNAL_INCOHERENT', 'Transaction journal does not match scoped apply.');
  }

  const sandboxFilePath = assertDestinationContained(validated.sandboxRoot, validated.targetFile);
  const sandboxBytes = readBoundedBytesNoFollow(sandboxFilePath, CANDIDATE_LIMITS.maxFileBytes);
  const currentSandboxHash = hashFileBytes(sandboxBytes);
  if (
    currentSandboxHash !== scope.expectedPostApplyHash
    || !sandboxBytes.equals(scope.expectedPostApplyBytes)
  ) {
    throw new DemoArtifactError('SANDBOX_APPLY_INCOHERENT', 'Sandbox bytes do not match scoped candidate apply.');
  }

  const originalFilePath = assertDestinationContained(validated.originalRoot, validated.targetFile);
  const originalBytes = readBoundedBytesNoFollow(originalFilePath, CANDIDATE_LIMITS.maxFileBytes);
  const originalAfterApplySha256 = hashFileBytes(originalBytes);
  if (originalAfterApplySha256 !== validated.checkpoints.original.fileSha256) {
    throw new DemoArtifactError('ORIGINAL_CHANGED', 'Original target file changed during sandbox apply.');
  }

  const fixedRel = fixedArtifactRelativePath(validated.targetFile);
  const evidence = buildEvidenceObject({
    sessionId: validated.sessionId,
    targetFile: validated.targetFile,
    modelId: scope.modelId,
    candidateHash: scope.candidateHash,
    diffHash: scope.diffHash,
    transactionId,
    originalPreimageSha256: validated.checkpoints.original.fileSha256,
    originalAfterApplySha256,
    sandboxPreimageSha256: scope.preApplySandboxHash,
    sandboxPreparePreimageSha256: validated.checkpoints.sandbox.fileSha256,
    sandboxPostApplySha256: scope.expectedPostApplyHash,
    verificationArtifactId: scope.verificationArtifactId,
  });
  const evidenceSerialized = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(evidenceSerialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new DemoArtifactError('EVIDENCE_TOO_LARGE', 'Evidence payload exceeds allowed size.');
  }

  writeArtifactSet(validated.sessionDir, [
    { relativePath: ARTIFACT_PATCH_REL, bytes: Buffer.from(scope.diff, 'utf8'), mode: 0o600 },
    { relativePath: fixedRel, bytes: scope.expectedPostApplyBytes, mode: 0o600 },
    { relativePath: ARTIFACT_EVIDENCE_REL, bytes: Buffer.from(evidenceSerialized, 'utf8'), mode: 0o600 },
  ]);

  return Object.freeze({
    patch: ARTIFACT_PATCH_REL,
    fixed: fixedRel,
    evidence: ARTIFACT_EVIDENCE_REL,
    transactionId,
    transactionDir: toPosixRelative(validated.sessionDir, transactionDir),
  });
}

export function createDemoApplyHandlerWrap(context) {
  return (trustedApplyHandler) => async (payload) => {
    const scopeRecord = assertDemoCandidateScope(context, payload);
    const result = await trustedApplyHandler(payload);
    if (result?.status !== 'committed') {
      return result;
    }
    try {
      const artifacts = exportDemoArtifacts(context, payload, result, scopeRecord);
      return { ...result, artifacts };
    } catch {
      return { ...result, artifactError: 'ARTIFACT_EXPORT_FAILED' };
    }
  };
}

export {
  ARTIFACT_EVIDENCE_REL,
  ARTIFACT_PATCH_REL,
  EVIDENCE_SCHEMA_VERSION,
  MAX_EVIDENCE_BYTES,
  MODEL_ID_PATTERN,
  SHA256_PATTERN,
  TRANSACTION_ID_PATTERN,
  fixedArtifactRelativePath,
};
