import { normalizeHtml } from '../../../src/reporter/fingerprint.js';
import {
  CORPUS_FORBIDDEN_TOKENS,
  CORPUS_SCHEMA_VERSION,
} from '../../../src/scanner/access-scan/corpus/constants.js';
import { containsHostLeakage } from '../../../src/scanner/access-scan/corpus/sanitization.js';
import {
  isGeneratedIdRef,
  normalizeSemanticAttributes,
} from '../../../src/scanner/access-scan/corpus/semantic-fingerprint.js';
import {
  containsPartialRedactionMarker,
} from './text-pseudonymization.js';
import {
  neutralizeEvidenceUrl,
  pseudonymizeCommittedTextValue,
  pseudonymizeHtmlTextContent,
  pseudonymizeHumanText,
} from './text-pseudonymization.js';
import {
  buildOuterHtmlFromAttributes,
  filterAllowlistedReplayAttributes,
  findCommittedAttributeViolations,
  findSnapshotAttributeViolations,
  isMalformedSerializedAttributeValue,
  isReplayEssentialAttribute,
  parseElementOuterHtmlStructure,
  stripNonAllowlistedAttributesFromHtml,
} from '../../../src/scanner/access-scan/corpus/attribute-allowlist.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';

const VOLATILE_SELECTOR_ID_PATTERN = /#[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*/gi;
const VOLATILE_HTML_ID_PATTERN = /\sid=["']([^"']+)["']/gi;
const VOLATILE_HTML_CLASS_PATTERN = /\sclass=["']([^"']+)["']/gi;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"']+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

/**
 * @param {string} value
 * @returns {string}
 */
