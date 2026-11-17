import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { buildTagIndex } from './liquid-tag-index.js';
import { containedPath } from '../utils/paths.js';

/**
 * Attributes a project script rewrites after the page is served: when the live value of `href` / `src` / `role` / `aria-*` / `class` /
 * `style` differs from every value the page's templates write, the script that mutates that attribute is where the defect is made
 * (`links[i].href += path`, `el.setAttribute('aria-label', ..)`, `el.classList.add('x')`, `el.style.color = ..`). Generic: any
 * property assignment, `+=` or `setAttribute` of the attribute in `src/scripts/**` or an inline <script> of the page's render tree.
 * shortcut: the script is matched to the element by the class/id tokens of its selector strings and the template lines above the
 * authored tag; a script that selects by tag name alone is listed as an ambiguous candidate, upgrade to a DOM-path check if that misattributes.
 */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const Q = '["\'`]';

/** Attributes worth checking for a finding, by what the rule is about. */
export function attributesFor(ruleId, layer) {
  const rule = String(ruleId || '').toLowerCase();
  if (layer === 'links' || /^(dead-link|broken-link|link-)/.test(rule)) return ['href'];
  if (/color-contrast|target-size/.test(rule)) return ['class', 'style'];
  if (/image|img/.test(rule)) return ['src'];
  // A role rule (aria-allowed-role, role-*) is caused by the role value only: never blame a script that merely also sets a label.
  if (/role/.test(rule) && !/label|name/.test(rule)) return ['role'];
  if (/aria|label|name|role/.test(rule)) return ['role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-expanded', 'title', 'alt', 'text'];
  return [];
}

