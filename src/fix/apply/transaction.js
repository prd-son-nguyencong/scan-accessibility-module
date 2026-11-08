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
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  CandidateIntentError,
  applyEditsToBytes,
  assertNoCrossCandidateConflicts,
  hashFileBytes,
  touchedFilesForCandidate,
} from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { resolveSecureSourceFile } from '../candidate/path.js';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import { readAndVerifyArtifact } from '../verify/artifact.js';
import { acquireWorkspaceLock, releaseWorkspaceLock } from './lock.js';
import { restoreTransactionFiles } from './rollback.js';

export class TransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
  }
}

const MAX_FILE_BYTES = 512 * 1024;
const { O_WRONLY, O_CREAT, O_EXCL, O_RDONLY, O_NOFOLLOW } = constants;

/** Internal test hooks — not request-controlled. */
export const __transactionTestHooks = {
  renameSync: null,
};

function renameFile(fromPath, toPath) {
  const renameFn = __transactionTestHooks.renameSync || renameSync;
  renameFn(fromPath, toPath);
}

function removeTempArtifactsForBase(dirPath, baseName) {
  try {
    for (const entry of readdirSync(dirPath)) {
      if (entry.startsWith(`${baseName}.`) && (entry.endsWith('.tmp') || entry.endsWith('.rollback'))) {
        try {
          unlinkSync(join(dirPath, entry));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

function appendJournal(transactionDir, event) {
  const journalPath = join(transactionDir, 'journal.ndjson');
  const line = `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`;
  const fd = openSync(journalPath, O_WRONLY | O_CREAT | constants.O_APPEND, 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(journalPath, 0o600);
}

function readFileBytesNoFollow(filePath) {
  const fd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new TransactionError('FILE_TOO_LARGE', 'File exceeds transaction size limit.');
    }
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    return { bytes: buffer, mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

function snapshotFile(transactionDir, file, bytes) {
  const snapshotPath = join(transactionDir, 'snapshots', file);
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  chmodSync(join(transactionDir, 'snapshots'), 0o700);
  const tempPath = `${snapshotPath}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    writeSync(fd, bytes);
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
    renameFile(tempPath, snapshotPath);
    chmodSync(snapshotPath, 0o600);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
    removeTempArtifactsForBase(dirname(snapshotPath), basename(snapshotPath));
    throw error;
  }
}

function fsyncDirectory(dirPath) {
  const fd = openSync(dirPath, O_RDONLY | O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAtomicFile(targetPath, bytes, mode = 0o644) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, O_WRONLY | O_CREAT | O_EXCL, mode);
    writeSync(fd, bytes);
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
    renameFile(tempPath, targetPath);
    chmodSync(targetPath, mode);
    fsyncDirectory(dir);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // ignore
    }
    removeTempArtifactsForBase(dir, basename(targetPath));
    throw error;
  }
}

function validateEntry(entry, sessionDir) {
  if (!entry?.candidate || !entry.candidateHash || !entry.diffHash || !entry.verificationArtifactId) {
    throw new TransactionError('INVALID_ENTRY', 'Apply entry is incomplete.');
  }
  const enriched = entry.candidate.diffHash
    ? entry.candidate
    : attachDiffToCandidate(entry.candidate);
  if (enriched.candidateHash !== entry.candidateHash) {
    throw new TransactionError('CANDIDATE_HASH_MISMATCH', 'Candidate hash does not match approved value.');
  }
  if (enriched.diffHash !== entry.diffHash) {
    throw new TransactionError('DIFF_HASH_MISMATCH', 'Diff hash does not match approved value.');
  }
  readAndVerifyArtifact(sessionDir, entry.verificationArtifactId, {
    candidateHash: entry.candidateHash,
    diffHash: entry.diffHash,
  });
  return enriched;
}

function collectFilePlans(localRoot, candidates) {
  const files = new Map();
  for (const candidate of candidates) {
    for (const file of touchedFilesForCandidate(candidate)) {
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(candidate);
    }
  }
  const plans = [];
  for (const [file, relatedCandidates] of files.entries()) {
    const resolved = resolveSecureSourceFile(localRoot, file, { maxBytes: MAX_FILE_BYTES });
    const expectedHash = relatedCandidates[0].edits.find((edit) => edit.file === file)?.expectedFileSha256;
    const currentHash = hashFileBytes(resolved.bytes);
    if (expectedHash && currentHash !== expectedHash) {
      throw new TransactionError('STALE_PREIMAGE', 'Source file changed before apply.');
    }
    const allEdits = relatedCandidates.flatMap((candidate) => candidate.edits.filter((edit) => edit.file === file));
    const updatedBytes = applyEditsToBytes(resolved.bytes, allEdits);
    plans.push({
      file,
      targetPath: resolved.resolvedPath,
      beforeBytes: resolved.bytes,
      afterBytes: updatedBytes,
      beforeHash: currentHash,
      afterHash: hashFileBytes(updatedBytes),
      mode: resolved.mode || 0o644,
    });
  }
  return plans.sort((a, b) => a.file.localeCompare(b.file));
}

export async function applyBatchTransaction({
  localRoot,
  sessionDir,
  entries = [],
  failAfterWrite = null,
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TransactionError('INVALID_ENTRY', 'Apply batch requires at least one entry.');
  }

  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new TransactionError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root unavailable.');
  }

  const validated = entries.map((entry) => validateEntry(entry, sessionDir));
  assertNoCrossCandidateConflicts(validated);

  const transactionDir = join(sessionDir, `transaction-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  chmodSync(transactionDir, 0o700);

  let lock = null;
  const written = [];
  try {
    lock = acquireWorkspaceLock(rootCheck.localRoot);
    const plans = collectFilePlans(rootCheck.localRoot, validated);

    appendJournal(transactionDir, {
      action: 'begin',
      entries: entries.map((entry) => ({
        fixUnitId: entry.fixUnitId || null,
        candidateHash: entry.candidateHash,
        diffHash: entry.diffHash,
        verificationArtifactId: entry.verificationArtifactId,
      })),
      files: plans.map((plan) => plan.file),
    });

    for (const plan of plans) {
      const live = readFileBytesNoFollow(plan.targetPath);
      if (hashFileBytes(live.bytes) !== plan.beforeHash) {
        throw new TransactionError('STALE_PREIMAGE', 'Compare-and-swap preflight failed.');
      }
      snapshotFile(transactionDir, plan.file, plan.beforeBytes);
    }

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const live = readFileBytesNoFollow(plan.targetPath);
      if (hashFileBytes(live.bytes) !== plan.beforeHash) {
        throw new TransactionError('STALE_PREIMAGE', 'Compare-and-swap failed immediately before write.');
      }
      writeAtomicFile(plan.targetPath, plan.afterBytes, plan.mode || 0o644);
      written.push({ file: plan.file, postHash: plan.afterHash });
      appendJournal(transactionDir, {
        action: 'write',
        file: plan.file,
        preHash: plan.beforeHash,
        postHash: plan.afterHash,
      });
      if (failAfterWrite != null && written.length > failAfterWrite) {
        throw new TransactionError('FORCED_FAILURE', 'Forced failure after write.');
      }
    }

    appendJournal(transactionDir, { action: 'commit', files: written.map((entry) => entry.file) });
    return {
      status: 'committed',
      transactionDir,
      written,
    };
  } catch (error) {
    if (written.length > 0) {
      const rollback = await restoreTransactionFiles({
        localRoot: rootCheck.localRoot,
        transactionDir,
      });
      appendJournal(transactionDir, { action: 'rollback', conflicts: rollback.conflicts });
      if (rollback.conflicts.length > 0) {
        return {
          status: 'rollback-conflicted',
          error: error instanceof TransactionError ? error.code : error.code || 'APPLY_FAILED',
          rollback,
          transactionDir,
        };
      }
      return {
        status: 'rolled-back',
        error: error instanceof TransactionError ? error.code : error.code || 'APPLY_FAILED',
        rollback,
        transactionDir,
      };
    }
    if (error instanceof TransactionError) throw error;
    if (error instanceof CandidateIntentError) {
      throw new TransactionError(error.code, error.message);
    }
    throw error;
  } finally {
    if (lock) {
      try {
        releaseWorkspaceLock(lock.lockPath, lock.token);
      } catch {
        // ignore release errors after failed apply
      }
    }
  }
}

/** Backward-compatible single-candidate wrapper. */
export async function applyTransaction(options) {
  return applyBatchTransaction({
    ...options,
    entries: [{
      fixUnitId: options.fixUnitId || null,
      candidate: options.candidate,
      candidateHash: options.candidateHash,
      diffHash: options.diffHash,
      verificationArtifactId: options.verificationArtifactId,
    }],
  });
}

export { appendJournal, snapshotFile, writeAtomicFile };
