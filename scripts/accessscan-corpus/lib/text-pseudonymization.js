import { canonicalSha256 } from '../../../src/reporter/fingerprint.js';

/** @type {ReadonlySet<string>} */
export const FRAMEWORK_NEUTRAL_LITERALS = new Set([
  '',
  'home',
  'neutral evidence slice',
  'neutral page title',
  'neutral header',
  'neutral navigation',
  'neutral footer',
  'utf-8',
  'width=device-width, initial-scale=1',
]);

const SEMANTIC_TEXT_ATTRIBUTES = [
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'alt',
  'title',
  'placeholder',
  'value',
  'content',
  'aria-description',
  'aria-roledescription',
];

const TOKENIZED_SEMANTIC_ATTRIBUTES = new Set([
  'aria-labelledby',
  'aria-describedby',
]);

const STRUCTURAL_HTML_ONLY_PATTERN = /^<(?:meta|link|base|br|hr|img|input|area|col|embed|source|track|wbr)(?:\s[^>]*)?\/?>$/i;
const DOCUMENT_SHELL_PATTERN = /^<!doctype\s+html>$/i;
const HTML_MARKUP_ONLY_PATTERN = /^<\/?[a-z][^>]*>$/i;

const PARTIAL_REDACTION_PATTERN = /\[redacted\]/i;
const LOOPBACK_HOST_PATTERN = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isFrameworkNeutralLiteral(value = '') {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return true;
  if (FRAMEWORK_NEUTRAL_LITERALS.has(normalized)) return true;
  if (/^slice-\d+$/.test(normalized)) return true;
  return false;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isNeutralPlaceholderText(value = '') {
  const normalized = String(value).trim();
  if (!normalized) return true;
  if (isFrameworkNeutralLiteral(normalized)) return true;
  return /^neutral(?:-(?:[a-z]+(?:-[a-z]+)*))?-\d+(?:-[a-f0-9]{8})?$/i.test(normalized)
    || /^\/neutral(?:-(?:[a-z]+(?:-[a-z]+)*))?-\d+(?:-[a-f0-9]{8})?$/i.test(normalized);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function containsPartialRedactionMarker(value = '') {
  return PARTIAL_REDACTION_PATTERN.test(String(value));
}

/**
 * @param {string} value
 * @returns {string[]}
 */
export function extractHumanReadableStrings(value = '') {
  /** @type {string[]} */
  const results = [];
  const text = String(value);

  for (const attribute of SEMANTIC_TEXT_ATTRIBUTES) {
    const doubleQuoted = new RegExp(`\\s${attribute}\\s*=\\s*"([^"]*)"`, 'gi');
    const singleQuoted = new RegExp(`\\s${attribute}\\s*=\\s*'([^']*)'`, 'gi');
    for (const match of text.matchAll(doubleQuoted)) {
      results.push(match[1]);
    }
    for (const match of text.matchAll(singleQuoted)) {
      results.push(match[1]);
    }
  }

  for (const match of text.matchAll(/>([^<]+)</g)) {
    results.push(match[1]);
  }

  return results;
}

/** @type {ReadonlySet<string>} */
export const FRAMEWORK_NEUTRAL_WORDS = new Set([
  'neutral',
  'evidence',
  'slice',
  'header',
  'navigation',
  'footer',
  'page',
  'title',
  'home',
  'main',
]);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isNeutralToken(value = '') {
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  if (isNeutralCommittedString(trimmed)) return true;
  return FRAMEWORK_NEUTRAL_WORDS.has(trimmed.toLowerCase());
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isNeutralCommittedString(value = '') {
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  if (containsPartialRedactionMarker(trimmed)) return false;
  if (isFrameworkNeutralLiteral(trimmed)) return true;
  if (isNeutralPlaceholderText(trimmed)) return true;
  return false;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function containsNonNeutralCommittedText(value = '') {
  const text = String(value);
  if (!text.trim()) return false;
  if (containsPartialRedactionMarker(text)) return true;

  const chunks = extractHumanReadableStrings(text);
  if (chunks.length === 0) {
    const trimmed = text.trim();
    if (DOCUMENT_SHELL_PATTERN.test(trimmed)) return false;
    if (STRUCTURAL_HTML_ONLY_PATTERN.test(trimmed)) return false;
    if (HTML_MARKUP_ONLY_PATTERN.test(trimmed)) return false;
    if (/<[a-z][\s\S]*>/i.test(trimmed) && !/>([^<\s][^<]*)</.test(trimmed)) {
      return false;
    }
  }

  const candidates = chunks.length > 0
    ? chunks
    : [text];

  for (const chunk of candidates) {
    const trimmed = String(chunk).trim();
    if (!trimmed) continue;
    if (isNeutralCommittedString(trimmed)) continue;
    if (trimmed.split(/\s+/).every((part) => isNeutralToken(part))) continue;
    return true;
  }

  return false;
}

/**
 * @param {string} value
 * @param {Map<string, string>=} registry
 * @returns {string}
 */
export function pseudonymizeCommittedTextValue(value = '', registry = new Map()) {
  const trimmed = String(value).trim();
  if (!trimmed) return '';

  if (isFrameworkNeutralLiteral(trimmed) || isNeutralPlaceholderText(trimmed)) {
    return trimmed;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return pseudonymizeHumanText(trimmed, 'text', registry);
  }

  return parts.map((part) => {
    if (isFrameworkNeutralLiteral(part) || isNeutralPlaceholderText(part) || isNeutralToken(part)) {
      return part;
    }
    return pseudonymizeHumanText(part, 'text', registry);
  }).join(' ');
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {boolean}
 */
export function containsNonNeutralSnapshot(snapshot = {}) {
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  for (const element of elements) {
    const record = /** @type {Record<string, unknown>} */ (element);
    for (const field of ['text', 'visibleText', 'accessibleName']) {
      const value = String(record[field] || '').trim();
      if (!value) continue;
      if (isNeutralCommittedString(value)) continue;
      if (value.split(/\s+/).every((part) => isNeutralToken(part))) continue;
      return true;
    }

    const outerHTML = String(record.outerHTML || '');
    if (outerHTML && containsNonNeutralCommittedText(outerHTML)) return true;

    const attributes = /** @type {Record<string, string>} */ (record.attributes || {});
    for (const attrValue of Object.values(attributes)) {
      const value = String(attrValue || '').trim();
      if (!value) continue;
      if (isNeutralCommittedString(value)) continue;
      if (value.split(/\s+/).every((part) => isNeutralToken(part))) continue;
      return true;
    }
  }
  return false;
}

/**
 * @param {Record<string, unknown>} expected
 * @returns {boolean}
 */
export function containsNonNeutralExpected(expected = {}) {
  const findings = Array.isArray(expected.findings) ? expected.findings : [];
  for (const finding of findings) {
    const element = /** @type {{ semantic?: Record<string, unknown> }} */ (finding.element || {});
    const semantic = element.semantic || {};
    const attributes = /** @type {Record<string, string>} */ (semantic.attributes || {});
    for (const attrValue of Object.values(attributes)) {
      const value = String(attrValue || '').trim();
      if (!value) continue;
      if (isNeutralCommittedString(value)) continue;
      if (value.split(/\s+/).every((part) => isNeutralToken(part))) continue;
      return true;
    }
    for (const entry of Array.isArray(semantic.landmarkPath) ? semantic.landmarkPath : []) {
      const text = String(entry || '');
      if (/^section\[slice-\d+\]$/i.test(text)) continue;
      if (isNeutralToken(text)) continue;
      if (!isNeutralCommittedString(text)) return true;
    }
  }
  return false;
}

/**
 * @param {string} source
 * @param {string} kind
 * @param {Map<string, string>} registry
 * @returns {string}
 */
export function pseudonymizeHumanText(source = '', kind = 'text', registry = new Map()) {
  const raw = String(source);
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (isFrameworkNeutralLiteral(trimmed)) {
    return trimmed;
  }

  const registryKey = `${kind}|${trimmed.toLowerCase()}`;
  if (!registry.has(registryKey)) {
    const digest = canonicalSha256({ kind, text: trimmed }).slice(7, 15);
    const ordinal = registry.size;
    registry.set(registryKey, `neutral-${kind}-${ordinal}-${digest}`);
  }
  return registry.get(registryKey);
}

/**
 * @param {string} html
 * @param {Map<string, string>=} registry
 * @returns {string}
 */
export function pseudonymizeHtmlTextContent(html = '', registry = new Map()) {
  let output = String(html);

  for (const attribute of SEMANTIC_TEXT_ATTRIBUTES) {
    const doubleQuoted = new RegExp(`(\\s${attribute}\\s*=\\s*)(")([^"]*)(")`, 'gi');
    const singleQuoted = new RegExp(`(\\s${attribute}\\s*=\\s*)(')([^']*)(')`, 'gi');
    output = output.replace(doubleQuoted, (match, prefix, openQuote, value) => {
      const attrName = attribute.toLowerCase();
      const pseudo = TOKENIZED_SEMANTIC_ATTRIBUTES.has(attrName)
        ? pseudonymizeCommittedTextValue(value, registry)
        : pseudonymizeHumanText(value, attrName, registry);
      return `${prefix}${openQuote}${pseudo}${openQuote}`;
    });
    output = output.replace(singleQuoted, (match, prefix, openQuote, value) => {
      const attrName = attribute.toLowerCase();
      const pseudo = TOKENIZED_SEMANTIC_ATTRIBUTES.has(attrName)
        ? pseudonymizeCommittedTextValue(value, registry)
        : pseudonymizeHumanText(value, attrName, registry);
      return `${prefix}${openQuote}${pseudo}${openQuote}`;
    });
  }

  output = output.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '<title>Neutral page title</title>');

  output = output.replace(/>([^<]+)</g, (match, text) => {
    if (!String(text).trim()) return match;
    const pseudo = pseudonymizeHumanText(text, 'text', registry);
    return `>${pseudo}<`;
  });

  return output.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} url
 * @returns {string}
 */
export function neutralizeEvidenceUrl(url = '') {
  let output = String(url).trim();
  if (!output) return output;

  output = output
    .replace(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?/i, '')
    .replace(/^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/i, '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/\/[^/]+/i, '');

  if (!output || output === '/') return '/';
  if (LOOPBACK_HOST_PATTERN.test(output)) return '/neutral-asset.png';
  if (!output.startsWith('/')) output = `/${output}`;
  return output;
}
