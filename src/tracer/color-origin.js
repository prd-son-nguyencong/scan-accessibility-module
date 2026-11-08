import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { computeSourcePreimage } from './preimage.js';
import { isGeneratedCss } from './css-origin.js';

/**
 * Colour-contrast findings point at the markup, but the failing colour is declared in CSS: a rule (`.btn--primary { background-color:
 * var(--color-primary) }`, also an ancestor rule the colour is inherited from, or a utility class) and, behind `var(--x)`, a custom
 * property on `:root`. The live CSSOM tells which declaration wins for `color` and `background-color` of the element (`collectColorChains`,
 * in the browser); the project's authored CSS tells where that declaration is written (`locateDeclaration`, by selector and value, since
 * no source map ships with the page). The declaring line is the primary source, the markup stays as `markupFile/markupLine`.
 * shortcut: cascade approximated by !important, specificity, then document order (layers and nested rules ignored); upgrade to source maps if that misattributes.
 */

const NEUTRAL = new Set(['#ffffff', '#000000']);
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** In the page: for each selector, the winning declaration (rule, raw value, custom-property chain) of `color` and of the painted `background-color`. */
export async function collectColorChains(page, selectors) {
  return page.evaluate((selectors) => {
    const specificity = (sel) => {
      const s = sel.replace(/\[[^\]]*\]/g, ' [a] ').replace(/::?[\w-]+(\([^)]*\))?/g, (m) => (m.startsWith('::') ? ' x' : ' :p'));
      return (s.match(/#[\w-]+/g) || []).length * 1e6 + (s.match(/\.[\w-]+|\[a\]|:p/g) || []).length * 1e3 + (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
    };
    const parts = (text) => text.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
    const rules = [];
    const walk = (list, href) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) {
          if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
          walk(rule.cssRules, href);
        } else if (rule.selectorText) rules.push({ rule, href });
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules, sheet.href || null); } catch { /* cross-origin sheet: not readable */ }
    }
    const decl = (el, prop) => {
      let best = null;
      rules.forEach(({ rule, href }, order) => {
        const value = rule.style.getPropertyValue(prop);
        if (!value) return;
        if (/^(inherit|unset|currentcolor|initial)$/i.test(value.trim())) return; // passes the ancestor's colour through
        const imp = rule.style.getPropertyPriority(prop) === 'important' ? 1 : 0;
        for (const part of parts(rule.selectorText)) {
          let hit = false;
          try { hit = el.matches(part); } catch { /* pseudo-element or unsupported */ }
          if (!hit) continue;
          const spec = specificity(part);
          if (!best || imp > best.imp || (imp === best.imp && (spec > best.spec || (spec === best.spec && order > best.order)))) best = { imp, spec, order, prop, selectorText: part, href, value: value.trim() };
        }
      });
      return best;
    };
    // Custom properties inherit: the nearest element (self first) that has a matching declaration wins.
    const chainOf = (el, value) => {
      const chain = [];
      let v = value;
      for (let i = 0; i < 4; i += 1) {
        const name = /var\(\s*(--[\w-]+)/.exec(v)?.[1];
        if (!name) break;
        let found = null;
        for (let n = el; n && !found; n = n.parentElement) found = decl(n, name);
        if (!found) break;
        chain.push({ name, selectorText: found.selectorText, href: found.href, value: found.value });
        v = found.value;
      }
      return chain;
    };
    const rgb = (c) => { const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+%?))?/.exec(c); return m ? { hex: `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`, alpha: m[4] === undefined ? 1 : parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1) } : null; };
    const external = (href) => !!href && new URL(href, location.href).origin !== location.origin;
    const shape = (el, found) => (found ? { prop: found.prop, selectorText: found.selectorText, href: found.href, external: external(found.href), value: found.value, chain: chainOf(el, found.value).map((c) => ({ ...c, external: external(c.href) })) } : null);
    return selectors.map((selector) => {
      let el = null;
      try { el = selector ? document.querySelector(selector) : null; } catch { /* invalid selector */ }
      if (!el) return null;
      let color = null;
      for (let n = el, d = 0; n && d < 8 && !color; n = n.parentElement, d += 1) color = decl(n, 'color');
      let background = null;
      for (let n = el, d = 0; n && !background; n = n.parentElement, d += 1) {
        const bg = rgb(getComputedStyle(n).backgroundColor);
        if (bg && bg.alpha > 0) { background = decl(n, 'background-color') || decl(n, 'background'); break; }
        if (d > 12) break;
      }
      const fgNow = rgb(getComputedStyle(el).color);
      let bgEl = el;
      while (bgEl && !(rgb(getComputedStyle(bgEl).backgroundColor)?.alpha > 0)) bgEl = bgEl.parentElement;
      const bgNow = bgEl ? rgb(getComputedStyle(bgEl).backgroundColor) : null;
      return { color: shape(el, color), background: shape(el, background), computed: { color: fgNow?.hex || null, background: bgNow?.hex || null } };
    });
  }, selectors);
}

