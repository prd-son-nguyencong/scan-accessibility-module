import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { validateManifestCaseId } from './source-url-policy.js';

/**
 * @param {string} corpusRoot
 * @param {string} caseId
 * @returns {string}
 */
export function resolveCorpusCaseDir(corpusRoot, caseId) {
  const normalizedCaseId = validateManifestCaseId(caseId);
  const resolvedRoot = path.resolve(corpusRoot);
  const casesRoot = path.join(resolvedRoot, 'cases');
  const caseDir = path.join(casesRoot, normalizedCaseId);
  const resolvedCaseDir = path.resolve(caseDir);

  if (resolvedCaseDir !== caseDir) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      'Corpus case path resolved outside cases root',
      { caseId: normalizedCaseId },
    );
  }

  const expectedPrefix = `${casesRoot}${path.sep}`;
  if (!resolvedCaseDir.startsWith(expectedPrefix) && resolvedCaseDir !== casesRoot) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
      'Corpus case path traversal is forbidden',
      { caseId: normalizedCaseId },
    );
  }

  if (existsSync(resolvedCaseDir)) {
    const realCasesRoot = realpathSync(casesRoot);
    const realCaseDir = realpathSync(resolvedCaseDir);
    if (realCaseDir !== realCasesRoot && !realCaseDir.startsWith(`${realCasesRoot}${path.sep}`)) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
        'Corpus case symlink escape is forbidden',
        { caseId: normalizedCaseId },
      );
    }
  }

  return resolvedCaseDir;
}
