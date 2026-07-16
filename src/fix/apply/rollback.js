import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashFileBytes } from '../candidate/intent.js';
import { validateRelativeCandidatePath } from '../candidate/path.js';
import { assertPathContainedInRoot, resolveTrustedRoot } from '../controller/local-attestation.js';

export class RollbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RollbackError';
    this.code = code;
  }
}

const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_JOURNAL_LINES = 500;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

/** Internal test hooks — not request-controlled. */
export const __rollbackTestHooks = {
  renameSync: null,
};

function renameFile(fromPath, toPath) {
  const renameFn = __rollbackTestHooks.renameSync || renameSync;
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

function fsyncDirectory(dirPath) {
  const fd = openSync(dirPath, O_RDONLY | O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readBoundedFileNoFollow(filePath, maxBytes) {
  const fd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new RollbackError('JOURNAL_INVALID', 'Journal or snapshot exceeds allowed size.');
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, null);
      if (read === 0) {
        throw new RollbackError('JOURNAL_INVALID', 'Incomplete journal or snapshot read.');
      }
      offset += read;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function validateWriteEvent(event, seenFiles) {
  if (!event || typeof event !== 'object' || event.action !== 'write') {
    throw new RollbackError('JOURNAL_INVALID', 'Invalid journal write event.');
  }
  if (typeof event.file !== 'string' || !event.file) {
    throw new RollbackError('JOURNAL_INVALID', 'Journal write event missing file.');
  }
  const file = validateRelativeCandidatePath(event.file);
  if (seenFiles.has(file)) {
    throw new RollbackError('JOURNAL_DUPLICATE', 'Duplicate journal write events for the same file.');
  }
  seenFiles.add(file);
  if (!SHA256_PATTERN.test(event.preHash || '') || !SHA256_PATTERN.test(event.postHash || '')) {
    throw new RollbackError('JOURNAL_INVALID', 'Journal write event hashes are invalid.');
  }
  return { ...event, file };
}

function parseJournal(transactionDir) {
  const journalPath = join(transactionDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return [];
  const raw = readBoundedFileNoFollow(journalPath, MAX_JOURNAL_BYTES).toString('utf8');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length > MAX_JOURNAL_LINES) {
    throw new RollbackError('JOURNAL_INVALID', 'Journal exceeds allowed line count.');
  }
  const seenFiles = new Set();
  return lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new RollbackError('JOURNAL_INVALID', `Journal line ${index} is not valid JSON.`);
    }
    if (parsed.action === 'write') return validateWriteEvent(parsed, seenFiles);
    return parsed;
  });
}

function assertSnapshotContained(transactionDir, file) {
  const snapshotPath = resolve(transactionDir, 'snapshots', file);
  const contained = assertPathContainedInRoot(join(transactionDir, 'snapshots'), snapshotPath);
  if (!contained.ok) {
    throw new RollbackError('SNAPSHOT_PATH_ESCAPE', 'Snapshot path escapes transaction directory.');
  }
  return contained.resolvedPath;
}

function atomicRestore(targetPath, bytes, mode) {
  const dir = dirname(targetPath);
  const tempPath = `${targetPath}.${randomBytes(6).toString('hex')}.rollback`;
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
    try {
      chmodSync(targetPath, mode);
    } catch {
      // ignore
    }
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

export async function restoreTransactionFiles({
  localRoot,
  transactionDir,
}) {
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new RollbackError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root unavailable.');
  }

  const events = parseJournal(transactionDir).filter((event) => event.action === 'write');
  const conflicts = [];
  const restored = [];

  for (const event of events) {
    const file = event.file;
    let targetPath;
    try {
      const contained = assertPathContainedInRoot(rootCheck.localRoot, resolve(rootCheck.localRoot, file));
      if (!contained.ok) {
        conflicts.push({ file, reason: 'PATH_TRAVERSAL' });
        continue;
      }
      targetPath = contained.resolvedPath;
    } catch {
      conflicts.push({ file, reason: 'PATH_TRAVERSAL' });
      continue;
    }

    let snapshotPath;
    try {
      snapshotPath = assertSnapshotContained(transactionDir, file);
    } catch {
      conflicts.push({ file, reason: 'SNAPSHOT_PATH_ESCAPE' });
      continue;
    }
    if (!existsSync(snapshotPath)) {
      conflicts.push({ file, reason: 'SNAPSHOT_MISSING' });
      continue;
    }

    let snapshotBytes;
    try {
      snapshotBytes = readBoundedFileNoFollow(snapshotPath, MAX_SNAPSHOT_BYTES);
    } catch {
      conflicts.push({ file, reason: 'SNAPSHOT_READ_FAILED' });
      continue;
    }
    const snapshotHash = hashFileBytes(snapshotBytes);
    if (snapshotHash !== event.preHash) {
      conflicts.push({ file, reason: 'SNAPSHOT_HASH_MISMATCH' });
      continue;
    }

    let currentHash = null;
    if (existsSync(targetPath)) {
      try {
        currentHash = hashFileBytes(readBoundedFileNoFollow(targetPath, MAX_SNAPSHOT_BYTES));
      } catch {
        conflicts.push({ file, reason: 'CURRENT_READ_FAILED' });
        continue;
      }
    }
    if (currentHash && currentHash !== event.postHash) {
      conflicts.push({ file, reason: 'CONCURRENT_EDIT', currentHash, expectedPostHash: event.postHash });
      continue;
    }

    const mode = existsSync(targetPath) ? (lstatSync(targetPath).mode & 0o777) : 0o644;
    try {
      atomicRestore(targetPath, snapshotBytes, mode || 0o644);
      restored.push({ file, restoredHash: snapshotHash });
    } catch {
      conflicts.push({ file, reason: 'RESTORE_FAILED' });
    }
  }

  return { restored, conflicts };
}

export async function rollbackTransaction(options) {
  return restoreTransactionFiles(options);
}

export { parseJournal, readBoundedFileNoFollow, atomicRestore };
