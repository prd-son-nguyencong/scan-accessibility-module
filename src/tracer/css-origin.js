import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { computeSourcePreimage } from './preimage.js';
import { buildTagIndex, collectRenderTree } from './liquid-tag-index.js';

/**
 * CSS-origin tracing for size findings (target-size): the markup is not where the size is declared. The live page tells which
 * stylesheet rule declares it (`collectCssRules`, in the browser), the project's own CSS sources tell where that rule lives
 * (`locateCssRule`). Utility classes (Tailwind) have no rule in a source file, so those findings stay on the markup.
 * Every matching rule that declares a size is a candidate (cascade order: specificity, then last in document). The finding goes to the first one
 * that lives in an authored file: a reset or a file whose header says generated / synced / do not edit (or whose path says reset, synced, vendor)
 * is never the place to fix; the other located rules are listed as `sourceCandidates`. A size finding is never left on a line of JavaScript.
 * shortcut: cascade approximated by specificity then document order; !important and layers ignored, upgrade if that misattributes.
 */

export const SIZE_PROPS = ['width', 'height', 'min-width', 'min-height', 'inline-size', 'block-size', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'line-height', 'font-size', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'row-gap', 'column-gap'];
export const isSizeRule = (id) => /target[-_ ]?size/i.test(String(id || ''));

// Properties a child inherits: when the element has no rule of its own for them, the ancestor rule that sets them is the origin.
export const INHERITED_PROPS = ['line-height', 'font-size'];

/**
 * In the page: for each selector, the winning stylesheet rule that declares one of `props` for the matched element (default: the size
 * properties). The element's own rules come first; when there are none, rules of its ancestors that set an inherited property
 * (line-height, font-size) are listed with `inherited: true`. Works for any finding source (axe, lighthouse, a tool-owned measurement).
 */
export async function collectCssRules(page, selectors, props = SIZE_PROPS) {
  return page.evaluate(({ selectors, props, inheritable }) => {
    const specificity = (sel) => {
      const s = sel.replace(/\[[^\]]*\]/g, ' [a] ').replace(/::?[\w-]+(\([^)]*\))?/g, (m) => (m.startsWith('::') ? ' x' : ' :p'));
      const ids = (s.match(/#[\w-]+/g) || []).length;
      const cls = (s.match(/\.[\w-]+|\[a\]|:p/g) || []).length;
      const tags = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
      return ids * 1e6 + cls * 1e3 + tags;
    };
    const parts = (text) => text.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
    const rules = [];
    const walk = (list, href) => {
      for (const rule of list) {
        if (rule.cssRules && !rule.selectorText) {
          if (rule.media && !matchMedia(rule.media.mediaText).matches) continue;
          walk(rule.cssRules, href);
        } else if (rule.selectorText && props.some((p) => rule.style.getPropertyValue(p))) rules.push({ rule, href });
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules, sheet.href || null); } catch { /* cross-origin sheet: not readable */ }
    }
    return selectors.map((selector) => {
      let el = null;
      try { el = selector ? document.querySelector(selector) : null; } catch { /* invalid selector */ }
      if (!el) return null;
      const found = [];
      rules.forEach(({ rule, href }, order) => {
        for (const part of parts(rule.selectorText)) {
          let hit = false;
          try { hit = el.matches(part); } catch { /* pseudo-element or unsupported */ }
          if (!hit) continue;
          found.push({ selectorText: part, href, spec: specificity(part), order, props: props.filter((p) => rule.style.getPropertyValue(p)) });
        }
      });
      found.sort((a, b) => b.spec - a.spec || b.order - a.order); // cascade order: the winner first
      if (!found.length) {
        let anc = el.parentElement;
        for (let depth = 0; anc && depth < 5; depth += 1, anc = anc.parentElement) {
          rules.forEach(({ rule, href }, order) => {
            const own = inheritable.filter((p) => props.includes(p) && rule.style.getPropertyValue(p));
            if (!own.length) return;
            for (const part of parts(rule.selectorText)) {
              let hit = false;
              try { hit = anc.matches(part); } catch { /* pseudo-element or unsupported */ }
              if (hit) found.push({ selectorText: part, href, spec: specificity(part) - depth * 1e-3, order, props: own, inherited: true });
            }
          });
          if (found.length) break;
        }
        found.sort((a, b) => b.spec - a.spec || b.order - a.order);
      }
      if (!found.length) return null;
      // external: the sheet is served from another origin (vendor/CDN), so no project file owns the size.
      const out = (c) => ({ selectorText: c.selectorText, href: c.href, external: !!c.href && new URL(c.href, location.href).origin !== location.origin, props: c.props, ...(c.inherited ? { inherited: true } : {}) });
      return { ...out(found[0]), candidates: found.slice(0, 8).map(out) };
    });
  }, { selectors, props, inheritable: INHERITED_PROPS });
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

