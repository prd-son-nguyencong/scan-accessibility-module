import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-process root in the OS temp dir, removed on exit so nothing lands in the worktree.
const TEST_TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'ada-corpus-tests-'));
process.on('exit', () => rmSync(TEST_TMP_ROOT, { recursive: true, force: true }));

/**
 * @param {string} prefix
 * @returns {string}
 */
export function createTestTempDir(prefix) {
  return mkdtempSync(path.join(TEST_TMP_ROOT, prefix));
}

/**
 * @returns {NodeJS.ProcessEnv}
 */
export function testSubprocessEnv() {
  return {
    ...process.env,
    TMPDIR: TEST_TMP_ROOT,
  };
}
