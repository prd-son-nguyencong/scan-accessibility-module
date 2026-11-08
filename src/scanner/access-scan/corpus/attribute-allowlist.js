/** @type {ReadonlySet<string>} */
export const REPLAY_ESSENTIAL_ATTRIBUTE_NAMES = new Set([
  'autocomplete',
  'charset',
  'checked',
  'colspan',
  'content',
  'disabled',
  'for',
  'hidden',
  'href',
  'lang',
  'max',
  'media',
  'min',
  'name',
  'open',
  'pattern',
  'placeholder',
  'readonly',
  'rel',
  'required',
  'role',
  'rowspan',
  'scope',
  'selected',
  'sizes',
  'src',
  'step',
  'tabindex',
  'target',
  'title',
  'type',
  'value',
  'xlink:href',
  'alt',
]);

const MALFORMED_SERIALIZED_VALUE_PATTERN = /\[object (?:object|array|undefined|null|function|date|regexp)\]/i;
const HTML_ATTRIBUTE_NAME_PATTERN = /^[a-z][a-z0-9:_-]*$/i;
const HTML_ATTRIBUTE_PATTERN = /\s([a-z][a-z0-9:_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isAllowlistedReplayAttribute(name = '') {
  const lower = String(name).trim().toLowerCase();
  if (!lower || !HTML_ATTRIBUTE_NAME_PATTERN.test(lower)) return false;
  if (REPLAY_ESSENTIAL_ATTRIBUTE_NAMES.has(lower)) return true;
  if (lower.startsWith('aria-')) return true;
  return false;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isMalformedSerializedAttributeValue(value = '') {
  const text = String(value).trim();
  if (!text) return false;
  return MALFORMED_SERIALIZED_VALUE_PATTERN.test(text);
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {boolean}
 */
export function isReplayEssentialAttribute(name = '', value = '') {
  if (!isAllowlistedReplayAttribute(name)) return false;
  if (isMalformedSerializedAttributeValue(value)) return false;
  return true;
}

/**
 * @param {Record<string, string>} attributes
 * @returns {Record<string, string>}
 */
export function filterAllowlistedReplayAttributes(attributes = {}) {
  /** @type {Record<string, string>} */
  const output = {};
  for (const [name, value] of Object.entries(attributes)) {
    const text = String(value ?? '');
    if (!isReplayEssentialAttribute(name, text)) continue;
    output[name.toLowerCase()] = text;
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

const HTML_TAG_PATTERN = /<\s*[a-z][a-z0-9-]*\b[^>]*>/gi;

/**
 * @param {string} html
 * @returns {Array<{ name: string, value: string }>}
 */
function extractHtmlTagAttributes(html = '') {
  /** @type {Array<{ name: string, value: string }>} */
  const attributes = [];
  for (const tagMatch of String(html).matchAll(HTML_TAG_PATTERN)) {
    const tag = tagMatch[0];
    for (const match of tag.matchAll(HTML_ATTRIBUTE_PATTERN)) {
      attributes.push({
        name: String(match[1]),
        value: match[2] ?? match[3] ?? match[4] ?? '',
      });
    }
  }
  return attributes;
}

/**
 * @param {string} html
 * @returns {string}
 */
export function stripNonAllowlistedAttributesFromHtml(html = '') {
  return String(html).replace(HTML_TAG_PATTERN, (tag) => tag.replace(HTML_ATTRIBUTE_PATTERN, (match, name, doubleQuoted, singleQuoted, unquoted) => {
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
    if (!isReplayEssentialAttribute(name, value)) return '';
    if (value === '') return ` ${name}`;
    const quote = doubleQuoted != null ? '"' : (singleQuoted != null ? "'" : '"');
    const escaped = String(value).replace(/"/g, '&quot;');
    return ` ${name}=${quote}${escaped}${quote}`;
  }));
}

/**
 * @param {string} html
 * @returns {{ tag: string, innerHtml: string, selfClosing: boolean }}
 */
export function parseElementOuterHtmlStructure(html = '') {
  const trimmed = String(html).trim();
  const selfClosing = /^<\s*([a-z0-9-]+)\b[^>]*\/\s*>$/i.exec(trimmed);
  if (selfClosing) {
    return {
      tag: selfClosing[1].toLowerCase(),
      innerHtml: '',
      selfClosing: true,
    };
  }

  const withChildren = /^<\s*([a-z0-9-]+)\b[^>]*>([\s\S]*)<\/\1\s*>$/i.exec(trimmed);
  if (withChildren) {
    return {
      tag: withChildren[1].toLowerCase(),
      innerHtml: withChildren[2],
      selfClosing: false,
    };
  }

  const bareOpen = /^<\s*([a-z0-9-]+)\b[^>]*>$/i.exec(trimmed);
  if (bareOpen) {
    return {
      tag: bareOpen[1].toLowerCase(),
      innerHtml: '',
      selfClosing: true,
    };
  }

  return {
    tag: 'unknown',
    innerHtml: '',
    selfClosing: true,
  };
}

/**
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @param {string} innerHtml
 * @param {boolean} selfClosing
 * @returns {string}
 */
export function buildOuterHtmlFromAttributes(tag, attributes = {}, innerHtml = '', selfClosing = true) {
  const attrPart = Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (value === '') return ` ${name}`;
      return ` ${name}="${String(value).replace(/"/g, '&quot;')}"`;
    })
    .join('');

  if (selfClosing && !innerHtml) {
    return `<${tag}${attrPart} />`;
  }
  return `<${tag}${attrPart}>${innerHtml}</${tag}>`;
}

/**
 * @param {Record<string, string>} attributes
 * @param {string} outerHTML
 * @returns {boolean}
 */
export function snapshotAttributesAgreeWithOuterHtml(attributes = {}, outerHTML = '') {
  const openTag = outerHTML.match(/^<\s*[a-z0-9-]+\b([^>]*)>/i)?.[1] || '';
  /** @type {Record<string, string>} */
  const outerAttrs = {};

  for (const match of openTag.matchAll(HTML_ATTRIBUTE_PATTERN)) {
    const name = String(match[1]).toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!isReplayEssentialAttribute(name, value)) continue;
    outerAttrs[name] = value;
  }

  const normalized = filterAllowlistedReplayAttributes(attributes);
  return JSON.stringify(normalized) === JSON.stringify(
    Object.fromEntries(Object.entries(outerAttrs).sort(([a], [b]) => a.localeCompare(b))),
  );
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {string[]}
 */
export function findCommittedAttributeViolations(text = '', label = 'payload') {
  /** @type {string[]} */
  const violations = [];

  if (MALFORMED_SERIALIZED_VALUE_PATTERN.test(String(text))) {
    violations.push(`${label} contains malformed serialized attribute value`);
  }

  for (const { name, value } of extractHtmlTagAttributes(text)) {
    if (!isAllowlistedReplayAttribute(name) && HTML_ATTRIBUTE_NAME_PATTERN.test(name)) {
      violations.push(`${label} contains non-allowlisted framework attribute "${name}"`);
    }
    if (isMalformedSerializedAttributeValue(value)) {
      violations.push(`${label} contains malformed serialized attribute value`);
    }
  }

  return violations;
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {string[]}
 */
export function findSnapshotAttributeViolations(snapshot = {}) {
  /** @type {string[]} */
  const violations = [];
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  for (const [index, element] of elements.entries()) {
    const record = /** @type {Record<string, unknown>} */ (element);
    const prefix = `snapshot.elements[${index}]`;
    const attributes = /** @type {Record<string, string>} */ (record.attributes || {});
    for (const [name, value] of Object.entries(attributes)) {
      if (!isReplayEssentialAttribute(name, String(value ?? ''))) {
        violations.push(`${prefix}.attributes.${name} is not allowlisted for replay evidence`);
      }
      if (isMalformedSerializedAttributeValue(String(value ?? ''))) {
        violations.push(`${prefix}.attributes.${name} contains malformed serialized attribute value`);
      }
    }
    const outerHTML = String(record.outerHTML || '');
    violations.push(...findCommittedAttributeViolations(outerHTML, `${prefix}.outerHTML`));
    if (outerHTML && !snapshotAttributesAgreeWithOuterHtml(attributes, outerHTML)) {
      violations.push(`${prefix}.outerHTML disagrees with sanitized attributes`);
    }
  }
  return violations;
}
