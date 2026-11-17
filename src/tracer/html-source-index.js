import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Own tokenizer: parse5/htmlparser2 only exist as transitive pnpm entries, not resolvable dependencies.
// shortcut: implied end tags cover li/dt/dd/tr/td/th/option/p-after-p only (no full HTML5 tree builder);
// upgrade to parse5 with sourceCodeLocationInfo if a source folder relies on other omitted end tags.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const IMPLIED_CLOSE = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['td', 'th', 'tr'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'], p: ['p'],
};
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

const ws = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Parse HTML into elements with 1-based line/col of each start tag.
 * @returns {{ roots: object[], elements: object[] }} element: { tag, attrs, line, col, parent, kids }
 *   (`kids`: child elements and text strings; script/style bodies are not kept)
 */
export function parseHtml(src) {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const where = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - lineStarts[lo] + 1 };
  };

  const roots = [];
  const elements = [];
  const stack = [];
  const top = () => stack[stack.length - 1];
  const addKid = (kid) => (top() ? top().kids.push(kid) : typeof kid === 'string' || roots.push(kid));

  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const end = next === -1 ? src.length : next;
      if (top()) top().kids.push(src.slice(i, end));
      i = end;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    const closing = /^<\/([A-Za-z][^\s/>]*)/.exec(src.slice(i, i + 80));
    if (closing) {
      const name = closing[1].toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at !== -1) stack.length = at;
      const end = src.indexOf('>', i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const opening = /^<([A-Za-z][^\s/>]*)/.exec(src.slice(i, i + 80));
    if (!opening) {
      // `<!doctype>`, `<?..?>` or a stray `<`
      const end = /^<[!?]/.test(src.slice(i, i + 2)) ? src.indexOf('>', i) : -1;
      i = end === -1 ? i + 1 : end + 1;
      continue;
    }
    const tag = opening[1].toLowerCase();
    // Attributes: quoted values may contain `>`.
    const attrs = {};
    let j = i + opening[0].length;
    let selfClosed = false;
    const attrRe = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?|\s*(\/?>)/y;
    for (;;) {
      attrRe.lastIndex = j;
      const m = attrRe.exec(src);
      if (!m) { j = src.length; break; }
      j = attrRe.lastIndex;
      if (m[5]) { selfClosed = m[5] === '/>'; break; }
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    while (top() && (IMPLIED_CLOSE[tag] || []).includes(top().tag)) stack.pop();
    const el = { tag, attrs, ...where(i), parent: top() || null, kids: [] };
    elements.push(el);
    addKid(el);
    i = j;
    if (RAW_TEXT.has(tag) && !selfClosed) {
      const close = new RegExp(`</${tag}\\b`, 'i').exec(src.slice(i));
      const end = close ? i + close.index : src.length;
      if (tag === 'title' || tag === 'textarea') el.kids.push(src.slice(i, end));
      i = end; // the end tag is consumed by the generic branch next iteration
    } else if (!VOID.has(tag) && !selfClosed) stack.push(el);
  }
  return { roots, elements };
}

export const textOf = (el) => ws(el.kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' '));

/** Attribute/whitespace-insensitive structure string; equal for the source tag and the DOM serialisation of it. */
export function canonical(el) {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => `${k}="${k === 'class' ? ws(v).split(' ').sort().join(' ') : ws(v)}"`)
    .sort().join(' ');
  const inner = el.kids.map((k) => (typeof k === 'string' ? ws(k) : canonical(k))).filter(Boolean).join('');
  return `<${el.tag} ${attrs}>${inner}</${el.tag}>`;
}

export const hashOf = (el) => createHash('sha1').update(canonical(el)).digest('hex');

/** `["main", "nav", "#nav", "ul"]`-style ancestor path of an element, root first (an id follows its tag). */
export function ancestry(el) {
  const out = [];
  for (let p = el.parent; p; p = p.parent) out.unshift(...(p.attrs.id ? [p.tag, `#${p.attrs.id}`] : [p.tag]));
  return out;
}

const cache = new Map();

/** Indexed elements of one project-relative html file: { file, tag, id, classes, attrs, text, line, col, hash, ancestry }. */
export function indexHtmlFile(file, root) {
  const abs = path.join(root, file);
  const { mtimeMs, size } = statSync(abs);
  const key = `${abs}|${mtimeMs}|${size}`;
  if (!cache.has(key)) {
    const { elements } = parseHtml(readFileSync(abs, 'utf8'));
    cache.set(key, elements.map((el) => ({
      file,
      tag: el.tag,
      id: el.attrs.id || null,
      classes: (el.attrs.class || '').split(/\s+/).filter(Boolean),
      attrs: el.attrs,
      text: textOf(el),
      line: el.line,
      col: el.col,
      hash: hashOf(el),
      ancestry: ancestry(el),
    })));
  }
  return cache.get(key);
}

/** Project-relative `.html` / `.htm` files under root (no hidden dirs, node_modules, dist, build). */
export function htmlFiles(root, rel = '') {
  let entries;
  try { entries = readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name.startsWith('.') || SKIP_DIRS.has(e.name) ? [] : htmlFiles(root, next);
    return /\.html?$/i.test(e.name) ? [next] : [];
  }).sort();
}
