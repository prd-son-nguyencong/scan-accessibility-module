// Deterministic recipes fixer: real edit generation for mechanically safe rules, built on src/fix/export/recipes.js helpers.
// Every generator edits the real text of the file around the task line, keeps Liquid/Paradox tags byte-exact, and declines
// (returns { declined: reason }) on anything ambiguous: several tags on the line, a tag that spans lines, a Liquid/Paradox tag inside
// the attribute being changed, a label that has no safe source, or a design-locked rule (colour contrast family).
import { addAttrToLine, isDesignLocked, parseElement, textOf } from '../../export/recipes.js';
import { decline, fileText, finish, ruleOf, taskSource } from './common.js';

const dyn = (s) => /\{\{|\{%/.test(String(s ?? ''));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const indentOf = (l) => /^\s*/.exec(l)[0];

const RULES = {
  viewport: ['meta-viewport', 'meta-viewport-large'],
  name: ['button-name', 'link-name', 'interactive-control-accessible-name', 'link-accessible-name'],
  alt: ['image-alt'],
  expanded: ['disclosure-missing-aria-expanded', 'menu-trigger-missing-aria-expanded'],
  nav: ['landmark-unique', 'nav-label', 'nav-missing-label', 'landmark-no-duplicate-nav'],
  lang: ['html-has-lang'],
  title: ['document-title'],
  noopener: ['link-target-blank-rel', 'target-blank-noopener', 'rel-noopener', 'external-link-noopener'],
  skip: ['skip-link-missing', 'skip-link'],
  dupid: ['duplicate-id', 'duplicate-id-aria', 'duplicate-id-referenced'],
  autocomplete: ['autocomplete-valid', 'autocomplete-missing'],
};
const KIND = Object.fromEntries(Object.entries(RULES).flatMap(([k, v]) => v.map((r) => [r, k])));
export const SUPPORTED_RULES = Object.keys(KIND);

/** The single `<tag` on a source line: { start, end, open, attrs } or a decline reason. */
function locate(line, tag) {
  const hits = [...line.matchAll(new RegExp(`<${tag}(?=[\\s>/]|$)`, 'gi'))];
  if (hits.length !== 1) return { reason: hits.length ? 'AMBIGUOUS_LINE' : 'TAG_NOT_ON_LINE' };
  const probe = addAttrToLine(line, tag, 'x');
  if (!probe) return { reason: 'TAG_SPANS_LINES' };
  const start = hits[0].index;
  const el = parseElement(line.slice(start));
  const open = el.open || '';
  if (!open) return { reason: 'TAG_SPANS_LINES' };
  return { start, end: start + open.length, open, attrs: el.attrs };
}
const swapOpen = (line, t, open) => line.slice(0, t.start) + open + line.slice(t.end);
const setAttr = (open, name, value) => open.replace(new RegExp(`(\\b${name}\\s*=\\s*)(["'])[^"']*\\2`, 'i'), (_, a, q) => `${a}${q}${value}${q}`);

/** Source of the element starting at lines[idx] up to its closing tag (max 8 lines); { inner, closed }. */
function elementInner(lines, idx, tag, from) {
  let s = lines[idx].slice(from);
  for (let i = idx; i < Math.min(lines.length, idx + 8); i += 1) {
    if (i > idx) s += `\n${lines[i]}`;
    const m = new RegExp(`</${tag}\\s*>`, 'i').exec(s);
    if (m) return { inner: s.slice(s.indexOf('>') + 1, m.index), closed: true };
  }
  return { inner: '', closed: false };
}

const okLabel = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80 || dyn(t)) return null;
  if (/^(click here|here|read more|more|image|icon|button|link|untitled)$/i.test(t)) return null;
  if (/^https?:|^\/|^[\w-]+\.(?:png|jpe?g|svg|gif|webp|avif)$/i.test(t)) return null;
  return t;
};

function nameFromSafeSources(attrs, inner) {
  if (attrs.title && okLabel(attrs.title)) return [okLabel(attrs.title), 'title attribute'];
  const svgTitle = /<svg\b[\s\S]*?<title[^>]*>([^<]*)<\/title>/i.exec(inner)?.[1];
  if (okLabel(svgTitle)) return [okLabel(svgTitle), 'svg title'];
  const text = okLabel(textOf(inner));
  return text ? [text, 'visible text'] : null;
}

// ---------------------------------------------------------------- generators: (c) -> { path?, line?, lines? } | decline

const G = {};

G.viewport = (c) => {
  const t = locate(c.line, 'meta');
  if (t.reason) return decline(t.reason);
  if (String(t.attrs.name).toLowerCase() !== 'viewport') return decline('NOT_VIEWPORT_META');
  const content = t.attrs.content;
  if (content == null || dyn(content)) return decline('DYNAMIC_OR_MISSING_CONTENT');
  const parts = content.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const keep = parts.filter((p) => {
    if (/^user-scalable\s*=\s*(no|0)$/i.test(p)) return false;
    const m = /^maximum-scale\s*=\s*([\d.]+)$/i.exec(p);
    return !(m && Number(m[1]) < 5);
  });
  if (keep.length === parts.length) return decline('NOTHING_TO_REMOVE');
  if (!keep.length) return decline('WOULD_EMPTY_CONTENT');
  return { line: swapOpen(c.line, t, setAttr(t.open, 'content', keep.join(content.includes(', ') ? ', ' : ','))), why: 'removed zoom restrictions from the viewport meta' };
};

G.name = (c) => {
  const tag = c.tag === 'a' ? 'a' : c.tag === 'button' ? 'button' : null;
  if (!tag) return decline('UNSUPPORTED_ELEMENT');
  const t = locate(c.line, tag);
  if (t.reason) return decline(t.reason);
  if (c.id && t.attrs.id && t.attrs.id !== c.id) return decline('ELEMENT_MISMATCH');
  if ('aria-label' in t.attrs || 'aria-labelledby' in t.attrs) return decline('ALREADY_HAS_ARIA_NAME');
  const { inner, closed } = elementInner(c.lines, c.idx, tag, t.start);
  if (!closed) return decline('ELEMENT_NOT_CLOSED_NEARBY');
  const src = nameFromSafeSources(t.attrs, inner);
  if (!src) return decline('NO_SAFE_LABEL_SOURCE');
  const line = addAttrToLine(c.line, tag, `aria-label="${esc(src[0])}"`);
  return line ? { line, why: `aria-label taken from the ${src[1]}` } : decline('TAG_SPANS_LINES');
};

G.alt = (c) => {
  const t = locate(c.line, 'img');
  if (t.reason) return decline(t.reason);
  if ('alt' in t.attrs) return decline('ALT_ALREADY_PRESENT');
  const el = parseElement(c.task.element?.html || '');
  const decorative = [t.attrs, el.attrs].some((a) => String(a['aria-hidden']) === 'true' || /^(presentation|none)$/i.test(a.role || ''))
    || (c.task.evidence || []).some((e) => /\bdecorative\b/i.test(String(e)));
  let alt = null; let why = '';
  if (decorative) { alt = ''; why = 'decorative image (task evidence)'; } else {
    let fig = null;
    for (let i = c.idx; i >= Math.max(0, c.idx - 6) && fig == null; i -= 1) { if (/<\/figure/i.test(c.lines[i]) && i < c.idx) break; if (/<figure\b/i.test(c.lines[i])) fig = i; }
    if (fig != null) {
      const block = c.lines.slice(fig, fig + 14).join('\n').split(/<\/figure\s*>/i)[0];
      alt = okLabel(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(block)?.[1]?.replace(/<[^>]*>/g, ' '));
      if (alt) why = 'figcaption text';
    }
    if (!alt && okLabel(t.attrs.title)) { alt = okLabel(t.attrs.title); why = 'title attribute'; }
    if (!alt) return decline('NO_SAFE_LABEL_SOURCE');
  }
  const line = addAttrToLine(c.line, 'img', `alt="${esc(alt)}"`);
  return line ? { line, why } : decline('TAG_SPANS_LINES');
};

const TARGET_ATTRS = ['data-target', 'data-controls', 'data-bs-target', 'data-toggle-target'];
G.expanded = (c) => {
  const tag = c.tag || 'button';
  if (/^(summary|details)$/.test(tag)) return decline('NATIVE_DISCLOSURE');
  const t = locate(c.line, tag);
  if (t.reason) return decline(t.reason);
  if ('aria-expanded' in t.attrs) return decline('ALREADY_HAS_ARIA_EXPANDED');
  const scripts = Object.entries({ ...(c.context.readonly || {}), ...Object.fromEntries(Object.keys(c.context.files || {}).map((k) => [k, fileText(c.context, k)])) }).filter(([k]) => /\.m?js$/.test(k)).map(([, v]) => v);
  if (!scripts.length) return decline('SCRIPT_UNKNOWN');
  if (!scripts.some((s) => /aria-expanded/.test(s))) return decline('SCRIPT_DOES_NOT_TOGGLE_ARIA_EXPANDED');
  let attrs = 'aria-expanded="false"';
  if (!('aria-controls' in t.attrs)) {
    const raw = TARGET_ATTRS.map((a) => t.attrs[a]).find(Boolean);
    const id = raw && !dyn(raw) ? raw.replace(/^#/, '') : null;
    const all = [...Object.keys(c.context.files || {}).map((k) => fileText(c.context, k)), ...Object.values(c.context.readonly || {})];
    if (id && /^[\w:-]+$/.test(id) && all.some((s) => new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(s || ''))) attrs += ` aria-controls="${id}"`;
  }
  const line = addAttrToLine(c.line, tag, attrs);
  return line ? { line, why: 'initial collapsed state; the existing script already updates aria-expanded' } : decline('TAG_SPANS_LINES');
};

const NAV_PURPOSE = [[/breadcrumb/i, 'Breadcrumb'], [/pagination|pager/i, 'Pagination'], [/social/i, 'Social links'], [/footer/i, 'Footer'], [/secondary/i, 'Secondary'], [/mobile|drawer|offcanvas/i, 'Mobile'], [/primary|main|site-?nav|global/i, 'Main']];
G.nav = (c) => {
  const t = locate(c.line, 'nav');
  if (t.reason) return decline(t.reason);
  if ('aria-label' in t.attrs || 'aria-labelledby' in t.attrs) return decline('ALREADY_LABELLED');
  const hay = `${t.attrs.id || ''} ${t.attrs.class || ''}`;
  let label = NAV_PURPOSE.find(([re]) => re.test(hay))?.[1];
  if (!label) {
    const depth = { header: 0, footer: 0 };
    for (let i = 0; i < c.idx; i += 1) for (const m of c.lines[i].matchAll(/<(\/?)(header|footer)\b/gi)) depth[m[2].toLowerCase()] += m[1] ? -1 : 1;
    if (depth.footer > 0 && depth.header <= 0) label = 'Footer';
  }
  if (!label) return decline('PURPOSE_NOT_DERIVABLE');
  const all = Object.keys(c.context.files || {}).map((k) => fileText(c.context, k) || '');
  if (all.some((s) => new RegExp(`<nav\\b[^>]*aria-label\\s*=\\s*["']${label}["']`, 'i').test(s))) return decline('LABEL_NOT_UNIQUE');
  const line = addAttrToLine(c.line, 'nav', `aria-label="${label}"`);
  return line ? { line, why: `nav purpose "${label}" derived from its id, class or landmark` } : decline('TAG_SPANS_LINES');
};

G.noopener = (c) => {
  const t = locate(c.line, c.tag === 'form' ? 'form' : (c.tag || 'a'));
  if (t.reason) return decline(t.reason);
  if (String(t.attrs.target).toLowerCase() !== '_blank') return decline('NOT_TARGET_BLANK');
  const rel = t.attrs.rel;
  if (rel != null && dyn(rel)) return decline('DYNAMIC_REL');
  if (rel != null && /\b(noopener|noreferrer)\b/i.test(rel)) return decline('ALREADY_SAFE');
  const line = rel == null ? addAttrToLine(c.line, c.tag || 'a', 'rel="noopener"') : swapOpen(c.line, t, setAttr(t.open, 'rel', `${rel.trim()} noopener`.trim()));
  return line ? { line, why: 'noopener on target=_blank' } : decline('TAG_SPANS_LINES');
};

const AUTOCOMPLETE = [[/^e-?mail/, 'email'], [/^(tel|phone|mobile)/, 'tel'], [/first[-_ ]?name|given/, 'given-name'], [/last[-_ ]?name|family|surname/, 'family-name'], [/^(full[-_ ]?)?name$/, 'name'], [/postal|zip/, 'postal-code'], [/^city/, 'address-level2'], [/^user-?name/, 'username']];
G.autocomplete = (c) => {
  const t = locate(c.line, 'input');
  if (t.reason) return decline(t.reason);
  if ('autocomplete' in t.attrs) return decline('ALREADY_HAS_AUTOCOMPLETE');
  const type = String(t.attrs.type || 'text').toLowerCase();
  if (!['text', 'email', 'tel', 'search', ''].includes(type)) return decline('TYPE_NOT_SUPPORTED');
  const key = `${t.attrs.name || ''}`.toLowerCase();
  if (dyn(key)) return decline('DYNAMIC_NAME');
  const token = type === 'email' ? 'email' : type === 'tel' ? 'tel' : (AUTOCOMPLETE.find(([re]) => re.test(key))?.[1] || null);
  if (!token) return decline('PURPOSE_NOT_DERIVABLE');
  const line = addAttrToLine(c.line, 'input', `autocomplete="${token}"`);
  return line ? { line, why: `autocomplete "${token}" from type or name` } : decline('TAG_SPANS_LINES');
};

G.dupid = (c) => {
  const ids = [...c.line.matchAll(/\bid="([^"]*)"/g)];
  if (ids.length !== 1) return decline(ids.length ? 'AMBIGUOUS_LINE' : 'NO_ID_ON_LINE');
  const id = ids[0][1];
  if (!id || dyn(id) || !/^[\w:-]+$/.test(id)) return decline('DYNAMIC_OR_ODD_ID');
  let stack = []; let start = null;
  for (let i = 0; i <= c.idx; i += 1) for (const m of c.lines[i].matchAll(/\{%-?\s*(for\b|endfor\b)/g)) { if (m[1] === 'endfor') stack.pop(); else stack.push(i); }
  if (stack.length !== 1) return decline(stack.length ? 'NESTED_LOOP' : 'NOT_IN_LOOP');
  start = stack[0]; let end = null; stack = [start];
  for (let i = c.idx + 1; i < c.lines.length && end == null; i += 1) for (const m of c.lines[i].matchAll(/\{%-?\s*(for\b|endfor\b)/g)) { if (m[1] === 'endfor') { stack.pop(); if (!stack.length) { end = i; break; } } else stack.push(i); }
  if (end == null) return decline('LOOP_END_NOT_FOUND');
  const ref = new RegExp(`(?<![\\w-])${id}(?![\\w-])`);
  const outside = [...c.lines.slice(0, start), ...c.lines.slice(end + 1)].join('\n');
  const idRef = new RegExp(`(?:["'#])${id}["']`);
  if (idRef.test(outside) || Object.values(c.context.readonly || {}).some((s) => idRef.test(s) && /getElementById|querySelector|#/.test(s))) return decline('ID_REFERENCED_OUTSIDE_LOOP');
  const out = c.lines.slice();
  const ATTR = new RegExp(`\\b(id|aria-controls|aria-labelledby|aria-describedby|aria-owns|for|headers)(\\s*=\\s*)"${id}"|\\b(href|data-target)(\\s*=\\s*)"#${id}"`, 'g');
  for (let i = start; i <= end; i += 1) {
    const next = out[i].replace(ATTR, (m, a, eq, h, eq2) => (a ? `${a}${eq}"${id}-{{ forloop.index }}"` : `${h}${eq2}"#${id}-{{ forloop.index }}"`));
    if (next !== out[i]) out[i] = next;
  }
  if (!ref.test(c.lines[c.idx]) || out.join('\n') === c.lines.join('\n')) return decline('NO_CHANGE');
  return { lines: out, why: 'id suffixed with forloop.index; references inside the loop updated' };
};

// Page-wide generators work on the file that plays the role, not on a task line.
function pageWide(kind, task, context) {
  const names = Object.keys(context.files || {}).sort();
  const texts = names.map((n) => [n, fileText(context, n)]).filter(([, t]) => t != null);
  const project = [...texts.map(([, t]) => t), ...Object.values(context.readonly || {})].join('\n');
  if (kind === 'lang') {
    const hit = texts.find(([, t]) => /<html(?=[\s>])/i.test(t));
    if (!hit) return decline('HTML_TAG_NOT_IN_CONTEXT');
    const [file, text] = hit; const lines = text.split('\n'); const idx = lines.findIndex((l) => /<html(?=[\s>])/i.test(l));
    const t = locate(lines[idx], 'html');
    if (t.reason) return decline(t.reason);
    if ('lang' in t.attrs) return decline('ALREADY_HAS_LANG');
    const other = /<html\b[^>]*\blang\s*=\s*"([A-Za-z-]{2,12})"/i.exec(project)?.[1];
    const lang = context.siteLang || other;
    if (!lang || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang)) return decline('LANGUAGE_UNKNOWN');
    lines[idx] = addAttrToLine(lines[idx], 'html', `lang="${lang}"`);
    return { files: [{ path: file, before: text, after: lines.join('\n') }], why: `html lang "${lang}" from the site language` };
  }
  if (kind === 'title') {
    const hit = texts.find(([, t]) => /<head(?=[\s>])/i.test(t) && /<\/head>/i.test(t));
    if (!hit) return decline('HEAD_NOT_IN_CONTEXT');
    const [file, text] = hit;
    if (/<title\b/i.test(text)) return decline('TITLE_PRESENT');
    const h1 = [...text.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    const label = h1.length === 1 ? okLabel(textOf(h1[0][1])) : null;
    if (!label) return decline('NO_SAFE_TITLE_SOURCE');
    const lines = text.split('\n'); const idx = lines.findIndex((l) => /^\s*<\/head>/i.test(l));
    if (idx < 1) return decline('HEAD_CLOSE_NOT_ON_OWN_LINE');
    lines.splice(idx, 0, `${indentOf(lines[idx - 1])}<title>${esc(label).replace(/&quot;/g, '"')}</title>`);
    return { files: [{ path: file, before: text, after: lines.join('\n') }], why: 'title from the page h1' };
  }
  // skip link
  if (!/\bsr-only\b/.test(project)) return decline('SR_ONLY_CLASS_NOT_IN_PROJECT');
  const bodyHit = texts.find(([, t]) => /<body(?=[\s>])/i.test(t));
  if (!bodyHit) return decline('BODY_NOT_IN_CONTEXT');
  const [bodyFile, bodyText] = bodyHit; const lines = bodyText.split('\n');
  const bi = lines.findIndex((l) => /<body(?=[\s>])/i.test(l));
  if (!/<body\b[^>]*>\s*$/i.test(lines[bi]) || (lines[bi].match(/<body/gi) || []).length !== 1) return decline('BODY_TAG_NOT_ALONE_ON_LINE');
  if (/<a\b[^>]*href="#[^"]*"[^>]*>\s*skip/i.test(lines.slice(bi, bi + 6).join('\n'))) return decline('SKIP_LINK_EXISTS');
  const mainHit = texts.find(([, t]) => /<main(?=[\s>])/i.test(t));
  if (!mainHit) return decline('MAIN_NOT_IN_CONTEXT');
  const [mainFile, mainText] = mainHit; const ml = mainText.split('\n');
  const mi = ml.findIndex((l) => /<main(?=[\s>])/i.test(l));
  const mt = locate(ml[mi], 'main');
  if (mt.reason) return decline(`MAIN_${mt.reason}`);
  let target = mt.attrs.id;
  if (target != null && (dyn(target) || !target)) return decline('MAIN_ID_DYNAMIC');
  if (target == null) {
    target = 'main-content';
    if (new RegExp(`\\bid\\s*=\\s*["']${target}["']`).test(project)) return decline('MAIN_CONTENT_ID_TAKEN');
    ml[mi] = addAttrToLine(ml[mi], 'main', `id="${target}"`);
  }
  const next = lines.slice(bi + 1).find((l) => l.trim());
  const ind = next ? indentOf(next) : `${indentOf(lines[bi])}  `;
  const link = `${ind}<a href="#${target}" class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:underline">Skip to main content</a>`;
  const files = [];
  if (mainFile === bodyFile) { lines[mi] = ml[mi]; lines.splice(bi + 1, 0, link); files.push({ path: bodyFile, before: bodyText, after: lines.join('\n') }); } else {
    lines.splice(bi + 1, 0, link);
    files.push({ path: bodyFile, before: bodyText, after: lines.join('\n') }, { path: mainFile, before: mainText, after: ml.join('\n') });
  }
  return { files, why: 'skip link after <body>, id on <main>, sr-only until focused' };
}

const PAGE_KIND = { 'html-has-lang': 'lang', 'document-title': 'title', 'skip-link-missing': 'skip', 'skip-link': 'skip' };

/** @param {{ rules?: string[] }} [opts] rules: restrict to a subset of SUPPORTED_RULES. */
export function createRecipesFixer({ rules } = {}) {
  const allowed = rules ? new Set(rules) : null;
  return {
    name: 'recipes',
    mechanicallySafe: true,
    async propose(task, context = {}) {
      const rule = ruleOf(task);
      if (task.requiresDesignDecision || isDesignLocked(rule)) return decline('DESIGN_LOCKED');
      const kind = KIND[rule];
      if (!kind || (allowed && !allowed.has(rule))) return decline('NO_RECIPE');
      const wide = PAGE_KIND[rule];
      if (wide) {
        const r = pageWide(wide, task, context);
        return r.declined ? r : finish(task, r.files, r.why, 0.85);
      }
      const { file, line: n } = taskSource(task);
      const text = fileText(context, file);
      if (!file || n == null || text == null) return decline('SOURCE_LINE_UNAVAILABLE');
      const lines = text.split('\n');
      if (n < 1 || n > lines.length) return decline('LINE_OUT_OF_RANGE');
      const el = parseElement(task.element?.html || '');
      const r = G[kind]({ task, context, file, lines, idx: n - 1, line: lines[n - 1], tag: el.tag, id: el.attrs.id });
      if (r.declined) return r;
      const out = r.lines ? r.lines : Object.assign(lines.slice(), { [n - 1]: r.line });
      return finish(task, [{ path: file, before: text, after: out.join('\n') }], r.why, 0.95);
    },
  };
}
