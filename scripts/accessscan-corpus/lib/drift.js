import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  compareCorpusFindings,
} from '../../../src/scanner/access-scan/corpus/diff.js';
import {
  validateCorpusCase,
} from '../../../src/scanner/access-scan/corpus/schema.js';
import { alignFindingsToSnapshot } from './align.js';
import { readCorpusCaseJson } from './corpus-case-read.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import {
  ingestAccessScanReport,
  normalizeReportFindings,
} from './ingest.js';
import { getCommittedFixtureRoot } from './paths.js';
import { buildSnapshotIdentity } from './snapshot-identity.js';
import { sanitizeSnapshot } from './sanitize.js';

/**
 * @typedef {object} DriftRequest
 * @property {string} caseId
 * @property {string=} corpusRoot
 * @property {Record<string, unknown>=} snapshot
 * @property {Record<string, unknown>=} report
 * @property {Record<string, unknown>[]=} actualFindings
 */

/**
 * @param {DriftRequest} request
 */
export async function evaluateCorpusDrift(request) {
  const corpusRoot = path.resolve(request.corpusRoot || getCommittedFixtureRoot());
  const manifest = JSON.parse(readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8'));
  const entry = manifest.cases.find((caseEntry) => caseEntry.id === request.caseId);
  if (!entry) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      `Unknown corpus case id: ${request.caseId}`,
      { caseId: request.caseId },
    );
  }

  const caseDir = path.join(corpusRoot, entry.path);
  const validation = validateCorpusCase(caseDir);
  if (!validation.ok) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      validation.errors[0],
      { errors: validation.errors },
    );
  }

  const committedSnapshot = sanitizeSnapshot(
    readCorpusCaseJson(caseDir, 'snapshot.json', corpusRoot),
  );
  const committedExpected = readCorpusCaseJson(caseDir, 'expected.json', corpusRoot);
  const candidateSnapshot = request.snapshot
    ? sanitizeSnapshot(request.snapshot)
    : null;

  /** @type {Record<string, unknown>[]} */
  let candidateFindings = request.actualFindings || [];
  if (request.report && candidateSnapshot) {
    const report = ingestAccessScanReport(request.report);
    const normalizedFindings = await normalizeReportFindings(report);
    candidateFindings = alignFindingsToSnapshot(candidateSnapshot, normalizedFindings);
  }

  const diff = compareCorpusFindings(
    Array.isArray(committedExpected.findings) ? committedExpected.findings : [],
    candidateFindings,
  );

  const snapshotDrift = candidateSnapshot
    ? buildSnapshotIdentity(committedSnapshot) !== buildSnapshotIdentity(candidateSnapshot)
    : false;

  return {
    ok: !snapshotDrift && diff.equivalent,
    caseId: request.caseId,
    caseDir,
    snapshotDrift,
    snapshotIdentity: {
      committed: buildSnapshotIdentity(committedSnapshot),
      candidate: candidateSnapshot ? buildSnapshotIdentity(candidateSnapshot) : null,
    },
    findingsEquivalent: diff.equivalent,
    diff,
  };
}
