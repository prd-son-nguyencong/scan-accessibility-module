import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';

const ROOT = getProjectRoot();

// Parsed-source cache, keyed by project-relative source path.
let tagIndexCache = new Map();

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Utility classes carry no identity — half the page has flex and gap-4. Tokens
// that survive this filter are the ones worth scoring on.
const GENERIC_CLASS_RE = /^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|container|group|w-|h-|min-|max-|p[xytrbl]?-|m[xytrbl]?-|gap-|text-|bg-|border|rounded|shadow|z-|overflow|items-|justify-|self-|order-|col-|row-|space-|leading-|tracking-|font-|opacity-|transition|duration-|ease-|transform|scale-|translate-|rotate-|cursor-|select-|pointer-|size-)/;

function isGenericClass(token) {
  return token.length < 4 || GENERIC_CLASS_RE.test(token) || token.includes(':');
}

/**
 * Blank out Liquid comment blocks while preserving line count, so tag start
 * lines stay accurate.
 */
function stripLiquidComments(src) {
  return src.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
    (block) => block.replace(/[^\n]/g, ' '));
}

/**
 * Find the index of the `>` that closes the tag starting at `start`, skipping
 * over quoted attribute values and Liquid `{{ }}` / `{% %}` expressions — both
 * of which routinely contain a bare `>`.
 */
