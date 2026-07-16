/**
 * Shared CIS redaction policy for probe output and contract fixtures.
 * Non-production — imported by scripts/ and test/ only.
 */

export const REDACTION_PLACEHOLDERS = Object.freeze({
  content: '<redacted-content>',
  requestId: '<redacted-request-id>',
  header: '<redacted>',
  featureKey: '<redacted-feature-key>',
  host: '<redacted-host>',
});

/** @type {{ name: string, pattern: RegExp }[]} */
export const FORBIDDEN_PATTERNS = [
  { name: 'internal-host', pattern: /\bs\d{4}-ml-https\b/i },
  { name: 'internal-host', pattern: /\bawswd\b/i },
  { name: 'internal-host', pattern: /\.us-west-2\./i },
  { name: 'authorization-header', pattern: /\bBearer\s+[A-Za-z0-9._-]{4,}\b/i },
  { name: 'raw-uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  {
    name: 'feature-key-header',
    pattern: /Wd-PCA-Feature-Key\s*[:=]\s*(?!<?redacted)[^\s"'<>]+/i,
  },
  {
    name: 'set-cookie-secret',
    pattern: /set-cookie["']?\s*[:=]\s*["'](?!<?redacted)[^"']+["']/i,
  },
];

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'www-authenticate',
  'wd-pca-feature-key',
]);

const REQUEST_ID_HEADER_NAMES = new Set(['x-request-id', 'request-id', 'x-amzn-requestid', 'x-amz-request-id']);

/**
 * @param {string} serialized
 * @param {string} [label]
 */
export function assertSerializedRedacted(serialized, label = 'artifact') {
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`${label} failed redaction check: forbidden pattern ${name}`);
    }
  }
}

/** @param {string} content @param {string} label */
export function assertBundleRedacted(content, label) {
  assertSerializedRedacted(content, label);
}

/**
 * @param {Headers | Map<string, string> | Record<string, string>} headers
 */
export function redactHeaders(headers) {
  const entries =
    headers instanceof Map
      ? headers.entries()
      : headers instanceof Headers
        ? headers.entries()
        : Object.entries(headers);

  const redacted = {};
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower)) {
      redacted[lower] =
        lower === 'wd-pca-feature-key' ? REDACTION_PLACEHOLDERS.featureKey : REDACTION_PLACEHOLDERS.header;
    } else if (REQUEST_ID_HEADER_NAMES.has(lower) || lower.includes('request-id')) {
      redacted[lower] = REDACTION_PLACEHOLDERS.requestId;
    } else if (typeof value === 'string') {
      redacted[lower] = sanitizeString(value);
    } else {
      redacted[lower] = REDACTION_PLACEHOLDERS.header;
    }
  }
  return redacted;
}

/**
 * @param {unknown} body
 */
export function redactProbeBody(body) {
  return redactValue(body, []);
}

/**
 * @param {Record<string, unknown>} result
 */
export function redactProbeResponse(result) {
  const redacted = { ...result };
  if (result.headers) {
    redacted.headers = redactHeaders(result.headers);
  }
  if (Object.prototype.hasOwnProperty.call(result, 'body')) {
    redacted.body = result.body == null ? null : redactProbeBody(result.body);
  }
  return redacted;
}

/**
 * @param {unknown} artifact
 */
export function serializeRedactedArtifact(artifact) {
  const serialized = JSON.stringify(artifact, null, 2);
  assertSerializedRedacted(serialized);
  return serialized;
}

/**
 * @param {unknown} value
 * @param {(string | number)[]} pathParts
 */
function redactValue(value, pathParts) {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...pathParts, index]));
  }

  if (typeof value === 'object') {
  /** @type {Record<string, unknown>} */
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const nextPath = [...pathParts, key];
      if (shouldRedactField(pathParts, key)) {
        output[key] = placeholderForField(key);
      } else {
        output[key] = redactValue(child, nextPath);
      }
    }
    return output;
  }

  if (typeof value === 'string') {
    if (shouldRedactField(pathParts, pathParts.at(-1))) {
      return placeholderForField(String(pathParts.at(-1)));
    }
    return sanitizeString(value);
  }

  return value;
}

/**
 * @param {(string | number)[]} pathParts
 * @param {string | number | undefined} key
 */
function shouldRedactField(pathParts, key) {
  if (key === '_preview') return true;

  const parentPath = pathParts.map(String).join('.');

  if (key === 'content' && /\.choices\.\d+\.message$/.test(parentPath)) return true;
  if (key === 'text' && /\.choices\.\d+\.message$/.test(parentPath)) return true;
  if (key === 'reasoning_content' && parentPath.includes('message')) return true;
  if (key === 'id' && (parentPath.includes('output') || parentPath.endsWith('prediction'))) return true;

  return false;
}

/** @param {string | number | undefined} key */
function placeholderForField(key) {
  if (key === 'id') return REDACTION_PLACEHOLDERS.requestId;
  return REDACTION_PLACEHOLDERS.content;
}

/** @param {string} value */
function sanitizeString(value) {
  const hadForbidden = FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(value));

  let sanitized = value
    .replace(/\bs\d{4}-ml-https[^\s]*/gi, REDACTION_PLACEHOLDERS.host)
    .replace(/\b[\w.-]+\.awswd\b/gi, REDACTION_PLACEHOLDERS.host)
    .replace(/\.us-west-2\.[\w.-]+/gi, REDACTION_PLACEHOLDERS.host)
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, REDACTION_PLACEHOLDERS.header)
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      REDACTION_PLACEHOLDERS.requestId,
    );

  if (hadForbidden || FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(sanitized))) {
    return REDACTION_PLACEHOLDERS.content;
  }

  return sanitized;
}
