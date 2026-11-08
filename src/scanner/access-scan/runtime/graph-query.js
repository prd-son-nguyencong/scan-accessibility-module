/**
 * @typedef {import('./types.js').Snapshot} Snapshot
 * @typedef {import('./types.js').SnapshotElement} SnapshotElement
 * @typedef {{ code: string, selector: string, message: string }} SelectorDiagnostic
 * @typedef {{
 *   name: string,
 *   operator?: '=' | '^=' | '$=' | '*=',
 *   value?: string,
 * }} ParsedAttributeSelector
 * @typedef {{ tag: string | null, attributes: ParsedAttributeSelector[] }} ParsedSimpleSelector
 */

const COMBINATOR_PATTERN = /[\s>+~]/;
const PSEUDO_PATTERN = /:(?:nth|first|last|not|is|where|has|hover|focus|active|visited|link|empty|root|scope)\b/i;
const ID_OR_CLASS_PATTERN = /[#.]/;

/**
 * @param {string} selector
 * @returns {boolean}
 */
function isUnsupportedSimplePart(part) {
  const trimmed = part.trim();
  if (!trimmed) return true;
  if (COMBINATOR_PATTERN.test(trimmed)) return true;
  if (PSEUDO_PATTERN.test(trimmed)) return true;
  const withoutAttributes = trimmed.replace(/\[[^\]]*\]/g, '');
  if (ID_OR_CLASS_PATTERN.test(withoutAttributes)) return true;
  return false;
}

/**
 * @param {string} selector
 * @returns {boolean}
 */
function isUnsupportedSelector(selector) {
  const trimmed = selector.trim();
  if (!trimmed) return true;
  return splitSelectorList(trimmed).some(isUnsupportedSimplePart);
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
export function splitSelectorList(selector) {
  /** @type {string[]} */
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let bracketDepth = 0;

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (char === '[') bracketDepth += 1;
      if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      if (char === ',' && bracketDepth === 0) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        continue;
      }
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

/**
 * @param {string} part
 * @returns {ParsedSimpleSelector | null}
 */
function parseSimpleSelector(part) {
  let remaining = part.trim();
  if (!remaining) return null;

  /** @type {string | null} */
  let tag = null;
  const tagMatch = remaining.match(/^([a-zA-Z][\w-]*|\*)(?=\[|$)/);
  if (tagMatch) {
    tag = tagMatch[1] === '*' ? '*' : tagMatch[1].toLowerCase();
    remaining = remaining.slice(tagMatch[0].length);
  }

  /** @type {ParsedAttributeSelector[]} */
  const attributes = [];
  while (remaining.length > 0) {
    const attrMatch = remaining.match(
      /^\[([^\]=\^\$\s]+)(?:(\^|\$|\*)=|=)?(?:'([^']*)'|"([^"]*)"|([^\]\s]+))?\]/,
    );
    if (!attrMatch) return null;
    const [, rawName, operator, singleQuoted, doubleQuoted, unquoted] = attrMatch;
    const value = singleQuoted ?? doubleQuoted ?? unquoted;
    /** @type {ParsedAttributeSelector} */
    const attribute = { name: rawName.toLowerCase() };
    if (operator) {
      attribute.operator = `${operator}=`;
    } else if (value !== undefined) {
      attribute.operator = '=';
    }
    if (value !== undefined) {
      attribute.value = value;
    }
    attributes.push(attribute);
    remaining = remaining.slice(attrMatch[0].length);
  }

  if (!tag && attributes.length === 0) return null;
  return { tag, attributes };
}

/**
 * @param {string} selector
 * @returns {{ unsupported: true, diagnostic: SelectorDiagnostic } | { unsupported: false, parts: ParsedSimpleSelector[] }}
 */
export function parseGraphSelector(selector) {
  if (isUnsupportedSelector(selector)) {
    return {
      unsupported: true,
      diagnostic: {
        code: 'selector-unsupported',
        selector,
        message: 'Selector syntax requires plugin fallback; combinator, pseudo, id, and class selectors are not supported.',
      },
    };
  }

  const listParts = splitSelectorList(selector);
  const parsed = listParts.map(parseSimpleSelector);
  if (parsed.some((part) => part === null)) {
    return {
      unsupported: true,
      diagnostic: {
        code: 'selector-unsupported',
        selector,
        message: 'Selector syntax requires plugin fallback; malformed attribute selector.',
      },
    };
  }

  return {
    unsupported: false,
    parts: /** @type {ParsedSimpleSelector[]} */ (parsed),
  };
}

/**
 * @param {string} selector
 * @returns {{ valid: true } | { valid: false, diagnostic: SelectorDiagnostic }}
 */
export function validateGraphSelector(selector) {
  const parsed = parseGraphSelector(selector);
  if (parsed.unsupported) {
    return { valid: false, diagnostic: parsed.diagnostic };
  }
  return { valid: true };
}

/**
 * @param {SnapshotElement} element
 * @returns {Map<string, string>}
 */
function attributeLookup(element) {
  const lookup = new Map();
  for (const [name, value] of Object.entries(element.attributes)) {
    lookup.set(name.toLowerCase(), value);
  }
  return lookup;
}

function matchesHrefPrefix(actual, expected) {
  if (expected === '#') {
    return actual.startsWith('#') || /^[a-z][a-z0-9+.-]*:\/{2}[^?#]*#/i.test(actual);
  }
  return actual.startsWith(expected);
}

/**
 * @param {string} actual
 * @param {ParsedAttributeSelector} attr
 * @returns {boolean}
 */
function matchesAttribute(actual, attr) {
  if (actual === undefined) return false;
  if (!attr.operator) return true;
  if (attr.value === undefined) return true;

  const expected = attr.value;
  switch (attr.operator) {
    case '^=':
      if (attr.name === 'href') return matchesHrefPrefix(actual, expected);
      return actual.startsWith(expected);
    case '$=':
      return actual.endsWith(expected);
    case '*=':
      return actual.includes(expected);
    case '=':
    default:
      return actual === expected;
  }
}

/**
 * @param {SnapshotElement} element
 * @param {ParsedSimpleSelector} part
 * @returns {boolean}
 */
function matchesSimpleSelector(element, part) {
  if (part.tag && part.tag !== '*' && element.tag !== part.tag) {
    return false;
  }

  const attrs = attributeLookup(element);
  for (const attr of part.attributes) {
    const actual = attrs.get(attr.name);
    if (!matchesAttribute(actual, attr)) return false;
  }

  return true;
}

/**
 * @param {Snapshot} snapshot
 * @param {string} selector
 * @param {{ diagnostics?: SelectorDiagnostic[] }=} options
 * @returns {SnapshotElement[] | { matches: SnapshotElement[], diagnostics: SelectorDiagnostic[] }}
 */
export function queryGraph(snapshot, selector, options = {}) {
  const wantsDiagnostics = Array.isArray(options.diagnostics);
  /** @type {SelectorDiagnostic[]} */
  const diagnostics = wantsDiagnostics ? options.diagnostics : [];

  const parsed = parseGraphSelector(selector);
  if (parsed.unsupported) {
    if (wantsDiagnostics) {
      diagnostics.push(parsed.diagnostic);
      return { matches: [], diagnostics };
    }
    return [];
  }

  const matches = snapshot.elements.filter((element) =>
    parsed.parts.some((part) => matchesSimpleSelector(element, part)),
  );

  if (wantsDiagnostics) {
    return { matches, diagnostics };
  }

  return matches;
}
