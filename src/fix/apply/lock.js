import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class WorkspaceLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceLockError';
    this.code = code;
  }
}

const LOCK_NAME = '.ada-fix.apply.lock';
const { O_WRONLY, O_CREAT, O_EXCL, O_RDONLY, O_NOFOLLOW } = constants;

function readLockRecord(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export function acquireWorkspaceLock(localRoot) {
  const lockPath = join(localRoot, LOCK_NAME);
  const token = randomBytes(16).toString('hex');
  const record = { token, pid: process.pid, acquiredAt: new Date().toISOString() };
  try {
    const fd = openSync(lockPath, O_WRONLY | O_CREAT | O_EXCL, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { lockPath, token };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readLockRecord(lockPath);
    if (existing && !pidAlive(existing.pid)) {
      try {
        unlinkSync(lockPath);
      } catch {
        throw new WorkspaceLockError('LOCK_CONTENTION', 'Unable to reclaim stale workspace lock.');
      }
      return acquireWorkspaceLock(localRoot);
    }
    throw new WorkspaceLockError(
      'LOCK_CONTENTION',
      existing?.pid
        ? `Another apply transaction holds the workspace lock (pid ${existing.pid}). Wait for it to finish or terminate that process if it is stale.`
        : 'Another apply transaction holds the workspace lock.',
    );
  }
}

export function releaseWorkspaceLock(lockPath, token) {
  if (!lockPath || !existsSync(lockPath)) return;
  const existing = readLockRecord(lockPath);
  if (!existing || existing.token !== token) {
    throw new WorkspaceLockError('LOCK_TOKEN_MISMATCH', 'Workspace lock token mismatch on release.');
  }
  unlinkSync(lockPath);
}

export { LOCK_NAME };
