import { existsSync, readFileSync } from 'node:fs';
import { containedPath } from '../utils/paths.js';
import { parseRenderedTag } from './liquid-tag-index.js';

/**
 * Preview (Studio) HTML has no snippet markers, so a preview element is matched against the local
 * instrumented build of the same page instead: every local element gets a fingerprint (tag, stable
 * classes, a few attributes, short text, ancestry, sibling position) and the best unique match is
 * traced with the normal local pipeline (marker owner + liquid-tag-index). A tie is never broken.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea']);
const LANDMARKS = new Set(['header', 'nav', 'main', 'footer', 'aside', 'section', 'form']);
const ATTRS = ['id', 'href', 'src', 'type', 'role', 'name', 'alt', 'title', 'aria-label', 'aria-hidden', 'for', 'value', 'placeholder',
  'content', 'rel', 'charset', 'd', 'viewbox', 'width', 'height'];
// Tags a page has once: a lone local one is itself evidence for a lone preview one.
const SINGLETONS = new Set(['title', 'main', 'h1']);
// Generated class names (css-1a2b3c, sc-abc123, _x_9f3a1) change per deploy and say nothing about the source.
const NOISE_CLASS = /^(?:css|sc|jsx|svelte|ng|emotion|styled)-[\w-]*\d|[-_][0-9a-f]{5,}$|^_/i;

export const FINGERPRINT = Object.freeze({ MIN_SCORE: 8, MARGIN: 4, HIGH_SCORE: 12 });

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const stableClasses = (classes) => classes.filter((c) => c.length >= 3 && !NOISE_CLASS.test(c));

/** Tokenize HTML into elements with owner regions (snippet markers), parent chain and sibling index. */
export function indexHtml(html) {
  const elements = [];
  const roots = [];
  const stack = [];
  const owners = [];
  const re = /<!--([\s\S]*?)-->|<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+|<)/g;
  let m;
  const closeTop = (end) => { stack.pop().end = end; };
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const open = m[1].match(/^\s*snippets\/(\S+?)\.html\s*$/);
      const close = m[1].match(/^\s*\/snippets\/(\S+?)\.html\s*$/);
      if (open) owners.push(open[1]);
      else if (close && owners.includes(close[1])) owners.length = owners.lastIndexOf(close[1]);
    } else if (m[3] !== undefined) {
      const tag = m[3].toLowerCase();
      if (m[2]) {
        const at = stack.map((e) => e.tag).lastIndexOf(tag);
        while (at !== -1 && stack.length > at) closeTop(m.index + m[0].length);
        continue;
      }
      const parent = stack[stack.length - 1] || null;
      const siblings = parent ? parent.kids : roots;
      const attrs = parseRenderedTag(m[0])?.attrs || {};
      const el = {
        tag, attrs, parent, kids: [], start: m.index, end: m.index + m[0].length, text: '',
        classes: stableClasses((attrs.class || '').split(/\s+/).filter(Boolean)),
        owners: [...owners], childIndex: siblings.length + 1,
        typeIndex: siblings.filter((e) => e.tag === tag).length + 1,
      };
      siblings.push(el);
      elements.push(el);
      if (m[4].endsWith('/') || VOID.has(tag)) continue;
      if (RAW_TEXT.has(tag)) {
        const close = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        const end = close === -1 ? html.length : html.indexOf('>', close) + 1 || html.length;
        el.end = end;
        re.lastIndex = end;
        continue;
      }
      stack.push(el);
    } else if (stack.length > 0) {
      for (const open of stack) if (open.text.length < 200) open.text += ` ${m[5]}`;
    }
  }
  while (stack.length > 0) closeTop(html.length);
  for (const el of elements) { el.text = norm(el.text).slice(0, 80); el.html = html; el.page = elements; }
  return elements;
}

const outer = (el) => el.html.slice(el.start, el.end);
const ancestors = (el) => { const list = []; for (let p = el.parent; p; p = p.parent) list.push(p); return list; };

