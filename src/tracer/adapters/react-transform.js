import path from 'node:path';

// Loader-agnostic JSX transform: adds data-ada-src="file:line" to every lower-case host element's opening tag.
// Own scanner (no parser is a resolvable dependency: no @babel/parser, typescript or @swc here).
// shortcut: heuristic JSX detection (an `<` after an operand is a comparison or generic, never JSX); a scan that
// cannot close a tag is dropped whole, so an odd file stays untouched instead of corrupted. Upgrade to a real
// parser (oxc/@babel/parser, supplied by the host) when a project hits that.

const ATTR = 'data-ada-src';
const KEYWORDS_BEFORE_EXPR = new Set(['return', 'default', 'case', 'yield', 'await', 'else', 'do', 'in', 'of', 'typeof', 'void', 'delete', 'new', 'throw']);
const HOST_TAG = /^[a-z][a-z0-9-]*$/;

/**
 * @param {string} code JSX/TSX source
 * @param {{ file: string }} opts file: project-relative posix path written into the attribute
 * @returns {{ code: string, elements: { line: number, col: number, tag: string }[] }}
 *   Insertions never add a newline, so line numbers of the output equal those of the input.
 */
export function transformJsx(code, { file }) {
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const where = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - lineStarts[lo] + 1 };
  };
  const edits = []; // { at, line, col, tag }
  const fail = () => { throw new SyntaxError('jsx'); };
  const isId = (c) => c !== undefined && /[\w$]/.test(c);

  const skipSpace = (i) => {
    for (;;) {
      while (i < code.length && /\s/.test(code[i])) i++;
      if (code.startsWith('//', i)) { const e = code.indexOf('\n', i); i = e === -1 ? code.length : e; } else if (code.startsWith('/*', i)) {
        const e = code.indexOf('*/', i + 2);
        if (e === -1) fail();
        i = e + 2;
      } else return i;
    }
  };
  const skipQuoted = (i) => {
    const q = code[i++];
    while (i < code.length && code[i] !== q) i += code[i] === '\\' ? 2 : 1;
    if (i >= code.length) fail();
    return i + 1;
  };
  const skipTemplate = (i) => {
    i++;
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') i += 2;
      else if (code.startsWith('${', i)) i = scanCode(i + 2, true) + 1;
      else i++;
    }
    if (i >= code.length) fail();
    return i + 1;
  };
  const skipRegex = (i) => {
    i++;
    let inClass = false;
    while (i < code.length && (inClass || code[i] !== '/')) {
      if (code[i] === '\n') return -1;
      if (code[i] === '\\') i++;
      else if (code[i] === '[') inClass = true;
      else if (code[i] === ']') inClass = false;
      i++;
    }
    if (i >= code.length) return -1;
    i++;
    while (isId(code[i])) i++;
    return i;
  };

  // Code mode. Returns the index of the closing `}` when `inBraces`, else code.length.
  function scanCode(i, inBraces) {
    let depth = 0;
    let prev = ''; // last significant token: a keyword, or one char
    while (i < code.length) {
      const c = code[i];
      if (/\s/.test(c)) { i++; continue; }
      if (code.startsWith('//', i) || code.startsWith('/*', i)) { i = skipSpace(i); continue; }
      if (c === '"' || c === "'") { i = skipQuoted(i); prev = '"'; continue; }
      if (c === '`') { i = skipTemplate(i); prev = '"'; continue; }
      if (c === '{') { depth++; prev = '{'; i++; continue; }
      if (c === '}') {
        if (depth === 0 && inBraces) return i;
        depth--; prev = '}'; i++; continue;
      }
      if (c === '/') {
        const operand = /[\w$)\]"]/.test(prev) && !KEYWORDS_BEFORE_EXPR.has(prev);
        const end = operand ? -1 : skipRegex(i); // not a regex after all: treat `/` as an operator
        if (end !== -1) { i = end; prev = '"'; continue; }
      }
      if (c === '<' && /[A-Za-z>]/.test(code[i + 1] || '') && (prev === '' || !(/[\w$)\]"]/.test(prev)) || KEYWORDS_BEFORE_EXPR.has(prev))) {
        const mark = edits.length;
        try { i = parseElement(i); prev = ')'; continue; } catch { edits.length = mark; }
      }
      if (isId(c)) {
        let j = i;
        while (isId(code[j])) j++;
        prev = code.slice(i, j);
        i = j;
        continue;
      }
      prev = c;
      i++;
    }
    if (inBraces) fail();
    return i;
  }

  // At `<`; returns the index after the element. Throws when it does not close like JSX.
  function parseElement(start) {
    let i = start + 1;
    let name = '';
    if (code[i] !== '>') {
      const m = /^[A-Za-z_$][\w$.:-]*/.exec(code.slice(i, i + 200));
      if (!m) fail();
      name = m[0];
      i += name.length;
      if (HOST_TAG.test(name)) edits.push({ at: i, tag: name, ...where(start), dup: false });
      const self = edits[edits.length - 1];
      // attributes
      for (;;) {
        i = skipSpace(i);
        if (code.startsWith('/>', i)) return i + 2;
        if (code[i] === '>') { i++; break; }
        if (code[i] === '{') { i = scanCode(i + 1, true) + 1; continue; } // {...spread}
        const a = /^[\w$:-]+/.exec(code.slice(i, i + 200));
        if (!a) fail();
        if (a[0] === ATTR && self && self.tag === name) self.dup = true;
        i = skipSpace(i + a[0].length);
        if (code[i] !== '=') continue;
        i = skipSpace(i + 1);
        if (code[i] === '"' || code[i] === "'") { const q = code[i]; const e = code.indexOf(q, i + 1); if (e === -1) fail(); i = e + 1; } else if (code[i] === '{') i = scanCode(i + 1, true) + 1;
        else if (code[i] === '<') i = parseElement(i);
        else fail();
      }
    } else i++;
    // children
    for (;;) {
      while (i < code.length && code[i] !== '<' && code[i] !== '{') i++;
      if (i >= code.length) fail();
      if (code[i] === '{') { i = scanCode(i + 1, true) + 1; continue; }
      if (code[i + 1] === '/') {
        const m = /^<\/\s*([\w$.:-]*)\s*>/.exec(code.slice(i, i + 200));
        if (!m || m[1] !== name) fail();
        return i + m[0].length;
      }
      i = parseElement(i);
    }
  }

  try { scanCode(0, false); } catch { return { code, elements: [] }; } // unscannable file (e.g. an unterminated string): leave it alone
  const attr = (line) => ` ${ATTR}="${file.replace(/"/g, '&quot;')}:${line}"`;
  const live = edits.filter((e) => !e.dup);
  let out = code;
  for (const e of [...live].reverse()) out = out.slice(0, e.at) + attr(e.line) + out.slice(e.at);
  return { code: out, elements: live.map(({ line, col, tag }) => ({ line, col, tag })) };
}

/** Project-relative posix path of an absolute file, or null when it is outside the root. */
export function relativeSource(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}