/** Line patterns that write attribute `name` (or, for `class`, the literal token `value`). */
function writePatterns(name, value) {
  const set = new RegExp(`setAttribute\\(\\s*${Q}${esc(name)}${Q}`);
  if (name === 'href' || name === 'src') return [new RegExp(`(?<!location)\\.${name}\\s*(?:\\+=|=(?!=))`), set];
  if (name === 'role') return [/\.role\s*=(?!=)/, set];
  // GSAP SplitText labels the element it splits with its full text (option `aria`, default "auto"): the constructor call is the write.
  if (name === 'aria-label') return [/\.ariaLabel\s*=(?!=)/, set, /new\s+SplitText\(/];
  if (name === 'title' || name === 'alt') return [new RegExp(`\\.${name}\\s*(?:\\+=|=(?!=))`), set];
  if (name === 'text') return [/\.(?:textContent|innerText|innerHTML)\s*(?:\+=|=(?!=))/];
  if (name === 'class') return value ? [new RegExp(`classList\\.(?:add|toggle|replace)\\([^)]*${esc(value)}`), new RegExp(`className\\s*(?:\\+=|=(?!=)).*${esc(value)}`), set] : [];
  if (name === 'style') return [/\.style\.[\w-]+\s*=(?!=)/, /\.style\.cssText\s*(?:\+=|=(?!=))/, set];
  return [set];
}

/** Attributes (and `text`) whose written value is compared with the live one: the label a script writes is what the finding quotes. */
export const VALUE_ATTRS = new Set(['aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'alt', 'text']);

/**
 * The value a script line writes (`setAttribute('aria-label', `Show slide ${i}`)`, `el.title = 'Go ' + n`, `el.textContent = label`) as a pattern the
 * live value must match: literal pieces are kept, every expression becomes a wildcard. `staticLen` is the number of literal characters; a value that
 * is only an expression (`label`) says nothing, so it neither confirms nor contradicts.
 */
export function writtenValuePattern(line, name) {
  const expr = name === 'text'
    ? /\.(?:textContent|innerText|innerHTML)\s*(?:\+=|=)(?!=)\s*(.+?);?\s*$/.exec(line)?.[1]
    : new RegExp(`setAttribute\\(\\s*${Q}${esc(name)}${Q}\\s*,\\s*(.+)\\)\\s*;?\\s*$`).exec(line)?.[1] || new RegExp(`\\.(?:${name === 'aria-label' ? 'ariaLabel' : name})\\s*(?:\\+=|=)(?!=)\\s*(.+?);?\\s*$`).exec(line)?.[1];
  if (!expr) return null;
  let src = '';
  let staticLen = 0;
  const lit = (t) => { staticLen += t.length; return esc(t); };
  for (const m of expr.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^+`'"\s][^+]*)/g)) {
    if (m[1] !== undefined) src += m[1].split(/\$\{[^}]*\}/).map(lit).join('[\\s\\S]*?');
    else if (m[4] === undefined) src += lit(m[2] ?? m[3]);
    else src += '[\\s\\S]*?';
  }
  return { re: new RegExp(`^\\s*${src}\\s*$`), staticLen };
}

/** Script text of the page: every project script file, plus the lines inside <script> blocks of the render tree's templates. */
function scriptSources(files, root) {
  const out = [];
  for (const file of fg.sync(['src/scripts/**/*.{js,mjs,ts}'], { cwd: root, ignore: ['**/node_modules/**'] }).sort()) {
    try { out.push({ file, lines: readFileSync(path.join(root, file), 'utf8').split('\n'), all: true }); } catch { /* unreadable */ }
  }
  for (const file of files) {
    const full = containedPath(root, file);
    if (!full || !file.endsWith('.liquid')) continue;
    let lines;
    try { lines = readFileSync(full, 'utf8').split('\n'); } catch { continue; }
    let open = false;
    const inside = new Set();
    lines.forEach((l, i) => {
      if (/<script\b/i.test(l)) open = true;
      if (open) inside.add(i);
      if (/<\/script\s*>/i.test(l)) open = false;
    });
    if (inside.size) out.push({ file, lines, inside });
  }
  return out;
}

/** Class and id tokens of the last selector string (querySelector, getElementById, getElementsByClassName) before a write: the collection the write loops over. */
function scriptTokens(lines, i) {
  const text = lines.slice(Math.max(0, i - 30), i + 1).join('\n');
  const last = [...text.matchAll(/(?:querySelector(?:All)?|getElementById|getElementsByClassName|closest|matches|new\s+SplitText)\(\s*["'`]([^"'`]+)["'`]/g)].pop();
  return new Set(last ? [...last[1].matchAll(/[.#]?([A-Za-z_][\w-]{3,})/g)].map((t) => t[1]) : []);
}

/** Class and id tokens around an authored tag: its own, and those of the ~15 template lines above it (its wrappers). */
function elementTokens(html, selector, tag, root) {
  const tokens = new Set();
  const add = (s) => (s || '').split(/[^\w-]+/).filter((t) => t.length > 3).forEach((t) => tokens.add(t));
  add(/class="([^"]*)"/.exec(html)?.[1]);
  add(/id="([^"]*)"/.exec(html)?.[1]);
  add(String(selector || '').replace(/:nth-[\w-]+\([^)]*\)/g, ' '));
  if (tag) {
    try {
      const lines = readFileSync(containedPath(root, tag.file), 'utf8').split('\n').slice(Math.max(0, tag.line - 16), tag.line);
      for (const l of lines) for (const m of l.matchAll(/(?:class|id)="([^"]*)"/g)) add(m[1]);
    } catch { /* unreadable */ }
  }
  return tokens;
}

/**
 * @param {{ html: string, selector?: string, ruleId?: string, layer?: string }} finding the live element
 * @param {string[]} files the page's render tree (templates)
 * @returns {{ file, line, attr, value, candidates, ambiguous, templateSource } | null}
 */
export function findAttributeWriter({ html, selector, ruleId, layer }, files, root) {
  // axe shortens long attribute values and class lists to `...`: a value cut that way is compared by its prefix, never as a whole.
  const rendered = /^\s*<([a-z][\w-]*)([^>]*)>?/i.exec(html || '');
  if (!rendered) return null;
  const tagName = rendered[1].toLowerCase();
  const tags = files.flatMap((file) => buildTagIndex(file, root).filter((t) => t.tagName === tagName).map((tag) => ({ file, line: tag.line, tag })));
  const sources = scriptSources(files, root);
  for (const name of attributesFor(ruleId, layer)) {
    const liveText = />([^<]+)</.exec(html)?.[1]?.trim();
    const live = name === 'class' ? null : name === 'text' ? (/\s(?:aria-label|aria-labelledby)="/.test(rendered[2]) ? null : liveText) : new RegExp(`\\s${esc(name)}="([^"]*)"`).exec(rendered[2])?.[1];
    const cut = typeof live === 'string' && live.endsWith('...');
    const liveCore = cut ? live.slice(0, -3) : live;
    let value = live;
    let authoredPrefix = null;
    if (name === 'class') {
      // A live class token no template of that tag writes (static or as a Liquid pattern) can only have been added by script.
      const liveTokens = (/class="([^"]*)"/.exec(rendered[2])?.[1] || '').split(/\s+/).filter((c) => c.length > 2 && !c.endsWith('...'));
      value = liveTokens.find((c) => !tags.some(({ tag }) => tag.classTokens.includes(c) || tag.dynamicClasses.some((re) => re.test(c))));
      if (!value) continue;
    } else {
      if (!live) continue;
      const authored = name === 'text' ? tags.some(({ tag }) => tag.text === live)
        : cut ? tags.some(({ tag }) => (tag.staticAttrs[name] || '').startsWith(liveCore) || tag.dynamicAttrs[name]) // a cut value cannot rule out a template that builds it
          : tags.some(({ tag }) => tag.staticAttrs[name] === live || tag.dynamicAttrs[name]?.test(live));
      if (authored) continue;
      // `href += path`: the authored tag carries the served value and the script appended to it.
      if (name === 'href' || name === 'src') authoredPrefix = tags.find(({ tag }) => (tag.staticAttrs[name] || '').length >= 5 && tag.staticAttrs[name] !== live && live.startsWith(tag.staticAttrs[name]) && (!liveText || !tag.text || tag.text === liveText)) || null;
    }
    const patterns = writePatterns(name, name === 'class' ? value : null);
    const wanted = elementTokens(html, selector, authoredPrefix, root);
    const hits = [];
    for (const src of sources) {
      src.lines.forEach((l, i) => {
        if (src.inside && !src.inside.has(i)) return;
        if (!patterns.some((re) => re.test(l))) return;
        if (name === 'aria-label' && /new\s+SplitText\(/.test(l) && /aria\s*:\s*["'`](?:none|hidden)/.test(src.lines.slice(i, i + 4).join(' '))) return; // the call opts out of the label
        let mine = [...scriptTokens(src.lines, i)].filter((t) => wanted.has(t)).length;
        if (VALUE_ATTRS.has(name) && !cut) {
          // The script writes literal text: it must be able to produce the live value (`Show slide ${i}` -> "Show slide 3"); one that cannot is not the writer.
          const written = writtenValuePattern(l, name);
          if (written?.staticLen >= 4) {
            if (!written.re.test(live)) return;
            mine += 10;
          }
        }
        hits.push({ file: src.file, line: i + 1, mine });
      });
    }
    if (!hits.length) continue;
    const near = hits.filter((h) => h.mine > 0);
    // Without a selector tie only a script-only class token (named literally in the write) is a lead.
    if (!near.length && name !== 'class') continue;
    const pool = near.length ? near : hits;
    const top = Math.max(...pool.map((h) => h.mine));
    const best = pool.filter((h) => h.mine === top);
    const templateSource = authoredPrefix ? { file: authoredPrefix.file, line: authoredPrefix.line } : null;
    return { file: best[0].file, line: best[0].line, attr: name, value, candidates: pool.filter((h) => h !== best[0]).map((h) => ({ file: h.file, line: h.line })), ambiguous: best.length > 1 || !near.length, templateSource };
  }
  return null;
}