function findTagEnd(src, start) {
  let i = start;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (ch === '{' && (src[i + 1] === '{' || src[i + 1] === '%')) {
      const close = src[i + 1] === '{' ? '}}' : '%}';
      const end = src.indexOf(close, i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (ch === '>') return i;
    i += 1;
  }
  return -1;
}

function parseAttrs(tagBody) {
  const attrs = {};
  // name, then optionally = and a quoted / bare value. Liquid inside the value
  // is kept verbatim; callers decide how to interpret it.
  const re = /([A-Za-z_@:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(tagBody)) !== null) {
    const name = m[1].toLowerCase();
    if (name === 'endif' || name === 'if' || name === 'else') continue;
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function hasLiquid(value) {
  return /\{\{|\{%/.test(value);
}

/**
 * Turn a partly-interpolated attribute value into a regex that the rendered
 * value must satisfy. `id="{{ id }}-tab-{{ i }}"` becomes /^.*-tab-.*$/, which
 * matches the rendered `steps-tab-1` without needing to evaluate the template.
 */
function liquidValueToRegex(value) {
  const parts = value.split(/\{\{[^}]*\}\}|\{%[^%]*%\}/g);
  const pattern = parts
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return null;
  }
}

/**
 * Parse one .liquid file into a list of open tags:
 *   { tagName, line, attrs, staticClasses, staticAttrs, dynamicAttrs, contentStart }
 */
export function buildTagIndex(sourceFile) {
  const cached = tagIndexCache.get(sourceFile);
  if (cached) return cached;

  const fullPath = path.join(ROOT, sourceFile);
  if (!existsSync(fullPath)) {
    tagIndexCache.set(sourceFile, []);
    return [];
  }

  let raw;
  try { raw = readFileSync(fullPath, 'utf8'); } catch { return []; }
  const src = stripLiquidComments(raw);

  // Precompute line starts for O(log n) offset → line lookups.
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const tags = [];
  const openRe = /<([A-Za-z][\w:-]*)(?=[\s/>])/g;
  let m;
  while ((m = openRe.exec(src)) !== null) {
    const tagName = m[1].toLowerCase();
    const end = findTagEnd(src, m.index);
    if (end === -1) continue;
    const body = src.slice(m.index + m[0].length, end);
    const attrs = parseAttrs(body);

    const classValue = attrs.class || '';
    const staticClasses = classValue
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .replace(/\{%[^%]*%\}/g, ' ')
      .split(/\s+/)
      .filter((c) => c && !isGenericClass(c));

    const staticAttrs = {};
    const dynamicAttrs = {};
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'class') continue;
      if (hasLiquid(value)) {
        const re = liquidValueToRegex(value);
        if (re) dynamicAttrs[name] = re;
      } else {
        staticAttrs[name] = value;
      }
    }

    // The instrumented build stamps `data-pdk-out="expr"` on the element that
    // renders `{{ expr }}`, so record what each tag outputs first.
    const contentPeek = src.slice(end + 1, end + 400);
    const outMatch = contentPeek.match(/^[^<]*\{\{-?\s*([^}]+?)\s*-?\}\}/);
    const outExpr = outMatch ? outMatch[1].replace(/\s+/g, ' ') : null;

    tags.push({
      tagName,
      outExpr,
      line: lineOf(m.index),
      staticClasses,
      staticAttrs,
      dynamicAttrs,
      selfClosing: VOID_TAGS.has(tagName) || src[end - 1] === '/',
      contentStart: end + 1,
      openStart: m.index,
    });
    openRe.lastIndex = end + 1;
  }

  tagIndexCache.set(sourceFile, tags);
  return tags;
}

/**
 * Index the `{% render 'name', a: 1, b: 2 %}` / `{% include %}` call sites in a
 * source file. The instrumented build stamps each rendered component with
 * `data-pdk-render="name"` and one `data-pdk-param-<key>` per argument, holding
 * the argument source text verbatim — so a call site can be matched exactly,
 * even though the component's own markup lives in another file entirely.
 */
export function buildRenderIndex(sourceFile) {
  const cacheKey = `render:${sourceFile}`;
  const cached = tagIndexCache.get(cacheKey);
  if (cached) return cached;

  const fullPath = path.join(ROOT, sourceFile);
  if (!existsSync(fullPath)) {
    tagIndexCache.set(cacheKey, []);
    return [];
  }

  let raw;
  try { raw = readFileSync(fullPath, 'utf8'); } catch { return []; }
  const src = stripLiquidComments(raw);
  const lines = src.split('\n');

  const calls = [];
  const re = /\{%-?\s*(render|include)\s+(?:'([^']+)'|"([^"]+)")([^%]*)%\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = (m[2] || m[3]).replace(/\.liquid$/, '');
    const argText = m[4] || '';
    const params = {};
    // `key: value` pairs, value being a quoted string, number, or bareword.
    const argRe = /([A-Za-z_][\w-]*)\s*:\s*('[^']*'|"[^"]*"|[^,%\s]+)/g;
    let a;
    while ((a = argRe.exec(argText)) !== null) params[a[1].toLowerCase()] = a[2];
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({ name, params, line, raw: lines[line - 1] || '' });
  }

  tagIndexCache.set(cacheKey, calls);
  return calls;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Match a rendered element carrying `data-pdk-render` back to the `{% render %}`
 * line that produced it.
 */
export function findLineForRenderTag(sourceFile, rendered) {
  const component = rendered.attrs['data-pdk-render'] || rendered.attrs['data-pdk-partial'];
  if (!component) return null;
  const wanted = component.replace(/\.liquid$/, '');

  const renderedParams = {};
  for (const [name, value] of Object.entries(rendered.attrs)) {
    const key = name.match(/^data-pdk-param-(.+)$/)?.[1];
    if (key) renderedParams[key] = decodeEntities(value);
  }

  const calls = buildRenderIndex(sourceFile).filter((c) => c.name === wanted
    || c.name.split('/').pop() === wanted.split('/').pop());
  if (calls.length === 0) return null;

  let best = null;
  let bestScore = -1;
  let tied = false;
  for (const call of calls) {
    let score = 0;
    for (const [key, value] of Object.entries(renderedParams)) {
      const sourceValue = call.params[key];
      if (sourceValue === undefined) continue;
      // Source keeps its own quotes in the stamped attribute, so compare both
      // the raw token and its unquoted form.
      const unquoted = sourceValue.replace(/^['"]|['"]$/g, '');
      const target = value.replace(/^['"]|['"]$/g, '');
      score += (sourceValue === value || unquoted === target) ? 4 : -2;
    }
    if (score > bestScore) { bestScore = score; best = call; tied = false; }
    else if (score === bestScore) tied = true;
  }

  if (!best || bestScore <= 0) {
    return calls.length === 1
      ? { line: calls[0].line, confidence: 'medium', method: 'liquid-render-call', ambiguous: false }
      : null;
  }
  return {
    line: best.line,
    confidence: tied ? 'medium' : 'high',
    method: 'liquid-render-call',
    ambiguous: tied,
  };
}

/**
 * Parse the opening tag of a rendered outerHTML string.
 */
export function parseRenderedTag(outerHTML) {
  const raw = (outerHTML || '').trim();
  // Some layers hand back a window around the element rather than the element
  // itself ("...html --><script src=..."), so start at the first real tag.
  const startIdx = raw.search(/<[A-Za-z][\w:-]*[\s/>]/);
  if (startIdx === -1) return null;
  const html = raw.slice(startIdx);
  const m = html.match(/^<([A-Za-z][\w:-]*)/);
  if (!m) return null;
  const end = findTagEnd(html, 0);
  const body = end === -1 ? html.slice(m[0].length) : html.slice(m[0].length, end);
  const attrs = parseAttrs(body);
  const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
  return { tagName: m[1].toLowerCase(), attrs, classes, classSet: new Set(classes) };
}

// Attributes worth scoring: stable, authored, and rarely rewritten at runtime.
const SCORED_ATTRS = [
  'id', 'href', 'src', 'type', 'role', 'name', 'alt', 'title', 'placeholder',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
  'aria-expanded', 'aria-controls', 'aria-current', 'data-testid', 'for', 'value',
];

/**
 * Score one source tag against a rendered element. Returns -1 for a reject.
 */
function scoreTag(tag, rendered) {
  if (tag.tagName !== rendered.tagName) return -1;

  let score = 1;

  const outAttr = rendered.attrs['data-pdk-out'];
  if (outAttr && tag.outExpr) {
    if (tag.outExpr === outAttr.trim()) score += 6;
  }

  if (tag.staticClasses.length > 0) {
    let matched = 0;
    for (const cls of tag.staticClasses) if (rendered.classSet.has(cls)) matched += 1;
    // A source tag whose own distinctive classes are all absent from the
    // rendered element is a different element, not a weak match.
    if (matched === 0) return -1;
    score += matched * 4;
    score -= (tag.staticClasses.length - matched);
  }

  for (const name of SCORED_ATTRS) {
    const renderedValue = rendered.attrs[name];
    if (renderedValue === undefined) {
      if (tag.staticAttrs[name] !== undefined) score -= 1;
      continue;
    }
    if (tag.staticAttrs[name] !== undefined) {
      score += tag.staticAttrs[name] === renderedValue ? 5 : -2;
    } else if (tag.dynamicAttrs[name]) {
      score += tag.dynamicAttrs[name].test(renderedValue) ? 3 : -1;
    }
  }

  return score;
}

/**
 * Locate the 1-based line in `sourceFile` that renders `outerHTML`.
 * Returns { line, confidence, method, ambiguous } or null.
 */
export function findLineForRenderedHtml(sourceFile, outerHTML) {
  const rendered = parseRenderedTag(outerHTML);
  if (!rendered) return null;

  // A component instance points at its call site, not at the component's own
  // markup — the file we were given is the caller.
  const renderHit = findLineForRenderTag(sourceFile, rendered);
  if (renderHit) return renderHit;

  const tags = buildTagIndex(sourceFile);
  if (tags.length === 0) return null;

  let best = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const tag of tags) {
    const score = scoreTag(tag, rendered);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = tag;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best) return null;

  const sameTagCount = tags.filter((t) => t.tagName === rendered.tagName).length;
  const decisive = bestScore >= 5 && bestScore > runnerUp;
  return {
    line: best.line,
    confidence: decisive ? 'high' : 'medium',
    method: 'liquid-tag-index',
    ambiguous: !decisive && sameTagCount > 1,
    score: bestScore,
  };
}

/**
 * Locate a line from a tag name plus its visible text — the only signal the
 * keyboard layer carries. Text authored inline in the template is found
 * directly; text that came from a data file falls back to a unique tag match.
 */
export function findLineForTagText(sourceFile, tagName, text) {
  const tags = buildTagIndex(sourceFile);
  if (tags.length === 0) return null;
  const wanted = (tagName || '').toLowerCase();
  const candidates = tags.filter((t) => t.tagName === wanted);
  if (candidates.length === 0) return null;

  const needle = (text || '').trim().slice(0, 60);
  if (needle.length >= 3) {
    const fullPath = path.join(ROOT, sourceFile);
    try {
      const lines = stripLiquidComments(readFileSync(fullPath, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes(needle)) continue;
        // Walk back to the nearest enclosing tag of the right kind.
        const textLine = i + 1;
        let owner = null;
        for (const tag of candidates) {
          if (tag.line <= textLine && (!owner || tag.line > owner.line)) owner = tag;
        }
        if (owner) {
          return { line: owner.line, confidence: 'high', method: 'liquid-text-anchor', ambiguous: false };
        }
      }
    } catch { /* fall through */ }
  }

  if (candidates.length === 1) {
    return { line: candidates[0].line, confidence: 'medium', method: 'liquid-unique-tag', ambiguous: false };
  }
  return null;
}

/**
 * Locate a line from an href. Handles both literal hrefs and interpolated ones.
 */
export function findLineForHref(sourceFile, href) {
  if (!href) return null;
  const tags = buildTagIndex(sourceFile);
  const exact = [];
  const loose = [];
  for (const tag of tags) {
    const staticHref = tag.staticAttrs.href;
    if (staticHref !== undefined) {
      if (staticHref === href) exact.push(tag);
      continue;
    }
    if (tag.dynamicAttrs.href && tag.dynamicAttrs.href.test(href)) loose.push(tag);
  }
  if (exact.length === 1) return { line: exact[0].line, confidence: 'high', method: 'liquid-href-exact', ambiguous: false };
  if (exact.length > 1) return { line: exact[0].line, confidence: 'medium', method: 'liquid-href-exact', ambiguous: true };
  if (loose.length === 1) return { line: loose[0].line, confidence: 'medium', method: 'liquid-href-pattern', ambiguous: false };
  return null;
}

export function clearTagIndexCache() {
  tagIndexCache = new Map();
}

// ─── Document-level resolution ───────────────────────────────────────────────

const LAYOUT_DEFAULT = 'layout';
const RENDER_DEPTH_LIMIT = 3;

function layoutForPage(pageFile) {
  const fullPath = path.join(ROOT, pageFile);
  if (!existsSync(fullPath)) return LAYOUT_DEFAULT;
  try {
    const head = readFileSync(fullPath, 'utf8').slice(0, 2000);
    const m = head.match(/\{%-?\s*layout\s+(?:'([^']+)'|"([^"]+)")/);
    return (m && (m[1] || m[2])) || LAYOUT_DEFAULT;
  } catch {
    return LAYOUT_DEFAULT;
  }
}

function renderTargetToFile(name) {
  const normalized = name.replace(/\\/g, '/').replace(/\.liquid$/, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  const candidates = normalized.startsWith('components/')
    ? [`src/${normalized}.liquid`]
    : [`src/partials/${normalized}.liquid`, `src/components/${normalized}.liquid`];
  return candidates.find((c) => existsSync(path.join(ROOT, c))) || null;
}

/**
 * Walk the render tree rooted at a page's layout, looking for the file and line
 * that produced a document-level element. `<html>`, `<body>`, and the script and
 * link tags live in the layout chain, never in the page body — attributing them
 * to the page file gives a file with no line in it.
 *
 * @returns {{ file, line, confidence, method } | null}
 */
export function findDocumentSource(pageFile, outerHTML) {
  const rendered = parseRenderedTag(outerHTML);
  if (!rendered) return null;

  const layoutName = layoutForPage(pageFile);
  const layoutFile = `src/layouts/${layoutName}.liquid`;

  // Search the page's own partials as well as the layout chain: a page file
  // that only composes `{% render %}` calls holds none of the markup a
  // violation points at.
  const roots = [];
  if (pageFile && existsSync(path.join(ROOT, pageFile))) roots.push({ file: pageFile, depth: 0 });
  if (existsSync(path.join(ROOT, layoutFile))) roots.push({ file: layoutFile, depth: 0 });
  if (roots.length === 0) return null;

  const seen = new Set();
  let queue = roots;
  let fallback = null;

  while (queue.length > 0) {
    const next = [];
    for (const { file, depth } of queue) {
      if (seen.has(file)) continue;
      seen.add(file);

      const hit = file === pageFile ? null : findLineForRenderedHtml(file, outerHTML);
      if (hit && hit.confidence === 'high' && !hit.ambiguous) {
        return { file, line: hit.line, confidence: 'high', method: `render-tree:${hit.method}` };
      }
      if (hit && !fallback) {
        fallback = { file, line: hit.line, confidence: 'medium', method: `render-tree:${hit.method}` };
      }

      if (depth >= RENDER_DEPTH_LIMIT) continue;
      for (const call of buildRenderIndex(file)) {
        const target = renderTargetToFile(call.name);
        if (target && !seen.has(target)) next.push({ file: target, depth: depth + 1 });
      }
    }
    queue = next;
  }

  return fallback;
}

/**
 * True when an element belongs to the document shell rather than to page
 * content — the case where `findDocumentSource` is worth trying.
 */
export function isDocumentLevelElement(outerHTML) {
  const rendered = parseRenderedTag(outerHTML);
  if (!rendered) return false;
  return ['html', 'body', 'head', 'script', 'link', 'meta', 'title'].includes(rendered.tagName);
}

/**
 * Anchor line for a page-level finding — one that reports the absence of
 * something ("no h1", "no main landmark", "no skip link") and so has no element
 * to point at. The anchor is where the missing markup would go.
 */
export function findPageLevelAnchor(pageFile, ruleId) {
  const rule = (ruleId || '').toLowerCase();

  // What the rule is about decides where a fix would be written. These are
  // anchors, not the location of an element — the element does not exist.
  let probe = null;
  if (/carousel|slide/.test(rule)) probe = /data-carousel|embla|carousel/i;
  else if (/h1|heading/.test(rule)) probe = /<h1|<h2/i;
  else if (/main|landmark/.test(rule)) probe = /<main/i;
  else if (/skip-link/.test(rule)) probe = /skip/i;
  else if (/focus-order|tabindex/.test(rule)) probe = /<main|tabindex/i;

  for (const file of collectRenderTree(pageFile)) {
    const fullPath = path.join(ROOT, file);
    if (!existsSync(fullPath)) continue;
    let content;
    try { content = stripLiquidComments(readFileSync(fullPath, 'utf8')); } catch { continue; }
    if (probe) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (probe.test(lines[i])) {
          return { file, line: i + 1, confidence: 'low', method: 'page-level-anchor' };
        }
      }
      continue;
    }
    const tags = buildTagIndex(file);
    const anchor = tags.find((t) => t.tagName === 'main') || tags.find((t) => t.tagName === 'body');
    if (anchor) return { file, line: anchor.line, confidence: 'low', method: 'page-level-anchor' };
  }

  // Nothing matched: point at the layout's <main>, the insertion site for
  // anything the page as a whole is missing.
  const layoutFile = `src/layouts/${layoutForPage(pageFile)}.liquid`;
  const layoutTags = buildTagIndex(layoutFile);
  const fallback = layoutTags.find((t) => t.tagName === 'main') || layoutTags.find((t) => t.tagName === 'body');
  return fallback
    ? { file: layoutFile, line: fallback.line, confidence: 'low', method: 'page-level-anchor' }
    : null;
}

/**
 * Every source file reachable from a page: the page, its layout, and the
 * partials and components they render, breadth-first.
 */
export function collectRenderTree(pageFile, depthLimit = RENDER_DEPTH_LIMIT) {
  const layoutFile = `src/layouts/${layoutForPage(pageFile)}.liquid`;
  const seen = new Set();
  const ordered = [];
  let queue = [pageFile, layoutFile]
    .filter((f) => f && existsSync(path.join(ROOT, f)))
    .map((file) => ({ file, depth: 0 }));

  while (queue.length > 0) {
    const next = [];
    for (const { file, depth } of queue) {
      if (seen.has(file)) continue;
      seen.add(file);
      ordered.push(file);
      if (depth >= depthLimit) continue;
      for (const call of buildRenderIndex(file)) {
        const target = renderTargetToFile(call.name);
        if (target && !seen.has(target)) next.push({ file: target, depth: depth + 1 });
      }
    }
    queue = next;
  }
  return ordered;
}

