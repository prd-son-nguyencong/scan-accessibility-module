import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { getProjectRoot, containedPath } from '../utils/paths.js';

const ROOT = getProjectRoot();

// Parsed-source cache, keyed by project-relative source path (and root, when not the default one).
let tagIndexCache = new Map();
const cacheKeyFor = (root, key) => (root === ROOT ? key : `${root}\0${key}`);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Utility classes carry no identity — half the page has flex and gap-4. Tokens
// that survive this filter are the ones worth scoring on.
const GENERIC_CLASS_RE = /^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|container|group|w-|h-|min-|max-|p[xytrbl]?-|m[xytrbl]?-|gap-|text-|bg-|border|rounded|shadow|z-|overflow|items-|justify-|self-|order-|col-|row-|space-|leading-|tracking-|font-|opacity-|transition|duration-|ease-|transform|scale-|translate-|rotate-|cursor-|select-|pointer-|size-)/;

export function isGenericClass(token) {
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
export function buildTagIndex(sourceFile, root = ROOT) {
  const cacheKey = cacheKeyFor(root, sourceFile);
  const cached = tagIndexCache.get(cacheKey);
  if (cached) return cached;

  const fullPath = containedPath(root, sourceFile);
  if (!fullPath || !existsSync(fullPath)) {
    tagIndexCache.set(cacheKey, []);
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
    // A class assembled by Liquid (`banner--{{ kind }}`) is a pattern, not a literal: its static parts must not count as a class the element lacks.
    const classTokens = classValue.replace(/\{\{[^}]*\}\}|\{%[^%]*%\}/g, '\u0000').split(/\s+/).filter(Boolean);
    const staticClasses = classTokens.filter((c) => !c.includes('\u0000') && !isGenericClass(c));
    const dynamicClasses = classTokens.filter((c) => c.includes('\u0000') && c.replace(/\u0000/g, '').length >= 3)
      .map((c) => new RegExp(`^${c.split('\u0000').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));

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

    // Leading text up to the next tag; null when Liquid could change it or nothing is authored there.
    const leading = src.slice(end + 1, src.indexOf('<', end + 1) === -1 ? end + 1 : src.indexOf('<', end + 1));
    const text = /[{}]/.test(leading) || !leading.trim() ? null : leading.replace(/\s+/g, ' ').trim();

    tags.push({
      tagName,
      text,
      outExpr,
      line: lineOf(m.index),
      staticClasses,
      classTokens: classTokens.filter((c) => !c.includes('\u0000')),
      dynamicClasses,
      staticAttrs,
      dynamicAttrs,
      hasClass: attrs.class !== undefined,
      // A token that is all Liquid (`class="{{ klass }}"`) could render any class: what the element carries beyond the literal tokens proves nothing against this tag.
      opaqueClass: classTokens.some((c) => c.includes('\u0000') && c.replace(/\u0000/g, '').length < 3),
      selfClosing: VOID_TAGS.has(tagName) || src[end - 1] === '/',
      contentStart: end + 1,
      openStart: m.index,
    });
    openRe.lastIndex = end + 1;
  }

  tagIndexCache.set(cacheKey, tags);
  return tags;
}

/**
 * Index the `{% render 'name', a: 1, b: 2 %}` / `{% include %}` call sites in a
 * source file. The instrumented build stamps each rendered component with
 * `data-pdk-render="name"` and one `data-pdk-param-<key>` per argument, holding
 * the argument source text verbatim — so a call site can be matched exactly,
 * even though the component's own markup lives in another file entirely.
 */
export function buildRenderIndex(sourceFile, root = ROOT) {
  const cacheKey = cacheKeyFor(root, `render:${sourceFile}`);
  const cached = tagIndexCache.get(cacheKey);
  if (cached) return cached;

  const fullPath = containedPath(root, sourceFile);
  if (!fullPath || !existsSync(fullPath)) {
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
export function findLineForRenderTag(sourceFile, rendered, root = ROOT) {
  const component = rendered.attrs['data-pdk-render'] || rendered.attrs['data-pdk-partial'];
  if (!component) return null;
  const wanted = component.replace(/\.liquid$/, '');

  const renderedParams = {};
  for (const [name, value] of Object.entries(rendered.attrs)) {
    const key = name.match(/^data-pdk-param-(.+)$/)?.[1];
    if (key) renderedParams[key] = decodeEntities(value);
  }

  // The stamped attribute is the argument's source text: a call whose same-named argument reads differently did not render this element
  // (a value cut short by truncation still prefixes the real one).
  const disagrees = (call) => Object.entries(renderedParams).some(([key, value]) => {
    const sourceValue = call.params[key];
    if (sourceValue === undefined) return false;
    const target = value.replace(/^['"]|['"]$/g, '').replace(/(?:\.\.\.|…)$/, '');
    return !sourceValue.replace(/^['"]|['"]$/g, '').startsWith(target);
  });
  const named = buildRenderIndex(sourceFile, root).filter((c) => c.name === wanted
    || c.name.split('/').pop() === wanted.split('/').pop());
  const calls = named.filter((c) => !disagrees(c));
  if (calls.length === 0) return null;

  let best = null;
  let bestScore = -1;
  let tied = false;
  let tiedCalls = [];
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
    if (score > bestScore) { bestScore = score; best = call; tied = false; tiedCalls = [call]; }
    else if (score === bestScore) { tied = true; tiedCalls.push(call); }
  }

  // Every parameter the live element carries disagrees with this call site: it did not render the element.
  if (bestScore < 0) return null;
  if (!best || bestScore <= 0) {
    return calls.length === 1
      ? { line: calls[0].line, lines: [calls[0].line], confidence: 'medium', method: 'liquid-render-call', ambiguous: false }
      : null;
  }
  return {
    line: best.line,
    lines: tiedCalls.map((c) => c.line),
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
  // Leading text, only when a tag follows it (an outerHTML cut mid-text proves nothing).
  const after = end === -1 ? '' : html.slice(end + 1);
  const next = after.indexOf('<');
  const text = next > 0 && after.slice(0, next).trim() ? after.slice(0, next).replace(/\s+/g, ' ').trim() : null;
  return { tagName: m[1].toLowerCase(), text, attrs, classes, classSet: new Set(classes) };
}

// Attributes worth scoring: stable, authored, and rarely rewritten at runtime.
const SCORED_ATTRS = [
  'id', 'href', 'src', 'type', 'role', 'name', 'alt', 'title', 'placeholder',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
  'aria-expanded', 'aria-controls', 'aria-current', 'data-testid', 'for', 'value',
];

// Fallback when the scanned page's host is unknown: the host a dev server resolves a root-relative URL against is a single-label name (localhost, a container name), a .localhost / .test / .local name, an address literal or host.docker.internal.
// `local` is the scanned page's hostname when the caller knows it (exact match, any dev host name works), else true (this guess), else false (deployed page: any host).
const DEV_HOST = /^([^.]+|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3}|[^.]+\.(localhost|test|local)|host\.docker\.internal)$/i;

/**
 * A root-relative authored `href` / `src` (`/jobs`) equals the rendered absolute form (`http://host/jobs`): the browser and the dev server resolve it.
 * With `local` (a scan of the local dev server) only the dev server's own host resolves it: `https://other.example/jobs` is another site's link, not this tag.
 */
function sameAttrValue(name, authored, rendered, local = false) {
  if (authored === rendered) return true;
  if ((name !== 'href' && name !== 'src') || !authored.startsWith('/') || authored.startsWith('//')) return false;
  try { const u = new URL(rendered); return /^https?:$/.test(u.protocol) && (!local || (typeof local === 'string' ? u.hostname === local : DEV_HOST.test(u.hostname))) && `${u.pathname}${u.search}${u.hash}` === authored; } catch { return false; }
}

/** A script that appends the route to an authored absolute link (`href += path`): the rendered href starts with the authored one. An authored absolute URL that the rendered one extends (at a path, query or hash boundary) is the same link, not a mismatch. An exact match outranks it (see scoreTag). */
const appendedUrl = (name, authored, rendered) => (name === 'href' || name === 'src') && /^https?:\/\//i.test(authored) && rendered.length > authored.length && rendered.startsWith(authored) && (authored.endsWith('/') || /[/?#]/.test(rendered[authored.length]));

/**
 * Score one source tag against a rendered element. Returns -1 for a reject.
 */
function scoreTag(tag, rendered, local = false) {
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
  } else if (rendered.classes.length > 0 && !tag.hasClass) {
    // The source tag cannot have produced these classes (script-added ones aside): weaken, never decisive.
    score -= 2;
  }
  // A tag whose whole literal class list (variants and utilities included) is on the element is that element, whatever a state class
  // like `current` also matches on a smaller tag.
  if (tag.classTokens.length >= 4 && tag.classTokens.every((c) => rendered.classSet.has(c))) score += 6;
  for (const re of tag.dynamicClasses || []) score += rendered.classes.some((c) => re.test(c)) ? 3 : -1;
  // Utility classes carry no identity alone, but the whole literal list does: a tag that writes classes the element lacks is probably another
  // element (a script adds classes such as `current`, it rarely removes several); one whose list the element contains is the likely author.
  // Never rejects on its own (a script can strip classes); only ranks. Skipped when the element's class list was cut short or the tag's is Liquid.
  if (score > 0 && tag.classTokens.length > 0 && !tag.opaqueClass && tag.dynamicClasses.length === 0 && rendered.classes.length > 0 && !rendered.classes.some((c) => /\u2026|\.\.\./.test(c))) {
    const present = tag.classTokens.filter((c) => rendered.classSet.has(c)).length;
    score = Math.max(1, score + Math.min(present, 4) - 2 * (tag.classTokens.length - present));
  }

  for (const name of SCORED_ATTRS) {
    const renderedValue = rendered.attrs[name];
    if (renderedValue === undefined) {
      if (tag.staticAttrs[name] !== undefined) score -= 1;
      continue;
    }
    if (tag.staticAttrs[name] !== undefined) {
      // byte-equal 6 > equivalent 5 > a dynamic attr 3 > an extended (script-appended) prefix 2: a prefix is weak evidence, never outranks a link that matches
      score += tag.staticAttrs[name] === renderedValue ? 6 : sameAttrValue(name, tag.staticAttrs[name], renderedValue, local) ? 5 : appendedUrl(name, tag.staticAttrs[name], renderedValue) ? 2 : -2;
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
export function findLineForRenderedHtml(sourceFile, outerHTML, root = ROOT, { local = false } = {}) {
  const rendered = parseRenderedTag(outerHTML);
  if (!rendered) return null;

  // A component instance points at its call site, not at the component's own
  // markup — the file we were given is the caller.
  const renderHit = findLineForRenderTag(sourceFile, rendered, root);
  if (renderHit) return renderHit;

  const tags = buildTagIndex(sourceFile, root);
  if (tags.length === 0) return null;

  let best = null;
  let bestScore = 0;
  let runnerUp = 0;
  let bestTags = [];
  for (const tag of tags) {
    const score = scoreTag(tag, rendered, local);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = tag;
      bestTags = [tag];
    } else if (score > 0 && score === bestScore) {
      runnerUp = score;
      bestTags.push(tag);
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best) return null;

  const sameTagCount = tags.filter((t) => t.tagName === rendered.tagName).length;
  const decisive = bestScore >= 5 && bestScore > runnerUp;
  return {
    line: best.line,
    lines: bestTags.map((t) => t.line),
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
export function findLineForTagText(sourceFile, tagName, text, root = ROOT) {
  const tags = buildTagIndex(sourceFile, root);
  if (tags.length === 0) return null;
  const wanted = (tagName || '').toLowerCase();
  const candidates = tags.filter((t) => t.tagName === wanted);
  if (candidates.length === 0) return null;

  const needle = (text || '').trim().slice(0, 60);
  if (needle.length >= 3) {
    const fullPath = containedPath(root, sourceFile);
    try {
      if (!fullPath) throw new Error('outside root');
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
export function findLineForHref(sourceFile, href, root = ROOT) {
  if (!href) return null;
  const tags = buildTagIndex(sourceFile, root);
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

function layoutForPage(pageFile, root = ROOT) {
  const fullPath = containedPath(root, pageFile);
  if (!fullPath || !existsSync(fullPath)) return LAYOUT_DEFAULT;
  try {
    const head = readFileSync(fullPath, 'utf8').slice(0, 2000);
    const m = head.match(/\{%-?\s*layout\s+(?:'([^']+)'|"([^"]+)")/);
    return (m && (m[1] || m[2])) || LAYOUT_DEFAULT;
  } catch {
    return LAYOUT_DEFAULT;
  }
}

function renderTargetToFile(name, root = ROOT) {
  const normalized = name.replace(/\\/g, '/').replace(/\.liquid$/, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  const candidates = normalized.startsWith('components/')
    ? [`src/${normalized}.liquid`]
    : [`src/partials/${normalized}.liquid`, `src/components/${normalized}.liquid`];
  return candidates.find((c) => existsSync(path.join(root, c))) || null;
}

const PAGE_LEVEL_PROBES = [
  [new Set(['carousel-dots-missing-active-state', 'carousel-missing-label', 'carousel-next-button-no-label',
    'carousel-next-not-functional', 'carousel-prev-button-no-label', 'carousel-slides-missing-labels']),
  /data-carousel|embla|carousel/i],
  [new Set(['missing-h1', 'multiple-h1', 'no-headings', 'empty-heading', 'heading-level-skipped', 'page-has-heading-one', 'heading-order']),
    /<h1|<h2/i],
  [new Set(['missing-main-landmark', 'multiple-main-landmarks', 'landmark-one-main', 'landmark-no-duplicate-main']), /<main/i],
  [new Set(['skip-link-missing', 'bypass']), /skip/i],
  [new Set(['focus-order-illogical', 'tabindex']), /<main|tabindex/i],
];

// Rules about the page's structure as a whole. Their fix is authored in the page file, so they anchor
// there even when the reported element (<html>, <body>) is written in the layout.
const PAGE_STRUCTURE_RULES = new Set([
  'landmark-one-main', 'landmark-no-duplicate-main', 'page-has-heading-one', 'bypass', 'region',
  'missing-main-landmark', 'multiple-main-landmarks', 'missing-h1', 'multiple-h1', 'no-headings', 'skip-link-missing',
  'regionmaincontentsingle', 'regionmaincontentmisuse', 'regionmaincontentmismatch', 'skip-link',
]);
// The reported element (the skip link) lives in the layout, but the defect is the missing target, authored in the page's <main>.
const PAGE_TARGET_RULES = new Set(['skip-link', 'bypass', 'skip-link-missing']);
export const isPageTargetRule = (ruleId) => PAGE_TARGET_RULES.has(String(ruleId || '').toLowerCase());
const DOCUMENT_TAGS = new Set(['html', 'head', 'body']);

export const isPageStructureRule = (ruleId) => PAGE_STRUCTURE_RULES.has(String(ruleId || '').toLowerCase());
export const isDocumentTag = (tagName) => DOCUMENT_TAGS.has(tagName);

/**
 * Anchor line for a page-level finding — one that reports the absence of
 * something ("no h1", "no main landmark", "no skip link") and so has no element
 * to point at. The anchor is where the missing markup would go.
 */
export function findPageLevelAnchor(pageFile, ruleId, root = ROOT) {
  const rule = (ruleId || '').toLowerCase();

  // What the rule is about decides where a fix would be written. These are
  // anchors, not the location of an element — the element does not exist.
  // Exact rule ids only: a substring test sent unrelated rules (`domain-...`, `...-remaining`) to a wrong anchor.
  const probe = PAGE_LEVEL_PROBES.find(([ids]) => ids.has(rule))?.[1] || null;

  // Structural rules belong to the page file: the probe line when it has one, else its <main>, else the file alone.
  const pageFull = PAGE_STRUCTURE_RULES.has(rule) && pageFile ? containedPath(root, pageFile) : null;
  if (pageFull && existsSync(pageFull)) {
    const lines = stripLiquidComments(readFileSync(pageFull, 'utf8')).split('\n');
    const probed = probe ? lines.findIndex((l) => probe.test(l)) + 1 : 0;
    const main = buildTagIndex(pageFile, root).find((t) => t.tagName === 'main');
    // No probe hit and no <main> (error/stub page): the page's first element, else its layout include, so the source always carries a line.
    const firstElement = lines.findIndex((l) => /<[a-z]/i.test(l)) + 1;
    const layoutInclude = lines.findIndex((l) => /\{%-?\s*layout\b/.test(l)) + 1;
    return { file: pageFile, line: probed || main?.line || firstElement || layoutInclude || 1, confidence: 'low', method: 'page-level-anchor' };
  }

  for (const file of collectRenderTree(pageFile, RENDER_DEPTH_LIMIT, root)) {
    const fullPath = containedPath(root, file);
    if (!fullPath || !existsSync(fullPath)) continue;
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
    const tags = buildTagIndex(file, root);
    const anchor = tags.find((t) => t.tagName === 'main') || tags.find((t) => t.tagName === 'body');
    if (anchor) return { file, line: anchor.line, confidence: 'low', method: 'page-level-anchor' };
  }

  // Nothing matched: point at the layout's <main>, the insertion site for
  // anything the page as a whole is missing.
  const layoutFile = `src/layouts/${layoutForPage(pageFile, root)}.liquid`;
  const layoutTags = buildTagIndex(layoutFile, root);
  const fallback = layoutTags.find((t) => t.tagName === 'main') || layoutTags.find((t) => t.tagName === 'body');
  return fallback
    ? { file: layoutFile, line: fallback.line, confidence: 'low', method: 'page-level-anchor' }
    : null;
}

function pageFilesOf(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith('.liquid')) out.push(`${dir}/${e.name}`);
    }
  };
  walk('src/pages');
  return out;
}

/**
 * Where a missing skip link is fixed: the header the layout renders, not the page <main> it would target. Only when the same header (or, failing a
 * header partial, the same layout) serves every page of the project; otherwise null and the page anchor stays the only answer.
 * @returns {{ file: string, line: number, confidence: 'low', method: 'page-level-anchor', shared: string } | null}
 */
export function findSkipLinkHome(pageFile, root = ROOT) {
  const pages = pageFilesOf(root);
  if (!pageFile || !pages.length) return null;
  const byLayout = new Map();
  for (const f of pages) { const l = layoutForPage(f, root); if (!byLayout.has(l)) byLayout.set(l, f); }
  const tree = collectRenderTree(pageFile, RENDER_DEPTH_LIMIT, root);
  const header = tree.find((f) => /^src\/(partials|components)\/(?:[^/]+\/)*header[^/]*\.liquid$/i.test(f));
  if (header && [...byLayout.values()].every((f) => collectRenderTree(f, RENDER_DEPTH_LIMIT, root).includes(header))) {
    const first = buildTagIndex(header, root)[0];
    if (first) return { file: header, line: first.line, confidence: 'low', method: 'page-level-anchor', shared: `${header} is rendered by every page layout` };
  }
  if (byLayout.size !== 1) return null;
  const layoutFile = `src/layouts/${layoutForPage(pageFile, root)}.liquid`;
  const body = buildTagIndex(layoutFile, root).find((t) => t.tagName === 'body');
  return body ? { file: layoutFile, line: body.line, confidence: 'low', method: 'page-level-anchor', shared: `${layoutFile} is the layout of every page` } : null;
}

/**
 * Every source file reachable from a page: the page, its layout, and the
 * partials and components they render, breadth-first.
 */
export function collectRenderTree(pageFile, depthLimit = RENDER_DEPTH_LIMIT, root = ROOT) {
  const layoutFile = `src/layouts/${layoutForPage(pageFile, root)}.liquid`;
  const seen = new Set();
  const ordered = [];
  let queue = [pageFile, layoutFile]
    .filter((f) => f && existsSync(path.join(root, f)))
    .map((file) => ({ file, depth: 0 }));

  while (queue.length > 0) {
    const next = [];
    for (const { file, depth } of queue) {
      if (seen.has(file)) continue;
      seen.add(file);
      ordered.push(file);
      if (depth >= depthLimit) continue;
      for (const call of buildRenderIndex(file, root)) {
        const target = renderTargetToFile(call.name, root);
        if (target && !seen.has(target)) next.push({ file: target, depth: depth + 1 });
      }
    }
    queue = next;
  }
  return ordered;
}