/** Authored CSS (src/**) declarations of `prop` in a rule whose selector list holds `selectorText`; `value` narrows by the declared text. `generated` marks reset/vendored files. */
export function locateDeclaration(root, { prop, selectorText, value }) {
  const out = [];
  const want = squash(selectorText);
  const names = prop === 'background-color' ? 'background-color|background' : prop; // `background: #db0007` is a declaration of the colour too
  const re = new RegExp(`(?<![\\w-])(?:${names})\\s*:\\s*([^;}]*)`, 'i');
  for (const file of fg.sync(['src/**/*.css'], { cwd: root, ignore: ['**/node_modules/**', '**/+.css'] }).sort()) {
    let css;
    try { css = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = squash(m[1].replace(/\/\*[\s\S]*?\*\//g, ''));
      const d = re.exec(m[2]);
      if (!d) continue;
      const selectors = head.split(/\s*,\s*/);
      out.push({ file, line: css.slice(0, m.index + m[0].indexOf('{') + 1 + d.index).split('\n').length, selector: head, declared: squash(d[1]), bySelector: selectors.includes(want), byValue: !value || squash(d[1]).replace(/\s*!important$/, '') === squash(value).replace(/\s*!important$/, ''), generated: isGeneratedCss(root, file) });
    }
  }
  const tight = out.filter((c) => c.bySelector && c.byValue);
  const pool = tight.length ? tight : out.filter((c) => c.bySelector).length ? out.filter((c) => c.bySelector) : out.filter((c) => c.byValue && /^--/.test(prop));
  return pool.sort((a, b) => Number(a.generated) - Number(b.generated));
}

/** Where one role's (colour / background) winning declaration is authored; the custom-property chain's last link when the value goes through `var()`. */
function locateRole(role, c, hex, root) {
  if (!c) return null;
  const last = c.chain.at(-1);
  const decl = last || null;
  const locs = decl ? locateDeclaration(root, { prop: decl.name, selectorText: decl.selectorText, value: decl.value }) : locateDeclaration(root, { prop: c.prop, selectorText: c.selectorText, value: c.value });
  const rule = decl ? locateDeclaration(root, { prop: c.prop, selectorText: c.selectorText, value: c.value })[0] : null;
  const label = decl ? `var(${c.chain[0].name}) -> ${decl.value}` : c.value;
  return { role, hex, neutral: NEUTRAL.has(hex), token: decl ? c.chain[0].name : null, label, locs: locs.filter((l) => !l.generated), rule: rule && !rule.generated ? rule : null, selector: c.selectorText };
}

const at = (l) => `${l.file}:${l.line}`;

const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when the project uses the custom property of `pick` for something else than the failing role: another property's `var()`, or a utility class of another role. */
function tokenUsedElsewhere(root, pick) {
  const name = pick.token.replace(/^--color-/, '');
  const mine = pick.role === 'foreground' ? /^(?:color)$/ : /^(?:background|background-color)$/;
  const utility = new RegExp(`(?<![\\w-])(?:${pick.role === 'foreground' ? 'bg|border|outline|ring|fill|stroke|decoration' : 'text'})-${escRe(name)}(?![\\w-])`);
  for (const file of fg.sync(['src/**/*.{css,liquid,js,html}'], { cwd: root, ignore: ['**/node_modules/**', '**/+.css'] })) {
    let text;
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (file.endsWith('.css')) {
      for (const m of text.matchAll(new RegExp(`(?<![\\w-])([\\w-]+)\\s*:\\s*[^;{}]*var\\(\\s*${escRe(pick.token)}\\b`, 'g'))) if (!mine.test(m[1]) && !m[1].startsWith('--')) return true;
    }
    if (utility.test(text)) return true;
  }
  return false;
}

/**
 * Re-points a colour-contrast finding at the authored declaration of the failing colour. The foreground wins unless it is white/black
 * (then the background is the colour that fails). Returns false when no authored declaration was found, leaving the caller's trace alone.
 */
export function applyColorOrigin(v, root) {
  const chain = v.colorChain;
  delete v.colorChain;
  if (!chain || !v.source) return false;
  const roles = [locateRole('foreground', chain.color, chain.computed.color, root), locateRole('background', chain.background, chain.computed.background, root)].filter((r) => r?.locs.length);
  const pick = roles.find((r) => !r.neutral) || roles[0];
  if (!pick) return false;
  // White or black only: the colour that fails is the other one. When that one is not neutral and has no authored declaration (a utility class,
  // an alpha overlay), blaming the neutral token would name a line that cannot fix it: the markup trace stays.
  if (pick.neutral) {
    const other = pick.role === 'foreground' ? chain.computed?.background : chain.computed?.color;
    if (other && !NEUTRAL.has(other)) return false;
  }
  // A token that other roles or properties use as well (`bg-x`, an outline, a background rule) cannot be darkened for this one use: the rule that applies it here is the fix.
  const shared = Boolean(pick.token && pick.rule && tokenUsedElsewhere(root, pick));
  const primary = shared ? pick.rule : pick.locs[0];
  const others = [
    ...(shared ? pick.locs : pick.locs.slice(1)),
    ...(pick.rule && !shared ? [pick.rule] : []),
    ...roles.filter((r) => r !== pick).flatMap((r) => r.locs.slice(0, 1)),
  ].filter((l) => at(l) !== at(primary));
  const preimage = computeSourcePreimage(primary.file, primary.line, root);
  v.source = {
    ...v.source,
    markupFile: v.source.file && v.source.file !== 'unknown' ? v.source.file : undefined,
    markupLine: v.source.line || undefined,
    file: primary.file, line: primary.line, confidence: 'medium', method: pick.token && !shared ? 'css-token' : 'css-rule', cssSelector: primary.selector,
    partial: undefined, preimageSha256: preimage?.preimageSha256 || null, preimageRange: preimage?.range || null,
  };
  // The markup that applies the colour is the other place a shared-token failure is fixed (a darker utility at the use site).
  if (pick.token && v.source.markupFile) v.source.alsoLikelyIn = [{ file: v.source.markupFile, line: v.source.markupLine ?? null }];
  if (pick.token) v.source.tokenSource = { file: pick.locs[0].file, line: pick.locs[0].line, token: pick.token };
  v.sourceCandidates = [...(v.sourceCandidates || []).filter((c) => at(c) !== at(primary)), ...others.map((l) => ({ file: l.file, line: l.line, confidence: 'low', method: 'css-token' }))];
  const sentence = (r) => `${r.role === 'foreground' ? 'color' : 'background-color'} ${r.hex} from ${r.token ? r.label : `${r.selector} { ${r.label} }`} declared at ${at(r.locs[0])}`;
  const note = roles.map(sentence).join('; ');
  v.evidence = { ...v.evidence, colorOrigin: { role: pick.role, token: pick.token, declaration: at(primary), chain: note } };
  if (v.evidence.proof?.fact) v.evidence = { ...v.evidence, proof: { ...v.evidence.proof, fact: `${v.evidence.proof.fact}\nResolved: ${note}` } };
  return true;
}

/**
 * One finding per declaration: contrast findings whose colour comes from the same authored line (a token or a rule shared by many
 * elements) collapse into the first, which carries `evidence.occurrences` (count, up to 20 selectors, the declaration), so it is fixed once.
 */
export function groupByColorOrigin(violations) {
  const groups = new Map();
  for (const v of violations) {
    delete v.colorChain;
    const o = v.evidence?.colorOrigin;
    if (!o || !/color-contrast/i.test(v.ruleId || v.rule || '') || !['css-token', 'css-rule'].includes(v.source?.method)) continue;
    const key = [v.ruleId || v.rule, v.verdict, o.declaration, o.role].join('|');
    (groups.get(key) || groups.set(key, []).get(key)).push(v);
  }
  const drop = new Set();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [head, ...rest] = list;
    const selectors = [...new Set(list.map((v) => v.element?.selector).filter(Boolean))];
    head.count = list.reduce((n, v) => n + (v.count || 1), 0);
    head.evidence = { ...head.evidence, occurrences: { count: head.count, declaration: head.evidence.colorOrigin.declaration, token: head.evidence.colorOrigin.token, selectors: selectors.slice(0, 20) } };
    rest.forEach((v) => drop.add(v));
  }
  return drop.size ? violations.filter((v) => !drop.has(v)) : violations;
}
