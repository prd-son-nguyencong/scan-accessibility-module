import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { buildTagIndex, isGenericClass } from './liquid-tag-index.js';

/**
 * Behaviour findings (keyboard, focus trap, disclosure, dismissal) are produced by a script, not by the markup the element is
 * authored in: the template line only says where the trigger lives, the defect is where the handler or the `tabindex` write is.
 * This attributes such a finding to the script line that opens / traps / mutates the element, found by a static scan of
 * `src/scripts/**` for a rule-specific signal that sits next to a selector token of the element (its class, id, `aria-controls`
 * target). No tie to the element means no attribution (the template stays the source). The template line is kept as `alsoLikelyIn`.
 * The tie is structural: the token and the signal must sit in related function scopes (the same function, or one nested in the other,
 * a module-level token being visible to every function below it). Two sibling functions never tie: that match is `weak` (cross-scope)
 * and the caller keeps the template as the source. shortcut: a brace scanner (strings, comments, regex literals skipped, no parser)
 * decides what a function is; upgrade to an AST walk if a template literal holding `${ {} }` or an exotic regex derails it.
 */

const Q = '["\'`]';
const ESCAPE = /key\s*={2,3}\s*["']Escape|keyCode\s*={2,3}\s*27|["']Escape["']|escapeDeactivates/;

