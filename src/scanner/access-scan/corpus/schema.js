import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  CORPUS_FORBIDDEN_TOKENS,
  CORPUS_PROFILES,
  CORPUS_REQUIRED_CASE_FILES,
  CORPUS_SCHEMA_VERSION,
} from './constants.js';
import { containsHostLeakage } from './sanitization.js';
import {
  findCommittedAttributeViolations,
  findSnapshotAttributeViolations,
  isMalformedSerializedAttributeValue,
  isReplayEssentialAttribute,
  snapshotAttributesAgreeWithOuterHtml,
} from './attribute-allowlist.js';
import { buildCorpusFindingEntry } from './diff.js';
import {
  findSemanticHostLeakage,
  hasSemanticDisambiguator,
  isGeneratedIdRef,
} from './semantic-fingerprint.js';

const VOLATILE_SELECTOR_ID_PATTERN = /#[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*/i;
const VOLATILE_HTML_ID_PATTERN = /\sid=["'][^"']+["']/i;

/**
 * @typedef {object} CorpusValidationResult
 * @property {boolean} ok
 * @property {string[]} errors
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} json
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function parseJson(json, label) {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    return { ok: false, error: `${label} is not valid JSON: ${error.message}` };
  }
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {string[]}
 */
function findForbiddenTokens(text, label) {
  const haystack = String(text).toLowerCase();
  return CORPUS_FORBIDDEN_TOKENS
    .filter((token) => haystack.includes(token.toLowerCase()))
    .map((token) => `${label} contains forbidden token "${token}"`);
}

/**
 * @param {unknown} manifest
 * @param {{ rootDir?: string }=} options
 * @returns {CorpusValidationResult}
 */
