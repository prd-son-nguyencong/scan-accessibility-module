import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');

/** @type {string | null} */
let committedFixtureRootOverride = null;

/**
 * @param {string | null} root
 */
export function setCommittedFixtureRootForTests(root) {
  committedFixtureRootOverride = root;
}

export function resetCommittedFixtureRootForTests() {
  committedFixtureRootOverride = null;
}

/**
 * @returns {string}
 */
export function getCommittedFixtureRoot() {
  return committedFixtureRootOverride
    || path.join(PACKAGE_ROOT, 'test/fixtures/accessscan-corpus');
}

/**
 * @returns {string}
 */
function getCommittedFixtureRealRoot() {
  return realpathSync(path.resolve(getCommittedFixtureRoot()));
}

/**
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
function isPathUnderRoot(candidate, root) {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

/**
 * @param {string} absolute
 * @returns {string}
 */
function findNearestExistingPrefix(absolute) {
  let current = absolute;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/**
 * Fail closed when the resolved nearest-existing prefix is inside committed corpus.
 *
 * @param {string} targetPath
 * @returns {string}
 */
export function assertResolvedOutsideCommittedRoot(targetPath) {
  const absolute = path.resolve(targetPath);
  const committedReal = getCommittedFixtureRealRoot();

  if (isPathUnderRoot(absolute, committedReal)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      `Draft output cannot target committed fixture root: ${absolute}`,
      { targetPath: absolute, committedRoot: committedReal },
    );
  }

  const existingPrefix = findNearestExistingPrefix(absolute);
  if (!existsSync(existingPrefix)) {
    return absolute;
  }

  const realPrefix = realpathSync(existingPrefix);
  if (isPathUnderRoot(realPrefix, committedReal)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      `Draft output resolves under committed fixture root: ${realPrefix}`,
      { targetPath: absolute, committedRoot: committedReal, realPrefix },
    );
  }

  return absolute;
}

/**
 * @param {string} targetDir
 * @returns {string}
 */
export function resolveDraftDir(targetDir) {
  return assertResolvedOutsideCommittedRoot(targetDir);
}

/**
 * Re-resolve the nearest existing parent immediately before draft writes.
 *
 * @param {string} targetDir
 * @returns {string}
 */
export function reassertDraftPathSafe(targetDir) {
  return assertResolvedOutsideCommittedRoot(targetDir);
}