const declOf = (props) => new RegExp(`(?:^|[{;\\s])(?:${props.join('|')})\\s*:`, 'i');

/** `file:line` of the one source CSS rule that declares a size property and whose selector list contains `selectorText`; null when absent or ambiguous. */
export function locateCssRule(root, selectorText, { globs = ['src/**/*.css'], props = SIZE_PROPS } = {}) {
  const SIZE_DECL = declOf(props);
  const want = squash(selectorText);
  if (!want) return null;
  const files = fg.sync(globs, { cwd: root, ignore: ['**/node_modules/**', '**/+.css'] }).sort();
  const hits = [];
  for (const file of files) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A rule head: selector list at the start of the line, ending in `{` or `,` (the list may continue on the next line).
      const m = /^\s*([^{}@/][^{}]*?)\s*([{,])\s*$/.exec(line) || /^\s*([^{}@/][^{}]*?)\s*\{/.exec(line);
      if (!m || !squash(m[1]).split(/\s*,\s*/).includes(want)) return;
      const rest = lines.slice(i).join('\n');
      const body = rest.slice(rest.indexOf('{') + 1, rest.indexOf('}'));
      // A same-selector rule that only sets colour etc. does not own the size.
      if (SIZE_DECL.test(`{${body}`)) hits.push({ file, line: i + 1 });
    });
  }
  return hits.length === 1 ? hits[0] : null;
}

const GENERATED_PATH = /(^|\/)(reset|resets|normalize|synced|vendor|vendors|generated|third-party)([-._/]|$)/i;
const GENERATED_HEADER = /generated|synced from|do not edit|don'?t edit|auto-?generated/i;
/**
 * True for a file nobody authors by hand: its path or its first lines say it is a reset, vendored or generated. A bundle whose
 * header only says it was synced from the platform (`Synced from Paradox platform - do not edit manually`) is the stylesheet the
 * project keeps and pushes back, so it is a place to fix (a generated or synced-named path stays excluded).
 */
export function isGeneratedCss(root, file) {
  if (GENERATED_PATH.test(file)) return true;
  try {
    const head = readFileSync(path.join(root, file), 'utf8').split('\n').slice(0, 3).join('\n');
    if (/synced from/i.test(head) && !/generated/i.test(head)) return false;
    return GENERATED_HEADER.test(head);
  } catch { return false; }
}

/** 0-based line indexes that sit inside a <script> block of a template. */
function scriptLines(lines) {
  const inside = new Set();
  let open = false;
  lines.forEach((line, i) => {
    if (/<script\b/i.test(line)) open = true;
    if (open) inside.add(i);
    if (/<\/script\s*>/i.test(line)) open = false;
  });
  return inside;
}

/** A size is declared by CSS, so a finding on a JavaScript line (inline <script> or a .js file) is moved to the element's markup, else its line is dropped. */
function offScript(v, root) {
  const file = v.source?.file;
  if (!file || !v.source.line) return;
  const js = /\.m?js$/.test(file);
  let lines = [];
  try { lines = readFileSync(path.join(root, file), 'utf8').split('\n'); } catch { if (!js) return; }
  if (!js && !scriptLines(lines).has(v.source.line - 1)) return;
  const inScript = js ? new Set(lines.map((_, i) => i)) : scriptLines(lines);
  const classes = ((v.element?.outerHTML || '').match(/class="([^"]+)"/)?.[1] || '').split(/\s+/).filter((c) => c.length > 3 && !c.includes(':'));
  const at = js ? -1 : lines.findIndex((l, i) => !inScript.has(i) && /class\s*=/.test(l) && classes.some((c) => l.includes(c)));
  v.source = { ...v.source, markupLine: undefined, line: at >= 0 ? at + 1 : null, confidence: 'low', method: at >= 0 ? 'source-hint-search' : v.source.method, preimageSha256: null, preimageRange: null };
  if (at >= 0) { const pre = computeSourcePreimage(file, at + 1, root); v.source.preimageSha256 = pre?.preimageSha256 || null; v.source.preimageRange = pre?.range || null; }
}

/** Located, non-external candidates of a collected rule: `{ file, line, selectorText, generated, inherited }`, cascade winner first. */
export function locateCandidates(rule, root, props = SIZE_PROPS) {
  return (rule && !rule.external ? (rule.candidates?.length ? rule.candidates : [rule]) : []).filter((c) => !c.external).flatMap((c) => {
    const hit = locateCssRule(root, c.selectorText, { props });
    return hit && existsSync(path.join(root, hit.file)) ? [{ ...hit, selectorText: c.selectorText, generated: isGeneratedCss(root, hit.file), inherited: Boolean(c.inherited), props: c.props || [] }] : [];
  });
}

