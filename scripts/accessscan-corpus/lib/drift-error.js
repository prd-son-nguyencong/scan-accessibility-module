import { sanitizeTextValue } from './sanitize.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES, isCorpusToolingError } from './errors.js';

const HOST_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const SECRET_PATTERN = /(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+/gi;

/**
 * @param {string} value
 * @returns {string}
 */
export function sanitizeDiagnosticText(value = '') {
  let output = String(value);
  output = output.replace(URL_PATTERN, '[redacted-url]');
  output = output.replace(HOST_PATTERN, '[redacted-host]');
  output = output.replace(IPV4_PATTERN, '[redacted-ip]');
  output = output.replace(SECRET_PATTERN, '[redacted-secret]');
  return sanitizeTextValue(output);
}

/**
 * @param {unknown} error
 * @returns {{ errorCode: string, message: string }}
 */
export function normalizeSanitizedDriftError(error) {
  if (isCorpusToolingError(error)) {
    return {
      errorCode: error.errorCode,
      message: sanitizeDiagnosticText(error.message),
    };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(rawMessage)) {
    return {
      errorCode: 'navigation_timeout',
      message: 'Live capture timed out before stabilization',
    };
  }

  if (/net::|ENOTFOUND|ECONNREFUSED|blockedbyclient/i.test(rawMessage)) {
    return {
      errorCode: 'network_failure',
      message: 'Live capture failed during reviewed network navigation',
    };
  }

  return {
    errorCode: 'capture_failure',
    message: sanitizeDiagnosticText('Live capture failed before drift comparison'),
  };
}

/**
 * @param {string} stderr
 * @returns {string}
 */
export function sanitizeDriftStderr(stderr = '') {
  return sanitizeDiagnosticText(stderr).trim();
}

/**
 * @param {Record<string, unknown>} payload
 */
export function assertNeutralDriftArtifact(payload = {}) {
  const serialized = JSON.stringify(payload);
  if (/outerHTML|sourceUrl|Bearer\s+|api[_-]?key/i.test(serialized)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.REDACTION_LEAK,
      'Drift artifact leaked sensitive capture details',
    );
  }
  if (/paradox\.ai|mchire\.com|https?:\/\//i.test(serialized)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.REDACTION_LEAK,
      'Drift artifact leaked source host or URL details',
    );
  }
}
