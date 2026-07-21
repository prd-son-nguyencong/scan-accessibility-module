import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');

const TEST_TMP_ROOT = path.join(PACKAGE_ROOT, '.tmp-accessscan-corpus-tests');
mkdirSync(TEST_TMP_ROOT, { recursive: true });

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