/**
 * Authored CSS rules that declare `props` for the element matching `selector`, read from the live `page` and located in the project's
 * CSS under `root`. The one entry point for any producer of size findings (axe, lighthouse, a tool-owned measurement): hand it the
 * selector of the failing element. Generated files are returned flagged, never as the first choice.
 * @returns {Promise<{ file: string, line: number, selectorText: string, generated: boolean, inherited: boolean }[]>}
 */
export async function authoredCssCandidates(page, root, selector, props = SIZE_PROPS) {
  const [rule] = await collectCssRules(page, [selector], props);
  return locateCandidates(rule, root, props).sort((a, b) => Number(a.generated) - Number(b.generated));
}

/**
 * A size or colour finding always carries a line. A template file with no line first looks for the element in the page's render tree (same tag,
 * same authored href or text, one place only), else takes its tag line in that file (class match, else the first tag of that name, else the first tag).
 */
export function ensureSourceLine(violations, root) {
  for (const v of violations) {
    const file = v.source?.file;
    if (!file || v.source.line || !/\.liquid$/.test(file) || !(isSizeRule(v.ruleId || v.rule) || /color-contrast/i.test(v.ruleId || v.rule || ''))) continue;
    const html = v.element?.outerHTML || '';
    const tagName = /^\s*<([a-z][\w-]*)/i.exec(html)?.[1]?.toLowerCase();
    const href = /\shref="([^"]+)"/.exec(html)?.[1];
    const text = />([^<]+)</.exec(html)?.[1]?.trim();
    const classes = (/class="([^"]+)"/.exec(html)?.[1] || '').split(/\s+/).filter((c) => c.length > 3 && !c.includes(':'));
    const inTree = (href || text) ? collectRenderTree(file, undefined, root).flatMap((f) => buildTagIndex(f, root)
      .filter((t) => t.tagName === tagName && (href ? t.staticAttrs.href === href : t.text === text) && (!text || !t.text || t.text === text))
      .map((t) => ({ file: f, tag: t }))) : [];
    let at = inTree.length === 1 ? inTree[0] : null;
    if (!at) {
      const tags = buildTagIndex(file, root);
      const tag = tags.find((t) => t.tagName === tagName && classes.some((c) => t.classTokens.includes(c))) || tags.find((t) => t.tagName === tagName) || tags[0];
      at = tag ? { file, tag } : null;
    }
    if (!at) continue;
    const pre = computeSourcePreimage(at.file, at.tag.line, root);
    v.source = { ...v.source, file: at.file, line: at.tag.line, confidence: 'low', partial: at.file.startsWith('src/partials/') ? at.file : v.source.partial, preimageSha256: pre?.preimageSha256 || null, preimageRange: pre?.range || null };
  }
}

/** Re-points size findings at the authored CSS rule declaring the size; the markup location stays in `source.markupFile/markupLine`. */
export function applyCssOrigins(violations, root) {
  for (const v of violations) {
    const rule = v.cssRule;
    delete v.cssRule;
    if (!v.source) continue;
    const located = locateCandidates(rule, root);
    // A rule that sets one of the element's own box properties (line-height, padding, min-height, height, width, margin, gap) decides the failing dimension.
    // A rule that only sets font-size, or anything inherited from an ancestor, is a generic lead: a candidate, never the primary place.
    const weak = (c) => c.inherited || (c.props?.length > 0 && c.props.every((p) => p === 'font-size'));
    const chosen = located.find((c) => !c.generated && !weak(c));
    const others = located.filter((c) => c !== chosen && !c.generated);
    if (others.length) v.sourceCandidates = others.map((c) => ({ file: c.file, line: c.line, confidence: 'low', method: weak(c) ? 'css-rule-inherited' : 'css-rule-candidate' }));
    if (!chosen) {
      if (others.length && v.source.file && v.source.file !== 'unknown') v.source = { ...v.source, note: 'size comes from inherited font-size/line-height' };
      if (isSizeRule(v.ruleId)) offScript(v, root);
      continue;
    }
    const preimage = computeSourcePreimage(chosen.file, chosen.line, root);
    v.source = {
      ...v.source,
      markupFile: v.source.file && v.source.file !== 'unknown' ? v.source.file : undefined,
      markupLine: v.source.line || undefined,
      file: chosen.file,
      line: chosen.line,
      confidence: 'medium',
      method: 'css-rule',
      cssSelector: chosen.selectorText,
      partial: undefined,
      preimageSha256: preimage?.preimageSha256 || null,
      preimageRange: preimage?.range || null,
    };
  }
}
