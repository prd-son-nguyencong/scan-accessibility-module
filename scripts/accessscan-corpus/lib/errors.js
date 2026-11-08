export const CORPUS_TOOLING_ERROR_CODES = Object.freeze({
  INCOMPLETE_REPORT: 'incomplete_report',
  UNSTABLE_CAPTURE: 'unstable_capture',
  UNKNOWN_ALIAS: 'unknown_alias',
  REDACTION_LEAK: 'redaction_leak',
  AMBIGUOUS_ALIGNMENT: 'ambiguous_alignment',
  SCHEMA_FAILURE: 'schema_failure',
  FORBIDDEN_OUTPUT_ROOT: 'forbidden_output_root',
  OUTPUT_EXISTS: 'output_exists',
  NO_MATCH: 'no_match',
  UNSUPPORTED_PAGE_STATE: 'unsupported_page_state',
  REPLAY_IMPOSSIBLE: 'replay_impossible',
  FORBIDDEN_SOURCE_URL: 'forbidden_source_url',
});

export class CorpusToolingError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>=} details
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CorpusToolingError';
    this.errorCode = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * @param {unknown} error
 * @returns {error is CorpusToolingError}
 */
export function isCorpusToolingError(error) {
  return error instanceof CorpusToolingError;
}
