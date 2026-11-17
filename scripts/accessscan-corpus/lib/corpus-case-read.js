import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { resolveCorpusCaseDir } from './corpus-case-dir.js';

/**
 * @param {string} caseDir
 * @param {string} corpusRoot
 * @returns {string}
 */
export function reassertSafeCorpusCaseDir(caseDir, corpusRoot) {
  const resolvedRoot = path.resolve(corpusRoot);
  const resolvedCaseDir = path.resolve(caseDir);
  const caseId = path.basename(resolvedCaseDir);
  const expected = resolveCorpusCaseDir(resolvedRoot, caseId);

  if (resolvedCaseDir !== expected) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      'Corpus case directory resolved outside expected cases root',
      { caseId },
    );
  }

  if (!existsSync(resolvedCaseDir)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      `Corpus case directory does not exist: ${caseId}`,
      { caseId },
    );
  }

  const casesRoot = path.join(resolvedRoot, 'cases');
  const realCasesRoot = realpathSync(casesRoot);
  const realCaseDir = realpathSync(resolvedCaseDir);
  if (realCaseDir !== realCasesRoot && !realCaseDir.startsWith(`${realCasesRoot}${path.sep}`)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      'Corpus case symlink escape detected during read',
      { caseId },
    );
  }

  return realCaseDir;
}

/**
 * @param {string} caseDir
 * @param {string} relativePath
 * @param {string} corpusRoot
 * @param {{ encoding?: BufferEncoding }=} options
 */
export function readCorpusCaseFile(caseDir, relativePath, corpusRoot, options = {}) {
  const safeCaseDir = reassertSafeCorpusCaseDir(caseDir, corpusRoot);
  const target = path.resolve(safeCaseDir, relativePath);
  const expectedPrefix = `${safeCaseDir}${path.sep}`;
  if (target !== safeCaseDir && !target.startsWith(expectedPrefix)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      'Corpus case file path traversal is forbidden',
      { relativePath },
    );
  }
  return readFileSync(target, options.encoding || 'utf8');
}

/**
 * @param {string} caseDir
 * @param {string} corpusRoot
 */
export function readCorpusCaseJson(caseDir, relativePath, corpusRoot) {
  return JSON.parse(readCorpusCaseFile(caseDir, relativePath, corpusRoot));
}