function stripHosts(value = '') {
  return String(value)
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?/gi, '')
    .replace(/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/gi, '')
    .replace(/https?:\/\/(?:[a-z0-9.-]+\.)+[a-z]{2,}(?::\d+)?/gi, '')
    .replace(/\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?/gi, '')
    .replace(/\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/gi, '')
    .replace(/\/\/(?:[a-z0-9.-]+\.)+[a-z]{2,}(?::\d+)?/gi, '')
    .replace(/\b(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?/gi, '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/gi, '')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?=\/|\?|#|$)/gi, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactSecrets(value = '') {
  let output = String(value);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match) => pseudonymizeHumanText(match, 'secret'));
  }
  return output;
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactForbiddenTokens(value = '') {
  let output = String(value);
  for (const token of CORPUS_FORBIDDEN_TOKENS) {
    const pattern = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    output = output.replace(pattern, (match) => pseudonymizeHumanText(match, 'token'));
  }
  return output;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function sanitizeTextValue(value = '') {
  const redacted = redactForbiddenTokens(redactSecrets(stripHosts(String(value))))
    .replace(/\[redacted\]/gi, '')
    .replace(TIMESTAMP_PATTERN, '[timestamp]');
  return pseudonymizeCommittedTextValue(redacted);
}

/**
 * @param {string} selector
 * @returns {string}
 */
export function sanitizeSelector(selector = '') {
  return stripHosts(redactForbiddenTokens(redactSecrets(String(selector))))
    .replace(VOLATILE_SELECTOR_ID_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} html
 * @returns {string}
 */
export function sanitizeOuterHtml(html = '') {
  let output = redactForbiddenTokens(redactSecrets(stripHosts(normalizeHtml(String(html)))));
  output = output.replace(VOLATILE_HTML_ID_PATTERN, (match, idValue) => (
    isGeneratedIdRef(idValue) ? '' : match
  ));
  output = output.replace(VOLATILE_HTML_CLASS_PATTERN, '');
  output = stripNonAllowlistedAttributesFromHtml(output);
  output = output.replace(/\s(?:href|src|xlink:href)\s*=\s*(["'])([^"']*)\1/gi, (match, quote, url) => {
    const attr = match.trim().split('=')[0].trim();
    return ` ${attr}=${quote}${neutralizeEvidenceUrl(url)}${quote}`;
  });
  output = pseudonymizeHtmlTextContent(output);
  return output.replace(TIMESTAMP_PATTERN, '[timestamp]');
}

/**
 * @param {string} outerHTML
 * @param {Record<string, string>} attributes
 * @returns {string}
 */
export function reconcileOuterHtmlWithAttributes(outerHTML = '', attributes = {}) {
  const sanitizedOuter = sanitizeOuterHtml(outerHTML);
  const structure = parseElementOuterHtmlStructure(sanitizedOuter);
  const tag = structure.tag === 'unknown'
    ? String(sanitizedOuter.match(/^<\s*([a-z0-9-]+)/i)?.[1] || 'unknown').toLowerCase()
    : structure.tag;
  return buildOuterHtmlFromAttributes(
    tag,
    attributes,
    structure.innerHtml,
    structure.selfClosing && !structure.innerHtml,
  );
}

/**
 * @param {Record<string, string>} attributes
 * @returns {Record<string, string>}
 */
export function sanitizeAttributes(attributes = {}) {
  /** @type {Record<string, string>} */
  const output = {};
  for (const [name, value] of Object.entries(attributes)) {
    const lower = name.toLowerCase();
    if (['id', 'class', 'style', 'data-testid', 'data-test', 'data-cy', 'data-qa'].includes(lower)) {
      continue;
    }
    if (lower.startsWith('on')) continue;
    if (!isReplayEssentialAttribute(lower, String(value ?? ''))) continue;
    const sanitized = sanitizeTextValue(String(value));
    if (isMalformedSerializedAttributeValue(sanitized)) continue;
    if (lower === 'href' || lower === 'src' || lower === 'xlink:href') {
      output[lower] = neutralizeEvidenceUrl(sanitizeTextValue(String(value)));
      continue;
    }
    if (isGeneratedIdRef(sanitized)) continue;
    if (sanitized.length > 0) output[lower] = sanitized;
  }
  return filterAllowlistedReplayAttributes(output);
}

/**
 * @param {Record<string, unknown>} element
 * @returns {Record<string, unknown>}
 */
export function sanitizeSnapshotElement(element = {}) {
  const attributes = sanitizeAttributes(
    /** @type {Record<string, string>} */ (element.attributes || {}),
  );
  const outerHTML = reconcileOuterHtmlWithAttributes(
    String(element.outerHTML || ''),
    attributes,
  );
  return {
    ...element,
    attributes,
    text: sanitizeTextValue(String(element.text || '')),
    visibleText: sanitizeTextValue(String(element.visibleText || '')),
    accessibleName: sanitizeTextValue(String(element.accessibleName || '')),
    selector: sanitizeSelector(String(element.selector || '')),
    reportSelector: sanitizeSelector(String(element.reportSelector || '')),
    outerHTML,
    computedStyle: element.computedStyle && typeof element.computedStyle === 'object'
      ? Object.fromEntries(
        Object.entries(element.computedStyle).map(([key, value]) => [key, sanitizeTextValue(String(value))]),
      )
      : {},
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {Record<string, unknown>}
 */
export function sanitizeSnapshot(snapshot = {}) {
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements.map((element) => sanitizeSnapshotElement(/** @type {Record<string, unknown>} */ (element)))
    : [];
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    elements,
    diagnostics: Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [],
    counts: snapshot.counts && typeof snapshot.counts === 'object'
      ? {
        frameCount: Number(snapshot.counts.frameCount || 0),
        shadowRootCount: Number(snapshot.counts.shadowRootCount || 0),
        closedShadowCount: Number(snapshot.counts.closedShadowCount || 0),
      }
      : { frameCount: 0, shadowRootCount: 0, closedShadowCount: 0 },
  };
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {string[]}
 */
export function findRedactionLeaks(text = '', label = 'payload') {
  /** @type {string[]} */
  const leaks = [];
  const haystack = String(text).toLowerCase();
  for (const token of CORPUS_FORBIDDEN_TOKENS) {
    if (haystack.includes(token.toLowerCase())) {
      leaks.push(`${label} contains forbidden token "${token}"`);
    }
  }
  if (containsPartialRedactionMarker(text)) {
    leaks.push(`${label} contains partial redaction marker`);
  }
  if (containsHostLeakage(text)) {
    leaks.push(`${label} contains host or URL leakage`);
  }
  if (label.endsWith('.html')) {
    leaks.push(...findCommittedAttributeViolations(text, label));
  }
  return leaks;
}

export { findSnapshotAttributeViolations };

/**
 * @param {Record<string, unknown>} caseFiles
 */
export function assertNoRedactionLeaks(caseFiles = {}) {
  /** @type {string[]} */
  const leaks = [];
  for (const [name, value] of Object.entries(caseFiles)) {
    if (typeof value === 'string') {
      leaks.push(...findRedactionLeaks(value, name));
    }
  }
  if (leaks.length > 0) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.REDACTION_LEAK,
      leaks[0],
      { leaks },
    );
  }
}

/**
 * @param {string} entry
 * @returns {string}
 */
function sanitizeLandmarkPathEntry(entry = '') {
  const text = String(entry).trim();
  if (!text) return text;
  const normalized = text.toLowerCase();
  if (['main', 'header', 'footer', 'nav', 'body', 'html'].includes(normalized)) {
    return text;
  }
  if (/^section\[slice-\d+\]$/i.test(text)) {
    return text;
  }
  return sanitizeTextValue(text);
}

/**
 * @param {Record<string, unknown>} semantic
 * @returns {Record<string, unknown>}
 */
export function sanitizeSemanticDescriptor(semantic = {}) {
  return {
    tag: String(semantic.tag || 'unknown'),
    role: semantic.role == null ? null : sanitizeTextValue(String(semantic.role)),
    attributes: normalizeSemanticAttributes(
      sanitizeAttributes(/** @type {Record<string, string>} */ (semantic.attributes || {})),
    ),
    landmarkPath: Array.isArray(semantic.landmarkPath)
      ? semantic.landmarkPath.map((entry) => sanitizeLandmarkPathEntry(String(entry)))
      : [],
    ...(Number.isInteger(semantic.ordinal) && semantic.ordinal >= 0 ? { ordinal: semantic.ordinal } : {}),
    ...(typeof semantic.disambiguator === 'string' && semantic.disambiguator.length > 0
      ? { disambiguator: sanitizeTextValue(semantic.disambiguator) }
      : {}),
    framePath: Array.isArray(semantic.framePath) ? [...semantic.framePath] : [],
    shadowPath: Array.isArray(semantic.shadowPath) ? [...semantic.shadowPath] : [],
  };
}
