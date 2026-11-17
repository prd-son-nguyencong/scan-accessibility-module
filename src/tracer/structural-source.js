import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { buildTagIndex, collectRenderTree } from './liquid-tag-index.js';
import { getProjectRoot, containedPath } from '../utils/paths.js';
import { isGeneratedCss } from './css-origin.js';

/**
 * Where a finding's element is authored when the finding itself carries little or no markup:
 *  - structural rules (nested <main>, unlabelled <nav>, <img> without alt, modal without focus trap) are resolved to the
 *    template that writes the offending element instead of the page file's first line;
 *  - candidates that share markup are told apart by the element's DOM ancestry and by colour tokens;
 *  - an attribute the served markup lacks but a project script sets (role, aria-*) points at that script line;
 *  - a failing colour that comes from a CSS custom property is reported with the line that declares the token.
 */

const MAIN_RULES = new Set(['landmark-no-duplicate-main', 'multiple-main-landmarks', 'landmark-one-main', 'regionmaincontentsingle']);
const NAV_RULES = new Set(['multiple-navs-missing-labels', 'navigation-missing-label']);
const IMG_RULES = new Set(['image-alt-missing-sr']);
const MODAL_RULES = new Set(['modal-focus-escapes']);

const has = (tag, name) => name in tag.staticAttrs || name in tag.dynamicAttrs;
const labelled = (tag) => has(tag, 'aria-label') || has(tag, 'aria-labelledby');

/** Render-tree files, outermost first: the layout wraps the page, the page wraps its partials. */
function orderedTree(pageFile, root) {
  const rank = (f) => (f.startsWith('src/layouts/') ? 0 : f === pageFile ? 1 : 2);
  return collectRenderTree(pageFile, undefined, root)
    .map((file, i) => ({ file, i }))
    .sort((a, b) => rank(a.file) - rank(b.file) || a.i - b.i)
    .map((x) => x.file);
}

function treeTags(pageFile, root, pick) {
  return orderedTree(pageFile, root).flatMap((file) => buildTagIndex(file, root).filter(pick).map((tag) => ({ file, tag })));
}

const dedupe = (hits) => [...new Map(hits.map((h) => [`${h.file}|${h.tag.line}`, h])).values()];
const candidate = (h, evidence) => ({ file: h.file, line: h.tag.line, method: 'structural-element', score: null, evidence });

function result(hits, evidence, { singleOnly = false } = {}) {
  const list = dedupe(hits);
  if (!list.length) return null;
  const cands = list.map((h) => candidate(h, evidence));
  if (singleOnly && list.length > 1) return { confidence: 'ambiguous', candidates: cands, reason: 'multiple-candidates' };
  return { confidence: 'medium', candidates: cands, reason: null };
}

/**
 * Source of the element a structural finding is about, or null (the caller then falls back to its normal element
 * search or the page-level anchor).
 * @param {string} pageFile src/pages/x.liquid
 * @param {string} ruleId
 * @param {object|null} rendered parseRenderedTag of the finding's outerHTML
 * @param {string} selector
 */
export function findStructuralSource(pageFile, ruleId, rendered, selector, root = getProjectRoot()) {
  const rule = String(ruleId || '').toLowerCase();
  if (!pageFile) return null;
  const tag = rendered?.tagName;

  if (MAIN_RULES.has(rule) || (rule === 'landmark-unique' && tag === 'main')) {
    const mains = dedupe(treeTags(pageFile, root, (t) => t.tagName === 'main'));
    // The page's own <main> is the outer one; the defect is the <main> rendered inside it.
    return mains.length > 1 ? result([mains[mains.length - 1], ...mains.slice(0, -1)], ['inner-main']) : null;
  }
  if (NAV_RULES.has(rule) || (rule === 'landmark-unique' && tag === 'nav')) {
    return result(treeTags(pageFile, root, (t) => t.tagName === 'nav' && !labelled(t)), ['unlabelled-nav']);
  }
  if (IMG_RULES.has(rule) && !tag) {
    return result(treeTags(pageFile, root, (t) => t.tagName === 'img' && !has(t, 'alt')), ['img-without-alt'], { singleOnly: true });
  }
  if (MODAL_RULES.has(rule) && !tag) return findModalDialog(pageFile, selector, root);
  return null;
}