/** Rule id -> signals in priority order (the first signal that has a tied line wins). `inTemplate` also scans the component that authors the markup. */
const RULES = {
  'menu-links-unreachable-by-keyboard': [[new RegExp(`tabindex${Q}\\s*,\\s*${Q}-1|tabIndex\\s*=\\s*-1`, 'i')]],
  'dropdown-not-dismissible-with-escape': [
    [/(?:addEventListener\(|\.on\()\s*["'`](?:focusin|focus)\b/],
    [/(?:addEventListener\(|\.on\()\s*["'`](?:mouseenter|mouseover)\b/],
    [new RegExp(`aria-expanded${Q}\\s*,\\s*(?:${Q}true${Q}|open|true)`)],
    [/(?:addEventListener\(|\.on\()\s*["'`]click\b/],
  ],
  'focus-lost-after-escape': [[/returnFocusOnDeactivate\s*:\s*false/], [/\.deactivate\(/], [ESCAPE]],
  'modal-focus-escapes': [
    [/createFocusTrap\(/],
    [new RegExp(`aria-expanded${Q}\\s*,\\s*${Q}true${Q}|classList\\.remove\\(\\s*${Q}hidden${Q}|showModal\\(|\\.open\\s*=\\s*true`)],
    [/(?:addEventListener\(|\.on\()\s*["'`]click\b/],
  ],
  'role-button-not-keyboard-operable': [[/(?:addEventListener\(|\.on\()\s*["'`]click\b|\.click\(\s*\)/]],
};
// The handler that shows the panel is the line that never writes aria-expanded (the template already writes the initial false).
RULES['aria-expanded-not-updated'] = [[/\.(?:slideToggle|slideDown|fadeToggle|fadeIn|toggle)\(|classList\.(?:toggle|add|remove)\(|\.hidden\s*=(?!=)|\.toggleClass\(|\.(?:show|hide)\(/], [/(?:addEventListener\(|\.on\()\s*["'`]click\b/]];
RULES['modal-focus-not-trapped'] = RULES['modal-focus-escapes'];
RULES['modal-escape-key-not-working'] = [[ESCAPE], ...RULES['modal-focus-escapes']];

/** Own markup tokens that never identify an element: layout / state words and Tailwind utilities. */
const GENERIC = /^(?:hidden|current|active|open|close|closed|show|shown|true|false|none|flex|grid|block|inline|relative|absolute|fixed|sticky|button|link|text|font|size|gap|rounded|shadow|transition|group|container|wrapper|inner|outer|content|item|items|list|body|header|footer|nav|menu|main|section|svg|icon)$|^(?:hocus|hover|focus|group|peer|md|lg|sm|xl|before|after|max|min)[:-]|[:[\]/]|^(?:text|bg|border|px|py|pt|pb|pl|pr|mt|mb|ml|mr|gap|size|w|h|z|top|left|right|bottom|inset|leading|tracking|opacity|order|col|row|basis|grow|shrink|items|justify|self|place|space|divide|ring|outline|fill|stroke|duration|ease|delay|translate|rotate|scale|min-w|min-h|max-w|max-h)-/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Identifying tokens of the live element: id, classes, `aria-controls` / `data-*` values, selector ids and classes. */
export function elementTokens(html, selector, snippet) {
  const tag = /^\s*<[a-z][\w-]*((?:"[^"]*"|'[^']*'|[^>"'])*)/i.exec(html || '')?.[1] || '';
  const raw = [];
  for (const m of tag.matchAll(/\s(class|id|aria-controls|aria-owns|data-[\w-]+|name)\s*=\s*"([^"]*)"/g)) {
    raw.push(...m[2].split(/[^\w-]+/));
    // A rendered component marks its flags as `data-pdk-param-oliviabutton="true"`: the flag name is what a script selects by (`.oliviaButton`).
    if (/^data-pdk-param-/.test(m[1]) && m[2] === 'true') raw.push(m[1].slice('data-pdk-param-'.length));
  }
  // The traced template tag itself (a finding whose live element is only a selector, e.g. `button[aria-controls]`): its ids name the dialog or panel.
  const marked = String(snippet || '').split('\n');
  const from = marked.findIndex((l) => /^>/.test(l));
  if (from >= 0) for (const l of marked.slice(from, from + 8)) for (const m of l.matchAll(/\s(?:id|aria-controls)="([^"{}]*)"/g)) raw.push(m[1]);
  // Only a selector's ids, classes and attribute values identify an element: a bare tag name (label, input, dialog) is on every page.
  for (const m of String(selector || '').replace(/:nth-[\w-]+\([^)]*\)/g, ' ').matchAll(/[.#]([\w-]+)|\[[\w-]+[~|^$*]?=["']?([\w-]+)/g)) raw.push(m[1] || m[2]);
  const out = new Set();
  for (const t of raw) {
    const tok = t.replace(/\.\.\.$/, '');
    if (tok.length < 5 || GENERIC.test(tok) || /^\d/.test(tok)) continue;
    out.add(tok);
    const base = tok.split(/--|__/)[0];
    if (base.length >= 8 && base !== tok && !GENERIC.test(base)) out.add(base);
  }
  return [...out];
}

const CONTROL = /^(?:if|for|while|switch|catch|with)$/;

/** True when the statement text before a `{` opens a function body (`=> {`, `function f() {`, `method() {`, `foo(function () {`), not a control block. */
function opensFunction(head) {
  const h = head.trim();
  if (/=>$/.test(h)) return true;
  if (!h.endsWith(')')) return false;
  let depth = 0;
  let i = h.length - 1;
  for (; i >= 0; i--) {
    if (h[i] === ')') depth++;
    else if (h[i] === '(' && --depth === 0) break;
  }
  const name = /([\w$]+)\s*$/.exec(h.slice(0, Math.max(i, 0)))?.[1] || '';
  return !CONTROL.test(name);
}

/**
 * Function scope of every line: `scope[i]` is the id of the innermost function open at the start of line i (0 = module level), `parent`
 * links ids to their enclosing function, `span[id]` is the line count of the function. Strings, comments and regex literals are skipped.
 */
export function functionScopes(lines) {
  const scope = new Array(lines.length).fill(0);
  const parent = [0];
  const first = [0];
  const span = [Infinity];
  const stack = []; // function id, or 0 for a plain block
  const fns = [];
  let head = '';
  let blockComment = false;
  let tpl = false;
  let last = ''; // last significant code char, decides whether `/` starts a regex
  const cur = () => fns[fns.length - 1] || 0;
  lines.forEach((line, li) => {
    scope[li] = cur();
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (blockComment) { if (ch === '*' && line[c + 1] === '/') { blockComment = false; c++; } continue; }
      if (tpl) { if (ch === '\\') c++; else if (ch === '`') { tpl = false; head += '""'; last = '"'; } continue; }
      if (ch === '/' && line[c + 1] === '/') break;
      if (ch === '/' && line[c + 1] === '*') { blockComment = true; c++; continue; }
      if (ch === '"' || ch === "'") {
        for (c++; c < line.length && line[c] !== ch; c++) if (line[c] === '\\') c++;
        head += '""'; last = '"'; continue;
      }
      if (ch === '`') { tpl = true; continue; }
      if (ch === '/' && (last === '' || /[(,=:[!&|?{};]/.test(last))) {
        let inClass = false;
        for (c++; c < line.length && (line[c] !== '/' || inClass); c++) { if (line[c] === '\\') c++; else if (line[c] === '[') inClass = true; else if (line[c] === ']') inClass = false; }
        head += 'x'; last = 'x'; continue;
      }
      if (ch === '{') {
        let id = 0;
        if (opensFunction(head)) {
          id = parent.length;
          parent.push(cur());
          first.push(li);
          span.push(0);
          fns.push(id);
        }
        stack.push(id);
        head = '';
      } else if (ch === '}') {
        const id = stack.pop();
        if (id) { fns.pop(); span[id] = li - first[id] + 1; }
        head = '';
      } else if (ch === ';') head = '';
      else head += ch;
      if (!/\s/.test(ch)) last = ch;
    }
    head += ' ';
  });
  for (let id = 1; id < span.length; id++) if (!span[id]) span[id] = lines.length - first[id];
  return { scope, parent, span };
}

/** How two lines relate: `outer` = the span of the wider of their two scopes when one scope encloses the other (the token is visible to the signal), null when they sit in sibling functions. */
function relate(fs, a, b) {
  const sa = fs.scope[a];
  const sb = fs.scope[b];
  const encloses = (outer, inner) => { for (let s = inner; ; s = fs.parent[s]) { if (s === outer) return true; if (s === 0) return false; } };
  if (encloses(sa, sb)) return fs.span[sa];
  if (encloses(sb, sa)) return fs.span[sb];
  return null;
}

function scriptFiles(root) {
  const out = [];
  for (const file of fg.sync(['src/scripts/**/*.{js,mjs,ts}'], { cwd: root, ignore: ['**/node_modules/**'] }).sort()) {
    try { const lines = readFileSync(path.join(root, file), 'utf8').split('\n'); out.push({ file, lines, fs: functionScopes(lines) }); } catch { /* unreadable */ }
  }
  return out;
}

const isComment = (l) => /^\s*(?:\/\/|\*|\/\*)/.test(l);

/** Lines of `src` that name `token` as a whole word (a selector string, an id, a variable-free literal), comments excluded. */
function tokenLines(lines, token) {
  const re = new RegExp(`(?<![\\w-])${esc(token)}(?![\\w-])`, 'i');
  const out = [];
  lines.forEach((l, i) => { if (!isComment(l) && re.test(l)) out.push(i); });
  return out;
}

/** The authored component whose tag writes the same role / class tokens (the markup behind a role="button" that no script operates). */
function markupOwner(files, html, root) {
  const role = /\srole="([^"]*)"/.exec(html || '')?.[1];
  const classes = (/\sclass="([^"]*)"/.exec(html || '')?.[1] || '').split(/\s+/).filter((c) => c.length > 4 && !/\.\.\.$/.test(c) && !GENERIC.test(c) && !isGenericClass(c));
  // A component that builds its class from a captured variable (`class="{{ buttonClass }}"`) has no literal class tokens: the flag it was rendered with
  // (`data-pdk-param-oliviabutton="true"`) is the name of the Liquid condition that writes the role.
  const flags = [...String(html || '').matchAll(/\sdata-pdk-param-([\w-]+)="true"/g)].map((m) => m[1].toLowerCase());
  if (!role || !(classes.length || flags.length)) return null;
  for (const file of files) {
    let tags;
    try { tags = buildTagIndex(file, root); } catch { continue; }
    const hit = tags.find((t) => t.staticAttrs.role === role && (classes.some((c) => t.classTokens.includes(c)) || flags.some((f) => f in t.staticAttrs)));
    if (hit) return { file, line: hit.line };
  }
  return null;
}

/**
 * @param {{ ruleId: string, html: string, selector?: string }} finding the live element
 * @param {string[]} files the page's render tree (templates) and, for markup behind a role, its components
 * @returns {{ file: string, line: number, signal: string, ambiguous: boolean, weak: boolean, candidates: {file,line}[], tokens: string[] } | null}
 */
export function findBehaviorScript({ ruleId, html, selector, snippet }, files, root) {
  const signals = RULES[String(ruleId || '').toLowerCase()];
  if (!signals) return null;
  const tokens = elementTokens(html, selector, snippet);
  if (!tokens.length) return null;
  const sources = scriptFiles(root);
  const id = String(ruleId).toLowerCase();
  let weak = null;
  for (const group of signals) {
    const hits = [];
    const cross = [];
    for (const src of sources) {
      const byToken = tokens.map((t) => ({ t, at: tokenLines(src.lines, t) })).filter((x) => x.at.length);
      if (!byToken.length) continue;
      src.lines.forEach((l, i) => {
        if (isComment(l) || !group.some((re) => re.test(l))) return;
        // A token mention is tied to the signal when its function scope is the signal's, encloses it or is enclosed by it. At module level
        // (no function around the pair) only a window of lines ties them; a mention in a sibling function never does.
        const inWindow = (a) => a >= i - 80 && a <= i + 8;
        const mine = [];
        const sibling = [];
        for (const x of byToken) {
          const pairs = x.at.map((a) => ({ a, outer: relate(src.fs, a, i) }));
          const ok = pairs.filter((p) => p.outer !== null && (p.outer !== Infinity || inWindow(p.a)));
          if (ok.length) mine.push({ outer: Math.min(...ok.map((p) => p.outer)), dist: Math.min(...ok.map((p) => Math.abs(p.a - i))) });
          else if (pairs.some((p) => p.outer === null && inWindow(p.a))) sibling.push(x);
        }
        const at = { file: src.file, line: i + 1 };
        if (mine.length) hits.push({ ...at, mine: mine.length, span: Math.min(...mine.map((m) => m.outer)), dist: Math.min(...mine.map((m) => m.dist)) });
        else if (sibling.length) cross.push({ ...at, mine: sibling.length, span: Infinity, dist: 0 });
      });
    }
    if (!hits.length) { if (!weak && cross.length) weak = { group, hits: cross }; continue; }
    return shape(hits, group, tokens, id, files, html, root, sources, false);
  }
  return weak ? shape(weak.hits, weak.group, tokens, id, files, html, root, sources, true) : null;
}

const cmp = (a, b) => b.mine - a.mine || a.span - b.span || a.dist - b.dist;

function shape(hits, group, tokens, id, files, html, root, sources, isWeak) {
  const best = hits.slice().sort(cmp);
  let pick = best[0];
  const tie = best.length > 1 && cmp(best[0], best[1]) === 0;
  const candidates = hits.filter((h) => h !== pick).slice(0, 5).map((h) => ({ file: h.file, line: h.line }));
  // A commented-out restore of the very write (`.attr("tabindex", "0")` next to `.attr("tabindex", "-1")`) is the line to bring back.
  if (id === 'menu-links-unreachable-by-keyboard') {
    const src = sources.find((x) => x.file === pick.file);
    const sel = /["'`]([^"'`]{2,})["'`]/.exec(src.lines[pick.line - 1])?.[1];
    const re = /tabindex["'`]\s*,\s*["'`]?0\b/i;
    const restore = sel && src.lines.map((l, i) => ({ l, i })).filter(({ l, i }) => isComment(l) && re.test(l) && l.includes(sel) && relate(src.fs, i, pick.line - 1) !== null)
      .sort((x, y) => Math.abs(x.i - pick.line) - Math.abs(y.i - pick.line))[0];
    if (restore) { candidates.unshift({ file: pick.file, line: pick.line }); pick = { ...pick, line: restore.i + 1 }; }
  }
  return {
    file: pick.file,
    line: pick.line,
    signal: group[0].source,
    ambiguous: tie,
    weak: isWeak,
    candidates,
    tokens,
    markup: id === 'role-button-not-keyboard-operable' ? markupOwner(files, html, root) : null,
  };
}

export const BEHAVIOR_RULES = new Set(Object.keys(RULES));
