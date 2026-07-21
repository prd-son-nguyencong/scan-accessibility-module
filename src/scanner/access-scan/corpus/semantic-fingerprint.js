import { canonicalSha256, normalizeWhitespace } from '../../../reporter/fingerprint.js';
import { normalizeCorpusRuleId } from '../../../reporter/rule-aliases.js';
import { containsHostLeakage } from './sanitization.js';

const VOLATILE_ATTRIBUTE_NAMES = new Set([
  'id',
  'class',
  'style',
  'data-testid',
  'data-test',
  'data-cy',
  'data-qa',
  'data-automation',
  'onclick',
  'onchange',
  'oninput',
]);

const STABLE_ATTRIBUTE_NAMES = new Set([
  'role',
  'type',
  'name',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-expanded',
  'aria-current',
  'aria-hidden',
  'aria-haspopup',
  'aria-selected',
  'disabled',
  'href',
  'for',
  'autocomplete',
  'placeholder',
  'value',
  'title',
  'lang',
  'alt',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HEX_PATTERN = /^[a-f0-9]{12,}$/i;
const GENERATED_PREFIX_PATTERN = /(?:^|[-_])(?:uuid|hash|random|generated|tmp|temp)(?:$|[-_])/i;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export class AmbiguousSemanticFindingError extends Error {
  constructor(message = 'Ambiguous semantic finding requires ordinal or disambiguator') {
    super(message);
    this.name = 'AmbiguousSemanticFindingError';
  }
}

/**
 * @param {string} token
 * @returns {boolean}
 */
export function isGeneratedIdRef(token = '') {
  const value = String(token).trim();
  if (!value) return false;
  if (UUID_PATTERN.test(value)) return true;
  if (LONG_HEX_PATTERN.test(value)) return true;
  return GENERATED_PREFIX_PATTERN.test(value);
}

/**
 * @typedef {object} SemanticElementDescriptor
 * @property {string} tag
 * @property {string | null=} role
 * @property {Record<string, string>=} attributes
 * @property {string[]} landmarkPath
 * @property {number=} ordinal
 * @property {string=} disambiguator
 * @property {number[]=} framePath
 * @property {number[]=} shadowPath
 */

/**
 * @param {SemanticElementDescriptor | Record<string, unknown>} semantic
 * @returns {boolean}
 */
export function hasSemanticDisambiguator(semantic = {}) {
  if (Number.isInteger(semantic.ordinal) && semantic.ordinal >= 0) return true;
  return typeof semantic.disambiguator === 'string' && semantic.disambiguator.length > 0;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isVolatileAttributeName(name) {
  const lower = name.toLowerCase();
  if (VOLATILE_ATTRIBUTE_NAMES.has(lower)) return true;
  return lower.startsWith('data-') || lower.startsWith('on');
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function normalizeSemanticAttribute(name, value) {
  const lower = name.toLowerCase();
  const trimmed = normalizeWhitespace(String(value || ''));

  if (lower === 'href') {
    try {
      const url = new URL(trimmed, 'https://neutral.invalid');
      return url.pathname + url.search + url.hash;
    } catch {
      return trimmed
        .replace(/^https?:\/\/[^/]+/i, '')
        .replace(/^\/\/[^/]+/i, '')
        || trimmed;
    }
  }

  if (lower === 'aria-controls' || lower === 'aria-labelledby' || lower === 'aria-describedby' || lower === 'for') {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return tokens.map((token) => (
      isGeneratedIdRef(token) ? '[generated-ref]' : token
    )).join(' ');
  }

  if (TIMESTAMP_PATTERN.test(trimmed)) {
    return '[timestamp]';
  }

  return trimmed
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/\/[^/]+/i, '');
}

/**
 * @param {Record<string, unknown>} attributes
 * @returns {Record<string, string>}
 */
export function normalizeSemanticAttributes(attributes = {}) {
  /** @type {Record<string, string>} */
  const output = {};
  for (const [name, rawValue] of Object.entries(attributes)) {
    if (rawValue == null) continue;
    const lower = name.toLowerCase();
    if (isVolatileAttributeName(lower)) continue;
    if (!STABLE_ATTRIBUTE_NAMES.has(lower) && !lower.startsWith('aria-')) continue;
    const value = normalizeSemanticAttribute(lower, String(rawValue));
    if (value.length > 0) output[lower] = value;
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {SemanticElementDescriptor}
 */
export function extractSemanticDescriptor(finding = {}) {
  const element = /** @type {Record<string, unknown>} */ (finding.element || {});
  const semantic = /** @type {Record<string, unknown>} */ (element.semantic || {});

  if (Object.keys(semantic).length > 0) {
    return {
      tag: String(semantic.tag || 'unknown'),
      role: semantic.role == null ? null : String(semantic.role),
      attributes: normalizeSemanticAttributes(
        /** @type {Record<string, unknown>} */ (semantic.attributes || {}),
      ),
      landmarkPath: Array.isArray(semantic.landmarkPath)
        ? semantic.landmarkPath.map((entry) => String(entry))
        : [],
      ...(Number.isInteger(semantic.ordinal) && semantic.ordinal >= 0
        ? { ordinal: semantic.ordinal }
        : {}),
      ...(typeof semantic.disambiguator === 'string' && semantic.disambiguator.length > 0
        ? { disambiguator: semantic.disambiguator }
        : {}),
      framePath: Array.isArray(semantic.framePath) ? [...semantic.framePath] : (
        Array.isArray(element.framePath) ? [...element.framePath] : []
      ),
      shadowPath: Array.isArray(semantic.shadowPath) ? [...semantic.shadowPath] : (
        Array.isArray(element.shadowPath) ? [...element.shadowPath] : []
      ),
    };
  }

  const outerHTML = String(element.outerHTML || element.html || '');
  const tagMatch = outerHTML.match(/^<\s*([a-z0-9-]+)/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : 'unknown';
  const roleMatch = outerHTML.match(/\srole=["']([^"']+)["']/i);
  const attrPattern = /([:@a-z0-9_-]+)=["']([^"']*)["']/gi;
  /** @type {Record<string, string>} */
  const parsedAttributes = {};
  for (const match of outerHTML.matchAll(attrPattern)) {
    parsedAttributes[match[1]] = match[2];
  }

  return {
    tag,
    role: roleMatch ? roleMatch[1] : null,
    attributes: normalizeSemanticAttributes(parsedAttributes),
    landmarkPath: [],
    framePath: Array.isArray(element.framePath) ? [...element.framePath] : [],
    shadowPath: Array.isArray(element.shadowPath) ? [...element.shadowPath] : [],
  };
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {boolean}
 */
export function isAmbiguousSemanticFinding(finding = {}) {
  const semantic = extractSemanticDescriptor(finding);
  return semantic.landmarkPath.length > 0 && !hasSemanticDisambiguator(semantic);
}

/**
 * @param {Record<string, unknown>} finding
 */
export function assertComparableSemanticFinding(finding = {}) {
  if (isAmbiguousSemanticFinding(finding)) {
    throw new AmbiguousSemanticFindingError();
  }
}

/**
 * @param {Record<string, unknown>} finding
 * @returns {string}
 */
export function semanticElementFingerprint(finding = {}) {
  assertComparableSemanticFinding(finding);

  const ruleId = normalizeCorpusRuleId(
    finding.canonicalRuleId
    || finding.ruleId
    || finding.nativeRuleId
    || 'unknown-rule',
  );
  const evidence = /** @type {Record<string, unknown>} */ (finding.evidence || {});
  const checkId = evidence.checkId || evidence.check || null;
  const structuralPattern = evidence.structuralPattern || null;
  const semantic = extractSemanticDescriptor(finding);

  return canonicalSha256({
    kind: 'semantic-element',
    ruleId,
    checkId,
    structuralPattern,
    scope: {
      framePath: semantic.framePath || [],
      shadowPath: semantic.shadowPath || [],
    },
    element: {
      tag: semantic.tag,
      role: semantic.role,
      attributes: semantic.attributes,
      landmarkPath: semantic.landmarkPath,
      ...(semantic.ordinal === undefined ? {} : { ordinal: semantic.ordinal }),
      ...(semantic.disambiguator === undefined ? {} : { disambiguator: semantic.disambiguator }),
    },
  });
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {boolean}
 */
export function semanticFindingsEquivalent(left, right) {
  return semanticElementFingerprint(left) === semanticElementFingerprint(right);
}

/**
 * @param {Record<string, unknown>} semantic
 * @param {string} label
 * @returns {string[]}
 */
export function findSemanticHostLeakage(semantic = {}, label = 'semantic') {
  /** @type {string[]} */
  const errors = [];
  if (typeof semantic.role === 'string' && containsHostLeakage(semantic.role)) {
    errors.push(`${label}.role contains host or URL leakage`);
  }
  if (Array.isArray(semantic.landmarkPath)) {
    for (const [index, entry] of semantic.landmarkPath.entries()) {
      if (typeof entry === 'string' && containsHostLeakage(entry)) {
        errors.push(`${label}.landmarkPath[${index}] contains host or URL leakage`);
      }
    }
  }
  if (typeof semantic.disambiguator === 'string' && containsHostLeakage(semantic.disambiguator)) {
    errors.push(`${label}.disambiguator contains host or URL leakage`);
  }
  if (isObject(semantic.attributes)) {
    for (const [name, value] of Object.entries(semantic.attributes)) {
      if (typeof value === 'string' && containsHostLeakage(value)) {
        errors.push(`${label}.attributes.${name} contains host or URL leakage`);
      }
    }
  }
  return errors;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