/** The dialog a trigger (`[aria-haspopup="dialog"]`, `button[aria-controls]`) opens: that element is the one missing the focus trap. */
function findModalDialog(pageFile, selector, root) {
  const last = String(selector || '').split('>').pop().trim();
  const name = /^([a-z][\w-]*)?/i.exec(last)?.[1]?.toLowerCase() || null;
  const attrs = [...last.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)].map((m) => [m[1], m[2]]);
  if (!attrs.length) return null;
  const all = orderedTree(pageFile, root).flatMap((file) => buildTagIndex(file, root).map((tag) => ({ file, tag })));
  const triggers = all.filter(({ tag }) => (!name || tag.tagName === name)
    && attrs.every(([a, v]) => (v === undefined ? has(tag, a) : tag.staticAttrs[a] === v)) && tag.staticAttrs['aria-controls']);
  const dialogs = triggers.flatMap(({ tag }) => all.filter((h) => h.tag.staticAttrs.id === tag.staticAttrs['aria-controls']
    && (h.tag.staticAttrs.role === 'dialog' || h.tag.staticAttrs['aria-modal'] === 'true')));
  return result(dialogs, ['modal-dialog'], { singleOnly: true });
}

// ─── ancestry ───────────────────────────────────────────────────────────────

/** The tag a candidate points at: several tags can share one source line (`<li><a>`), so the wanted tag name picks among them (first tag otherwise). */
function tagAtLine(tags, line, tagName = null) {
  const here = tags.filter((t) => t.line === line);
  return (tagName && here.find((t) => t.tagName === tagName)) || here[0];
}

/**
 * Name of the `data-react-component` mount whose rendered snapshot holds the element: the element's authoring line also opens that mount earlier,
 * so the markup is the widget's output pasted into the template (an own line inside a mount is a skeleton the site authors). Null otherwise.
 */
export function widgetSnapshotAt(file, line, html, root) {
  const name = /^\s*<([a-z][\w-]*)/i.exec(html || '')?.[1]?.toLowerCase();
  if (!name || /\sdata-react-component\b/i.test(/^\s*<[^>]*>?/.exec(html)[0])) return null;
  const tags = buildTagIndex(file, root).filter((t) => t.line === line);
  const mount = (t) => 'data-react-component' in t.staticAttrs || 'data-react-component' in t.dynamicAttrs;
  const own = tags.find((t) => t.tagName === name && !mount(t));
  const host = own && tags.find((t) => mount(t) && t.openStart < own.openStart);
  return host ? host.staticAttrs['data-react-component'] || 'unnamed' : null;
}

/** Tags (with their classes/ids) that are open around the tag at `line` in `file`, by a tag/close-tag walk of the template. */
function ancestorsAt(file, line, root, tagName = null) {
  const tags = buildTagIndex(file, root);
  const target = tagAtLine(tags, line, tagName);
  const full = containedPath(root, file);
  if (!target || !full) return [];
  let src;
  try { src = readFileSync(full, 'utf8'); } catch { return []; }
  const events = tags.filter((t) => t.openStart < target.openStart).map((t) => ({ at: t.openStart, open: t }));
  const closeRe = /<\/([A-Za-z][\w:-]*)\s*>/g;
  let m;
  while ((m = closeRe.exec(src)) !== null && m.index < target.openStart) events.push({ at: m.index, close: m[1].toLowerCase() });
  events.sort((a, b) => a.at - b.at);
  const stack = [];
  for (const e of events) {
    if (e.open) { if (!e.open.selfClosing) stack.push(e.open); continue; }
    const i = stack.map((t) => t.tagName).lastIndexOf(e.close);
    if (i >= 0) stack.length = i;
  }
  return stack;
}

/**
 * Position of `tag` among its parent's children in the template: `child` (nth-child) and `ofType` (nth-of-type), 1-based.
 * `certain` is false when Liquid control flow or a render sits between the parent's opening and the tag (a loop or condition can add or drop siblings).
 */