/** What the scanner's CSS selector says about ancestry and sibling position: `main > section#a > a:nth-child(2)`. */
function selectorHints(selector) {
  const parts = String(selector || '').split(/\s*>\s*|\s+(?![^([]*[)\]])/).filter(Boolean);
  const seg = (s) => ({
    tag: (s.match(/^[a-z][\w-]*/i) || [null])[0]?.toLowerCase() || null,
    id: (s.match(/#([\w-]+)/) || [])[1] || null,
    classes: [...s.matchAll(/\.([\w-]+)/g)].map((x) => x[1]),
    nth: (s.match(/:nth-child\((\d+)\)/) || [])[1],
    nthType: (s.match(/:nth-of-type\((\d+)\)/) || [])[1],
  });
  return { chain: parts.slice(0, -1).map(seg), last: parts.length > 0 ? seg(parts[parts.length - 1]) : null };
}

/** Score a preview probe `{ tag, attrs, classes, text }` against one local element; -1 rejects. */
export function scoreFingerprint(probe, local, hints = { chain: [], last: null }) {
  if (probe.tag !== local.tag) return -1;
  let score = 1;
  if (local.classes.length > 0) {
    const hit = local.classes.filter((c) => probe.classes.includes(c)).length;
    if (hit === 0) return -1; // the local element's own identifying classes are gone: a different element
    score += Math.round((6 * hit) / local.classes.length);
  } else if (probe.classes.length > 0) score -= 3; // classes the source never had: not this element
  for (const name of ATTRS) {
    const p = probe.attrs[name];
    const l = local.attrs[name];
    if (p === undefined && l === undefined) continue;
    score += p === undefined || l === undefined ? -1 : p === l ? 3 : -2;
  }
  // Containers carry their descendants' text, which data bindings rewrite: only leaf text is evidence.
  if (local.kids.length === 0) {
    if (probe.text && local.text) score += probe.text === local.text ? 5 : -1;
    else if (probe.text === local.text) score += 1;
  }
  if (SINGLETONS.has(local.tag) && local.page.filter((e) => e.tag === local.tag).length === 1) score += 6;
  const up = ancestors(local);
  for (const a of hints.chain) {
    if (a.id) score += up.some((p) => p.attrs.id === a.id) ? 2 : -5;
    else if (a.tag && LANDMARKS.has(a.tag)) score += up.some((p) => p.tag === a.tag) ? 1 : -5;
    if (a.classes.some((c) => up.some((p) => (p.attrs.class || '').split(/\s+/).includes(c)))) score += 1;
  }
  const { last } = hints;
  if (last?.nth) score += Number(last.nth) === local.childIndex ? 2 : -2;
  if (last?.nthType) score += Number(last.nthType) === local.typeIndex ? 2 : -2;
  return score;
}

const indexCache = new Map();
function cachedIndex(html) {
  if (!indexCache.has(html)) {
    if (indexCache.size >= 8) indexCache.delete(indexCache.keys().next().value);
    indexCache.set(html, indexHtml(html));
  }
  return indexCache.get(html);
}

/**
 * Match one preview element against the local build page.
 * @returns {null | { score: number, matches: { el: object, score: number }[] }}
 *   `matches` = every local element within MARGIN of the best score (more than one = a tie).
 */
export function matchPreviewElement(localHtml, outerHTML, selector) {
  const [probeEl] = indexHtml(String(outerHTML || '').trim().slice(0, 4000));
  if (!probeEl || !/<!--\s*snippets\//.test(localHtml)) return null;
  const hints = selectorHints(selector);
  const scored = cachedIndex(localHtml)
    .map((el) => ({ el, score: scoreFingerprint(probeEl, el, hints) }))
    .filter((s) => s.score >= FINGERPRINT.MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  return { score: scored[0].score, matches: scored.filter((s) => scored[0].score - s.score < FINGERPRINT.MARGIN) };
}

/**
 * Trace a preview element through the local build. `traceLocal(outerHTML, owners, refTagCount, textAgrees)` is the local-mode trace
 * of one local element, given its marker owners (outermost first), how many elements of its tag the reference page holds so that identical markup in
 * another snippet cannot blur which region it belongs to, and whether the preview element's own text equals the twin's (bound text means the twin is a weaker guess). Returns null when the fingerprint cannot decide (caller falls back).
 */
export function traceByFingerprint({ pageHtml, outerHTML, selector }, traceLocal) {
  const found = matchPreviewElement(pageHtml, outerHTML, selector);
  if (!found) return null;
  const probeText = indexHtml(String(outerHTML || '').trim().slice(0, 4000))[0].text;
  const traced = found.matches.map(({ el }) => traceLocal(outer(el), el.owners, cachedIndex(pageHtml).filter((e) => e.tag === el.tag).length, probeText === el.text)).filter((r) => r.candidates.length > 0 && r.confidence !== 'low');
  const evidence = ['fingerprint', `fp-score:${found.score}`];
  const decorate = (c) => ({ ...c, method: 'fingerprint-map', evidence: [...c.evidence.filter((e) => e !== 'decisive-match'), ...evidence] });
  const lines = new Map();
  for (const r of traced) for (const c of r.candidates) lines.set(`${c.file}|${c.line}`, decorate(c));
  const candidates = [...lines.values()];
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return { confidence: 'ambiguous', candidates, reason: 'multiple-candidates' };
  // One line. A tie of identical local elements that collapse to it (a loop) or a partial match caps at medium.
  const unique = found.matches.length === 1;
  const rank = { high: 3, medium: 2, low: 1 };
  const weakest = traced.map((r) => r.confidence).sort((a, b) => (rank[a] || 0) - (rank[b] || 0))[0];
  if (weakest === 'ambiguous') return { confidence: 'ambiguous', candidates, reason: 'multiple-candidates' };
  const confidence = weakest === 'high' && unique && found.score >= FINGERPRINT.HIGH_SCORE ? 'high' : 'medium';
  return { confidence, candidates, reason: null };
}

/** The local instrumented build's HTML (with snippet markers) for a scanned page URL, or null. */
export function loadLocalPageHtml(root, pageUrl, outDir = 'dist') {
  let pathname;
  try { pathname = new URL(pageUrl).pathname.replace(/\/+$/, ''); } catch { return null; }
  for (const rel of [`${outDir}${pathname || '/index'}.html`, `${outDir}${pathname}/index.html`]) {
    const full = containedPath(root, rel);
    if (full && existsSync(full)) {
      try { return readFileSync(full, 'utf8'); } catch { return null; }
    }
  }
  return null;
}
