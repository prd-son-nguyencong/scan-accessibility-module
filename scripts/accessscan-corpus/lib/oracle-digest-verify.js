import { buildCorpusReportFromOracle, buildCorpusReportFromOracleFile } from './oracle-report.js';
import { buildOracleEvidenceDigest } from './oracle-digest.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';

/**
 * @param {unknown} payload
 * @param {string} expectedDigest
 * @returns {{ ok: true, digest: string }}
 */
export function verifyOracleEvidenceDigest(payload, expectedDigest) {
  const oracle = typeof payload === 'string'
    ? buildCorpusReportFromOracleFile(payload)
    : buildCorpusReportFromOracle(payload);
  const digest = buildOracleEvidenceDigest(oracle.report);

  if (digest !== expectedDigest) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      'Oracle evidence digest mismatch; recapture verification failed closed',
      {
        expectedDigest,
        actualDigest: digest,
        recaptureRequired: true,
      },
    );
  }

  return { ok: true, digest };
}