export function validateCorpusManifest(manifest, options = {}) {
  /** @type {string[]} */
  const errors = [];

  if (!isObject(manifest)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  if (manifest.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    errors.push(`manifest.schemaVersion must be ${CORPUS_SCHEMA_VERSION}`);
  }

  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    errors.push('manifest.cases must be a non-empty array');
    return { ok: false, errors };
  }

  const seenIds = new Set();
  for (const [index, entry] of manifest.cases.entries()) {
    if (!isObject(entry)) {
      errors.push(`manifest.cases[${index}] must be an object`);
      continue;
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      errors.push(`manifest.cases[${index}].id must be a non-empty string`);
    } else if (seenIds.has(entry.id)) {
      errors.push(`manifest.cases[${index}].id duplicates case id "${entry.id}"`);
    } else {
      seenIds.add(entry.id);
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      errors.push(`manifest.cases[${index}].path must be a non-empty string`);
      continue;
    }
    if (options.rootDir) {
      const caseDir = path.join(options.rootDir, entry.path);
      const caseResult = validateCorpusCase(caseDir);
      if (!caseResult.ok) {
        errors.push(...caseResult.errors.map((error) => `${entry.id}: ${error}`));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {string} caseDir
 * @returns {CorpusValidationResult}
 */
export function validateCorpusCase(caseDir) {
  /** @type {string[]} */
  const errors = [];

  if (!existsSync(caseDir)) {
    return { ok: false, errors: [`case directory does not exist: ${caseDir}`] };
  }

  for (const fileName of CORPUS_REQUIRED_CASE_FILES) {
    const filePath = path.join(caseDir, fileName);
    if (!existsSync(filePath)) {
      errors.push(`missing required file ${fileName}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const meta = readJsonCaseFile(path.join(caseDir, 'meta.json'), 'meta.json', errors);
  const snapshot = readJsonCaseFile(path.join(caseDir, 'snapshot.json'), 'snapshot.json', errors);
  const expected = readJsonCaseFile(path.join(caseDir, 'expected.json'), 'expected.json', errors);

  if (meta) validateMeta(meta, errors);
  if (snapshot) validateSnapshot(snapshot, errors);
  if (expected) validateExpected(expected, errors);
  if (meta && expected) validateProfileConsistency(meta, expected, errors);

  for (const fileName of [...CORPUS_REQUIRED_CASE_FILES, 'page.html']) {
    const filePath = path.join(caseDir, fileName);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    errors.push(...findForbiddenTokens(content, fileName));
    if (fileName.endsWith('.html')) {
      errors.push(...findCommittedAttributeViolations(content, fileName));
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {string} filePath
 * @param {string} label
 * @param {string[]} errors
 * @returns {Record<string, unknown> | null}
 */
function readJsonCaseFile(filePath, label, errors) {
  const parsed = parseJson(readFileSync(filePath, 'utf8'), label);
  if (!parsed.ok) {
    errors.push(parsed.error);
    return null;
  }
  if (!isObject(parsed.value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  return parsed.value;
}

/**
 * @param {Record<string, unknown>} meta
 * @param {string[]} errors
 */
function validateMeta(meta, errors) {
  if (meta.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    errors.push(`meta.schemaVersion must be ${CORPUS_SCHEMA_VERSION}`);
  }
  if (typeof meta.id !== 'string' || meta.id.length === 0) {
    errors.push('meta.id must be a non-empty string');
  }
  if (!CORPUS_PROFILES.includes(/** @type {string} */ (meta.profile))) {
    errors.push(`meta.profile must be one of: ${CORPUS_PROFILES.join(', ')}`);
  }
  if (typeof meta.route !== 'string' || meta.route.length === 0) {
    errors.push('meta.route must be a non-empty string');
  } else if (containsHostLeakage(meta.route)) {
    errors.push('meta.route contains host or URL leakage');
  }
  if (typeof meta.captureState !== 'string' || meta.captureState.length === 0) {
    errors.push('meta.captureState must be a non-empty string');
  }
  if (!isObject(meta.viewport)) {
    errors.push('meta.viewport must be an object');
  } else {
    for (const key of ['width', 'height']) {
      if (!Number.isInteger(meta.viewport[key]) || meta.viewport[key] <= 0) {
        errors.push(`meta.viewport.${key} must be a positive integer`);
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {string[]} errors
 */
function validateSnapshot(snapshot, errors) {
  if (snapshot.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    errors.push(`snapshot.schemaVersion must be ${CORPUS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(snapshot.elements)) {
    errors.push('snapshot.elements must be an array');
    return;
  }
  if (!Array.isArray(snapshot.diagnostics)) {
    errors.push('snapshot.diagnostics must be an array');
  }
  if (!isObject(snapshot.counts)) {
    errors.push('snapshot.counts must be an object');
  }

  for (const [index, element] of snapshot.elements.entries()) {
    validateSnapshotElement(element, index, errors);
  }

  errors.push(...findSnapshotAttributeViolations(snapshot));
}

/**
 * @param {unknown} element
 * @param {number} index
 * @param {string[]} errors
 */
function validateSnapshotElement(element, index, errors) {
  const prefix = `snapshot.elements[${index}]`;
  if (!isObject(element)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  for (const field of ['selector', 'reportSelector']) {
    const value = element[field];
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${prefix}.${field} must be a non-empty string`);
      continue;
    }
    if (VOLATILE_SELECTOR_ID_PATTERN.test(value)) {
      errors.push(`${prefix}.${field} contains volatile generated id selector`);
    }
  }

  if (isObject(element.attributes)) {
    for (const [name, value] of Object.entries(element.attributes)) {
      if (typeof value !== 'string') continue;
      if (containsHostLeakage(value)) {
        errors.push(`${prefix}.attributes.${name} contains host or URL leakage`);
      }
      if (name.toLowerCase() === 'id' && isGeneratedIdRef(value)) {
        errors.push(`${prefix}.attributes.id contains volatile generated id`);
      }
    }
  } else if (element.attributes !== undefined) {
    errors.push(`${prefix}.attributes must be an object when present`);
  }

  for (const field of ['text', 'visibleText', 'accessibleName']) {
    const value = element[field];
    if (typeof value === 'string' && containsHostLeakage(value)) {
      errors.push(`${prefix}.${field} contains host or URL leakage`);
    }
  }

  if (typeof element.outerHTML === 'string') {
    if (containsHostLeakage(element.outerHTML)) {
      errors.push(`${prefix}.outerHTML contains host or URL leakage`);
    }
    const idMatch = element.outerHTML.match(VOLATILE_HTML_ID_PATTERN);
    if (idMatch) {
      const idValue = idMatch[0].match(/id=["']([^"']+)["']/i)?.[1] || '';
      if (isGeneratedIdRef(idValue)) {
        errors.push(`${prefix}.outerHTML contains volatile generated id attribute`);
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} meta
 * @param {Record<string, unknown>} expected
 * @param {string[]} errors
 */
function validateProfileConsistency(meta, expected, errors) {
  if (meta.profile !== expected.profile) {
    errors.push(
      `meta.profile (${meta.profile}) must match expected.profile (${expected.profile})`,
    );
  }
}

/**
 * @param {Record<string, unknown>} expected
 * @param {string[]} errors
 */
function validateExpected(expected, errors) {
  if (expected.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    errors.push(`expected.schemaVersion must be ${CORPUS_SCHEMA_VERSION}`);
  }
  if (!CORPUS_PROFILES.includes(/** @type {string} */ (expected.profile))) {
    errors.push(`expected.profile must be one of: ${CORPUS_PROFILES.join(', ')}`);
  }
  if (!Array.isArray(expected.findings)) {
    errors.push('expected.findings must be an array');
    return;
  }

  const acceptanceKeys = new Set();

  for (const [index, finding] of expected.findings.entries()) {
    const prefix = `expected.findings[${index}]`;
    if (!isObject(finding)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (typeof finding.ruleId !== 'string' || finding.ruleId.length === 0) {
      errors.push(`${prefix}.ruleId must be a non-empty string`);
    }
    if (!isObject(finding.element) || !isObject(finding.element.semantic)) {
      errors.push(`${prefix}.element.semantic must be an object`);
      continue;
    }
    const semantic = finding.element.semantic;
    if (typeof semantic.tag !== 'string' || semantic.tag.length === 0) {
      errors.push(`${prefix}.element.semantic.tag must be a non-empty string`);
    }
    if (!Array.isArray(semantic.landmarkPath)) {
      errors.push(`${prefix}.element.semantic.landmarkPath must be an array`);
    } else if (semantic.landmarkPath.length > 0 && !hasSemanticDisambiguator(semantic)) {
      errors.push(`${prefix}.element.semantic requires ordinal or disambiguator when landmarkPath is non-empty`);
    }
    if (semantic.ordinal !== undefined
      && (!Number.isInteger(semantic.ordinal) || semantic.ordinal < 0)) {
      errors.push(`${prefix}.element.semantic.ordinal must be a non-negative integer`);
    }
    if (semantic.disambiguator !== undefined
      && (typeof semantic.disambiguator !== 'string' || semantic.disambiguator.length === 0)) {
      errors.push(`${prefix}.element.semantic.disambiguator must be a non-empty string when present`);
    }

    errors.push(...findSemanticHostLeakage(semantic, `${prefix}.element.semantic`));

    try {
      const entry = buildCorpusFindingEntry(finding);
      if (acceptanceKeys.has(entry.key)) {
        errors.push(`${prefix} duplicates acceptance identity ${entry.key}`);
      } else {
        acceptanceKeys.add(entry.key);
      }
    } catch (error) {
      errors.push(`${prefix} is not comparable: ${error.message}`);
    }
  }
}