function siblingPosition(file, tag, parent, root) {
  const tags = buildTagIndex(file, root);
  const full = containedPath(root, file);
  if (!parent || !full) return null;
  let src;
  try { src = readFileSync(full, 'utf8'); } catch { return null; }
  const events = tags.filter((t) => t.openStart > parent.openStart && t.openStart < tag.openStart).map((t) => ({ at: t.openStart, open: t }));
  const closeRe = /<\/([A-Za-z][\w:-]*)\s*>/g;
  closeRe.lastIndex = parent.contentStart;
  let m;
  while ((m = closeRe.exec(src)) !== null && m.index < tag.openStart) events.push({ at: m.index, close: true });
  events.sort((a, b) => a.at - b.at);
  let depth = 0;
  let child = 0;
  let ofType = 0;
  for (const e of events) {
    if (e.close) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) { child += 1; if (e.open.tagName === tag.tagName) ofType += 1; }
    if (!e.open.selfClosing) depth += 1;
  }
  const between = src.slice(parent.contentStart, tag.openStart);
  return { child: child + 1, ofType: ofType + 1, certain: !/\{%-?\s*(?:for|if|unless|case|render|include|capture)\b/.test(between) };
}

const GENERIC = /^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|container|group|w-|h-|min-|max-|p[xytrbl]?-|m[xytrbl]?-|gap-|text-|border|rounded|shadow|z-|overflow|items-|justify-|self-|order-|col-|row-|space-|leading-|tracking-|font-|opacity-|size-)/;

/** Identity tokens of the selector's ancestors: ids and non-utility classes, plus landmark tag names. */
function ancestorTokens(selector) {
  const parts = String(selector || '').split(/\s*>\s*|\s+/).filter(Boolean);
  const tokens = [];
  for (const part of parts.slice(0, -1)) {
    for (const m of part.matchAll(/#([\w-]+)/g)) tokens.push({ id: m[1] });
    for (const m of part.matchAll(/\.((?:\\.|[\w-])+)/g)) {
      const cls = m[1].replace(/\\/g, '');
      if (cls.length >= 4 && !GENERIC.test(cls) && !cls.includes(':')) tokens.push({ cls });
    }
    const t = /^(header|footer|nav|main|aside|section)\b/i.exec(part);
    if (t) tokens.push({ tag: t[1].toLowerCase() });
  }
  return tokens;
}

/**
 * Keeps the candidates whose surrounding markup matches the element's DOM ancestry (selector ids/classes, landmark tags)
 * and any extra wanted class tokens. One clear winner is returned; no signal or a tie keeps the whole list.
 */
export function narrowByAncestry(candidates, selector, root, extraClasses = []) {
  const wanted = [...ancestorTokens(selector), ...extraClasses.map((cls) => ({ cls }))];
  if (candidates.length < 2 || !wanted.length) return candidates;
  const score = (c) => {
    const chain = ancestorsAt(c.file, c.line, root);
    const own = buildTagIndex(c.file, root).find((t) => t.line === c.line);
    const classes = new Set([...chain, ...(own ? [own] : [])].flatMap((t) => [...(t.staticClasses || [])]));
    const raw = containedPath(root, c.file);
    let text = '';
    try { text = raw ? readFileSync(raw, 'utf8').split('\n').slice(Math.max(0, c.line - 40), c.line).join('\n') : ''; } catch { /* unreadable */ }
    return wanted.filter((w) => (w.id && chain.some((t) => t.staticAttrs.id === w.id))
      || (w.cls && (classes.has(w.cls) || new RegExp(`class\\s*=\\s*["'][^"']*\\b${w.cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)))
      || (w.tag && chain.some((t) => t.tagName === w.tag))).length;
  };
  const scored = candidates.map((c) => ({ c, s: score(c) }));
  const top = Math.max(...scored.map((x) => x.s));
  const best = scored.filter((x) => x.s === top).map((x) => x.c);
  return top > 0 && best.length < candidates.length ? best : candidates;
}

/** Splits a selector into compounds; each carries the combinator that joins it to the compound before it (`>`, ` `, `+`, `~`). Escapes, [] and () stay whole. */
function selectorChain(selector) {
  const out = [];
  const s = String(selector || '');
  let cur = '';
  let depth = 0;
  let pending = ' ';
  const flush = () => { if (cur) { out.push({ text: cur, comb: pending }); cur = ''; pending = ' '; } };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') { cur += ch + (s[i + 1] ?? ''); i += 1; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(ch)) { flush(); if (!/\s/.test(ch)) pending = ch; continue; }
    cur += ch;
  }
  flush();
  return out;
}

/** Tag name, ids, class tokens and exact `[attr=value]` tests of one selector compound (pseudo-classes carry no static identity). */
function parseCompound(text) {
  const out = { tag: null, ids: [], classes: [], attrs: [] };
  const ident = (from) => {
    let j = from;
    let v = '';
    while (j < text.length && (text[j] === '\\' || /[\w-]/.test(text[j]))) {
      if (text[j] === '\\') { v += text[j + 1] ?? ''; j += 2; } else { v += text[j]; j += 1; }
    }
    return [v, j];
  };
  let i = 0;
  if (/[a-z]/i.test(text[0] || '')) { const [v, j] = ident(0); out.tag = v.toLowerCase(); i = j; }
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.' || ch === '#') { const [v, j] = ident(i + 1); (ch === '.' ? out.classes : out.ids).push(v); i = j; }
    else if (ch === '[') {
      const end = text.indexOf(']', i);
      const m = /^\[\s*([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*$/.exec(text.slice(i, end === -1 ? text.length : end));
      if (m) out.attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]);
      i = end === -1 ? text.length : end + 1;
    } else if (ch === ':') {
      i += text[i + 1] === ':' ? 2 : 1;
      const [pseudo, j] = ident(i);
      i = j;
      if (text[i] === '(') {
        const close = text.indexOf(')', i);
        const arg = text.slice(i + 1, close === -1 ? text.length : close).trim();
        if (/^nth-(child|of-type)$/.test(pseudo) && /^\d+$/.test(arg)) out.nth = { kind: pseudo === 'nth-child' ? 'child' : 'ofType', n: Number(arg) };
        i = close === -1 ? text.length : close + 1;
      }
    } else i += 1;
  }
  return out;
}

/**
 * Keeps the candidates whose authored ancestors carry the tags, ids, classes and attributes of the live element's selector chain,
 * level by level (own tag, the parent for `>`, the best-fitting ancestor for a space). Utility classes count here: they tell sibling
 * carousels apart. A class or attribute that no candidate writes literally (a script adds `.current`) cannot decide and is ignored;
 * the chain stops where a candidate's template file ends. The candidates with the best fit (matches minus misses) stay; a tie keeps them all.
 */
export function narrowBySelectorChain(candidates, selector, root, html = '') {
  const chain = selectorChain(selector).map((c) => ({ ...c, ...parseCompound(c.text) }));
  if (candidates.length < 2 || chain.length < 1) return candidates;
  const ownTag = chain[chain.length - 1].tag || /^\s*<([a-z][\w-]*)/i.exec(html || '')?.[1]?.toLowerCase() || null;
  const prepared = candidates.map((c) => {
    const own = tagAtLine(buildTagIndex(c.file, root), c.line, ownTag);
    return { c, levels: own ? [own, ...[...ancestorsAt(c.file, c.line, root, ownTag)].reverse()] : [] };
  });
  const knownClass = new Set();
  const knownAttr = new Set();
  for (const { levels } of prepared) {
    for (const t of levels) {
      t.classTokens.forEach((x) => knownClass.add(x));
      Object.keys(t.staticAttrs).forEach((x) => knownAttr.add(x));
    }
  }
  const score = (tag, comp, pos) => {
    let m = 0;
    let h = 0;
    // A fixed position among the parent's children (`:nth-of-type(2)`) counts only where the template has no loop or condition among the siblings.
    if (comp.nth && pos?.certain) { if ((comp.nth.kind === 'child' ? pos.child : pos.ofType) === comp.nth.n) h += 1; else m += 1; }
    if (comp.tag) { if (tag.tagName === comp.tag) h += 1; else m += 1; }
    for (const id of comp.ids) { if (tag.staticAttrs.id === id) h += 1; else if (!tag.dynamicAttrs.id) m += 1; }
    for (const cls of comp.classes.filter((x) => knownClass.has(x))) {
      if (tag.classTokens.includes(cls)) h += 1;
      else if (!tag.opaqueClass && !tag.dynamicClasses.some((re) => re.test(cls))) m += 1;
    }
    for (const [name, value] of comp.attrs.filter(([n]) => knownAttr.has(n))) {
      if (tag.staticAttrs[name] === value) h += 1;
      else if (!tag.dynamicAttrs[name] || !tag.dynamicAttrs[name].test(value)) m += 1;
    }
    return { m, h };
  };
  const tally = ({ c, levels }) => {
    let miss = 0;
    let hit = 0;
    let at = 0;
    const posAt = (j) => siblingPosition(c.file, levels[j], levels[j + 1], root);
    for (let k = chain.length - 1; k >= 0; k -= 1) {
      if (at >= levels.length || (k < chain.length - 1 && /[+~]/.test(chain[k + 1].comb))) break;
      let best = score(levels[at], chain[k], chain[k].nth ? posAt(at) : null);
      let used = at;
      if (k < chain.length - 1 && chain[k + 1].comb === ' ') {
        for (let j = at + 1; j < levels.length; j += 1) {
          const sc = score(levels[j], chain[k], chain[k].nth ? posAt(j) : null);
          if (sc.h - sc.m > best.h - best.m) { best = sc; used = j; }
        }
      }
      miss += best.m;
      hit += best.h;
      at = used + 1;
    }
    return { miss, hit };
  };
  const scored = prepared.map((p) => ({ c: p.c, ...tally(p) }));
  const top = Math.max(...scored.map((x) => x.hit - x.miss));
  const best = scored.filter((x) => x.hit - x.miss === top);
  const most = Math.max(...best.map((x) => x.hit));
  const kept = best.filter((x) => x.hit === most).map((x) => x.c);
  return kept.length < candidates.length ? kept : candidates;
}

/**
 * Candidates that differ only in the text they author (three pill buttons with one class list and one aria-label) are told apart by the
 * element's own leading text. One clear winner is returned; no authored text to compare, or no unique match, keeps the whole list.
 */
export function narrowByOwnText(candidates, html, root) {
  const want = /^\s*<[^>]*>([^<]*)/.exec(html || '')?.[1]?.replace(/\s+/g, ' ').trim();
  if (candidates.length < 2 || !want) return candidates;
  // A candidate with no literal text (Liquid in its leading text) may still render `want`: only a differing literal text rules it out.
  // A line may hold several tags (`<a>EN</a> | <a>FR</a>`): the candidate is that line, so any of its tags may be the element.
  const textsOf = (c) => buildTagIndex(c.file, root).filter((t) => t.line === c.line).map((t) => t.text);
  const same = candidates.filter((c) => { const ts = textsOf(c); return !ts.length || ts.some((t) => t == null || t === want); });
  return same.length && same.length < candidates.length ? same : candidates;
}

/**
 * Drops candidates the live element cannot have come from: a tag that always renders `alt` against an element without one, and
 * (colour findings) a tag whose literal class list lacks a colour utility (`text-*`, `bg-*`) the live element carries.
 */
export function dropContradicted(candidates, html, root, ruleId = '') {
  const rendered = /^\s*<([a-z][\w-]*)([^>]*)>?/i.exec(html || '');
  if (!rendered || /\.\.\./.test(html)) return candidates;
  const live = new Set((/class="([^"]*)"/.exec(rendered[2])?.[1] || '').split(/\s+/).filter((c) => /^(?:text|bg)-/.test(c)));
  const colour = /color-contrast/i.test(ruleId);
  const kept = candidates.filter((c) => {
    const tag = buildTagIndex(c.file, root).find((t) => t.line === c.line && t.tagName === rendered[1].toLowerCase());
    if (!tag) return true;
    if (has(tag, 'alt') && !/\salt\s*=|\salt[\s>/]/i.test(` ${rendered[2]} `)) return false;
    // An authored accessible name the tag cannot produce: the live element carries a literal aria-label this tag neither writes nor computes.
    if (/\saria-label\s*=\s*"[^"]+"/i.test(rendered[2]) && !has(tag, 'aria-label')) return false;
    return !(colour && tag.hasClass && tag.dynamicClasses.length === 0 && [...live].some((c) => !tag.classTokens.includes(c)));
  });
  return kept.length ? kept : candidates;
}

// ─── colour tokens ──────────────────────────────────────────────────────────

const longHex = (h) => (h.length === 3 ? h.split('').map((c) => c + c).join('') : h).toLowerCase();

/** `--color-x: #hex;` declarations in the project's source CSS, with where they are declared. */
export function colorTokens(root) {
  const tokens = [];
  for (const file of fg.sync(['src/**/*.css'], { cwd: root, ignore: ['**/node_modules/**', '**/+.css'] }).sort()) {
    readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => {
      const m = /^\s*--((?:color|colour)-[\w-]+)\s*:\s*#([0-9a-f]{6}|[0-9a-f]{3})\s*;/i.exec(line);
      if (m) tokens.push({ token: m[1].replace(/^colou?r-/, ''), hex: longHex(m[2]), file, line: i + 1 });
    });
  }
  return tokens;
}

/** Foreground / background colours quoted by a contrast finding. */
export function contrastColors(text) {
  const out = {};
  const fg = /foreground color:\s*#([0-9a-f]{6})/i.exec(text || '');
  const bg = /background color:\s*#([0-9a-f]{6})/i.exec(text || '');
  if (fg) out.fg = fg[1].toLowerCase();
  if (bg) out.bg = bg[1].toLowerCase();
  return out;
}

/**
 * Declaring lines for the colour tokens behind a contrast failure. The foreground token counts only when the element names
 * it as a utility class (`text-disabled` -> `--color-disabled`); the background token is the one a candidate ancestor
 * must carry (`bg-blue-300`).
 */
export function contrastTokens(html, message, root) {
  const colors = contrastColors(message);
  if (!colors.fg && !colors.bg) return { fg: null, bg: [] };
  const tokens = colorTokens(root).filter((t) => !isGeneratedCss(root, t.file) && !['ffffff', '000000'].includes(t.hex));
  const classes = new Set(((html || '').match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
  const fg = colors.fg ? tokens.find((t) => t.hex === colors.fg && classes.has(`text-${t.token}`)) || null : null;
  const bg = colors.bg ? tokens.filter((t) => t.hex === colors.bg) : [];
  return { fg, bg };
}

// ─── script-set attributes ──────────────────────────────────────────────────

const ATTR_RULES = { 'aria-allowed-role': (name) => name === 'role', 'aria-allowed-attr': (name) => name.startsWith('aria-'), 'aria-prohibited-attr': (name) => name.startsWith('aria-') };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Script line that sets an attribute the authored markup never carries. `html` is the live element; `isAuthored(name, value)`
 * says whether any template of the page writes that attribute. Returns { file, line, attr, value, candidates } or null.
 */
export function findScriptSetter(ruleId, html, selector, isAuthored, root) {
  const wants = ATTR_RULES[String(ruleId || '').toLowerCase()];
  if (!wants || !html) return null;
  const attrs = [...html.matchAll(/\s([\w-]+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]).filter(([n, v]) => wants(n) && v && !/\.\.\.$/.test(v));
  const files = fg.sync(['src/scripts/**/*.{js,mjs,ts}'], { cwd: root, ignore: ['**/node_modules/**'] }).sort();
  if (!files.length) return null;
  const hints = [...(html.match(/class="([^"]*)"/)?.[1] || '').split(/\s+/), ...String(selector || '').split(/[^\w-]+/)]
    .map((c) => c.replace(/__.*$/, '').replace(/\.\.\.$/, '')).filter((c) => c.length >= 6 && !GENERIC.test(c));
  for (const [name, value] of attrs) {
    if (isAuthored(name, value)) continue;
    const q = `["'\`]`;
    const re = [
      new RegExp(`setAttribute\\(\\s*${q}${esc(name)}${q}\\s*,\\s*${q}${esc(value)}${q}`),
      name === 'role' ? new RegExp(`\\.role\\s*=\\s*${q}${esc(value)}${q}`) : null,
    ].filter(Boolean);
    const hits = [];
    for (const file of files) {
      const text = readFileSync(path.join(root, file), 'utf8');
      text.split('\n').forEach((l, i) => { if (re.some((r) => r.test(l))) hits.push({ file, line: i + 1, text }); });
    }
    if (!hits.length) continue;
    const near = hits.filter((h) => hints.some((c) => h.text.includes(c)));
    const pool = near.length ? near : hits;
    return { file: pool[0].file, line: pool[0].line, attr: name, value, candidates: pool.slice(1).map((h) => ({ file: h.file, line: h.line })), ambiguous: pool.length > 1 && !near.length };
  }
  return null;
}

/** True when some template of the page writes `name` with a static value on a tag named `tagName`. */
export function markupWrites(files, tagName, name, value, root) {
  return files.some((f) => buildTagIndex(f, root).some((t) => t.tagName === tagName
    && (t.staticAttrs[name] === value || (t.dynamicAttrs[name] && t.dynamicAttrs[name].test(value)))));
}

/** Tags of the page's render tree whose opening tag text contains `needle` (a class prefix cut off by a truncated outerHTML). */
export function findTagsContaining(pageFile, tagName, needle, root) {
  const out = [];
  for (const file of orderedTree(pageFile, root)) {
    const full = containedPath(root, file);
    let src;
    try { src = readFileSync(full, 'utf8'); } catch { continue; }
    for (const t of buildTagIndex(file, root)) {
      if (t.tagName === tagName && src.slice(t.openStart, t.contentStart).includes(needle)) out.push({ file, line: t.line });
    }
  }
  return out;
}

export const renderTreeFiles = (pageFile, root) => orderedTree(pageFile, root);

/** Source CSS rules that declare `color: <hex>` for a selector naming all of the element's own (non-utility) classes. */
export function colorDeclarations(html, hex, root) {
  const classes = ((html || '').match(/class="([^"]*)"/)?.[1] || '').split(/\s+/).filter((c) => c.length >= 4 && !GENERIC.test(c) && !c.includes(':') && !/\.\.\.$/.test(c));
  if (!classes.length || !hex) return [];
  const out = [];
  for (const file of fg.sync(['src/**/*.css'], { cwd: root, ignore: ['**/node_modules/**', '**/+.css'] }).sort()) {
    if (isGeneratedCss(root, file)) continue;
    const css = readFileSync(path.join(root, file), 'utf8');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = new RegExp(`(?:^|[;\\s])color\\s*:\\s*#${hex}\\b`, 'i');
      if (!decl.test(m[2]) || !classes.every((c) => m[1].includes(`.${c}`))) continue;
      out.push({ file, line: css.slice(0, m.index + (m[1].length - m[1].trimStart().length)).split('\n').length, selector: m[1].trim().split('\n').pop().trim() });
    }
  }
  return out;
}

/** The one authored CSS rule that names all of the element's own (non-utility) classes and declares `z-index` (a stacking order that loses to the covering sticky element); null when none or several. */
export function stackingDeclaration(html, root) {
  const classes = ((html || '').match(/class="([^"]*)"/)?.[1] || '').split(/\s+/).filter((c) => c.length >= 4 && !GENERIC.test(c) && !c.includes(':') && !/\.\.\.$/.test(c));
  if (!classes.length) return null;
  const out = [];
  for (const file of fg.sync(['src/**/*.css'], { cwd: root, ignore: ['**/node_modules/**', '**/+.css'] }).sort()) {
    if (isGeneratedCss(root, file)) continue;
    const css = readFileSync(path.join(root, file), 'utf8');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const z = /(?:^|[;\s])z-index\s*:/.exec(m[2]);
      const head = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (!z || /:(?:hover|focus|active|visited)|::/.test(head) || !classes.every((c) => head.includes(`.${c}`))) continue;
      out.push({ file, line: css.slice(0, m.index + m[0].indexOf('{') + 1 + z.index).split('\n').length, selector: head.split('\n').pop().trim() });
    }
  }
  return out.length === 1 ? out[0] : null;
}

/** True when `line` of `file` starts inside an HTML comment (a commented-out copy of the markup, never the live element). */
export function inHtmlComment(file, line, root) {
  const full = containedPath(root, file);
  let src;
  try { src = readFileSync(full, 'utf8'); } catch { return false; }
  const offset = src.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) if (m.index <= offset && offset < m.index + m[0].length) return true;
  return false;
}
