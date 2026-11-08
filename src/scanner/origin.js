import { classifyOrigin, vendorOverlayOrigin } from '../tracer/ownership.js';
import { IMPACT_ORDER } from '../schema.js';
import { globToRegExp } from './links.js';
import { canonicalizeRuleId } from '../reporter/rule-aliases.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SITE_FIX_NOTE } from '../tracer/site-fix.js';
import { withTimeout } from '../utils/with-timeout.js';

const MAX_CHAIN = 40;
const PROBE_TIMEOUT_MS = 20_000;

// Runs in the page. Per selector: the element's path to <html> (tag + attributes, nearest first) and whether the served HTML holds it.
function probeInPage({ selectors, servedHtml, maxChain }) {
  const served = servedHtml ? new DOMParser().parseFromString(servedHtml, 'text/html') : null;
  // true: the served HTML has it; false: it does not; null: cannot tell (no id, class or text to compare).
  const inServed = (el) => {
    if (!served) return null;
    const tag = el.localName;
    if (tag === 'html' || tag === 'head' || tag === 'body') return true;
    const same = [...served.getElementsByTagName(tag)];
    if (tag === 'script') {
      const src = el.getAttribute('src');
      if (src) return same.some((s) => s.getAttribute('src') === src);
      const text = (el.textContent || '').trim();
      return text ? same.some((s) => (s.textContent || '').trim() === text) : null;
    }
    const classes = [...el.classList];
    if (el.id) return served.getElementById(el.id) ? true : false;
    if (!classes.length) return null;
    // A class alone is weak (btn, wrap): the same class set on a served element proves it; a class no served element of this tag has
    // means a script added the node (or toggled a state class: the finding then stays site-owned injected-runtime, never third-party without a vendor match).
    const key = (list) => [...list].sort().join(' ');
    if (same.some((s) => key(s.classList) === key(classes))) return true;
    const known = new Set(same.flatMap((s) => [...s.classList]));
    return classes.every((c) => known.has(c)) ? null : false;
  };
  const out = {};
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (!el) continue;
      const chain = [];
      let injectedRoot = null;
      let servedSelf = null;
      let stop = false;
      for (let n = el, i = 0; n && n.nodeType === 1 && i < maxChain; n = n.parentElement, i++) {
        chain.push({ tag: n.localName, attrs: Object.fromEntries([...n.attributes].map((a) => [a.name, a.value.slice(0, 300)])) });
        if (stop) continue;
        const st = inServed(n);
        if (i === 0) servedSelf = st;
        if (st === true) stop = true;
        else if (st === false) injectedRoot = i;
      }
      const refs = ['aria-labelledby', 'aria-describedby'].flatMap((a) => (el.getAttribute(a) || '').split(/\s+/).filter(Boolean)).map((id) => {
        const t = document.getElementById(id);
        return t ? { id, open: t.outerHTML.match(/^<[^>]*>/)[0], empty: !(t.textContent || '').trim() && !t.querySelector('img[alt]:not([alt=""])') } : null;
      }).filter(Boolean);
      const text = (n) => (n.textContent || '').slice(0, 2000);
      const ownText = [...el.childNodes].filter((c) => c.nodeType === 3).map(text).join(' ');
      out[selector] = { ownText, subtreeText: text(el), refs, chain, servedSelf, injectedRoot, pageOrigin: location.origin };
    } catch { /* selector the DOM rejects: left to the offline classifier */ }
  }
  return out;
}

/**
 * Sets `origin` on every violation (all layers): who owns the element, from the live DOM (path to <html>, served-HTML comparison) when
 * its selector resolves, else from its markup and selector. Non-site findings never keep an impact above `foreignImpactCap`
 * (default moderate; null/false lifts it). Best effort: a page that is gone leaves the offline classification.
 */
export async function annotateOrigins(page, violations, { vendors, servedHtml = null, foreignImpactCap = 'moderate', probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const selectors = [...new Set(violations.map((v) => v.element?.selector).filter(Boolean))];
  // null: the probe did not run or did not finish (closed page, hung renderer): every selector finding is then "probe failed", never silently site-owned.
  let probes = {};
  if (page && selectors.length) {
    probes = await withTimeout(page.evaluate(probeInPage, { selectors, servedHtml, maxChain: MAX_CHAIN }), probeTimeoutMs, 'origin probe').catch(() => null);
  }
  const cap = IMPACT_ORDER.indexOf(foreignImpactCap);
  for (const v of violations) {
    const el = { ruleId: v.ruleId || v.rule || v.id, outerHTML: v.element?.outerHTML, selector: v.element?.selector, ownership: v.ownership, platformOwned: v.platformOwned };
    const hints = probes?.[v.element?.selector] || null;
    // A selector the live DOM no longer resolves (a banner dismissed by a later layer) or a probe that failed is not evidence of site ownership.
    // Nodes inside frames/shadow roots are not resolvable by document.querySelector by design and keep the offline classification.
    // Link findings are about a URL (a crawl-found broken link has a synthetic selector): their ownership never rested on the node.
    const probeFailed = Boolean(page && (v.element?.selector || v.element?.outerHTML) && !hints && v.layer !== 'links' && !v.element.framePath?.length && !v.element.shadowPath?.length);
    // A focus-obscured finding belongs to whoever owns the covering element: a vendor banner is not the site's code, whichever link it covers.
    const overlay = vendorOverlayOrigin(v.evidence?.obscuringChain, vendors);
    v.origin = overlay || classifyOrigin(el, { vendors, hints, probeFailed, servedHtml });
    if (overlay) v.siteFix = { note: SITE_FIX_NOTE, candidate: null }; // the cover is the vendor's; the site still has a mitigation (resolved after tracing)
    if (v.evidence?.obscuringChain) delete v.evidence.obscuringChain;
    const rank = IMPACT_ORDER.indexOf(v.impact);
    if (v.origin.owner !== 'site' && cap >= 0 && rank >= 0 && rank < cap) v.impact = foreignImpactCap;
  }
  return violations;
}

// Page-structure rules an error/stub page lacks by design (layout partials only, no <main>, no heading).
const PAGE_STRUCTURE_RULES = new Set(['missing-main-landmark', 'landmark-one-main', 'missing-h1', 'page-has-heading-one', 'no-headings', 'region',
  'skip-link', 'skip-link-target-missing', 'skip-link-missing', 'bypass', // a skip link targets the <main> an error page lacks
  'FocusNotObscuredHeader', 'FocusNotObscuredFooter', 'StickyHeaderObscuresFocus']); // native id of the header rule (the report aliases it to FocusNotObscuredHeader); a stub page is shorter than the viewport: its footer sits under the fixed header
export const ERROR_PAGE_NOTE = 'error/stub page';
export const EMPTY_SHELL_NOTE = 'empty template shell';
// A link on a status page (a language switch that mirrors the failed path onto another host) is expected to lead to an error too.
const STATUS_LINK_RULES = new Set(['dead-link-404', 'dead-link-server-error', 'dead-link-unreachable', 'broken-link']);
export const ERROR_PAGE_LINK_REASON = 'link on an error page mirrors the failed path';

/**
 * On a route matching `errorPages` (globs; the default config names /404, /500 and /job-details), or a bare layout shell (`opts.bareShell`: an empty page template, or see liveShellProbe),
 * page-structure findings are needs-review, never confirmed; real defects stay as they are.
 */
export function downgradeErrorPage(violations, pageUrl, errorPages = [], { bareShell = false } = {}) {
  let route;
  try { route = new URL(pageUrl).pathname.replace(/\/+$/, '') || '/'; } catch { return violations; }
  const byRoute = errorPages.some((g) => globToRegExp(g.replace(/(.)\/+$/, '$1')).test(route));
  if (!bareShell && !byRoute) return violations;
  const note = byRoute ? ERROR_PAGE_NOTE : EMPTY_SHELL_NOTE;
  for (const v of violations) {
    const rule = v.ruleId || v.rule || v.id;
    if (STATUS_LINK_RULES.has(rule) && v.layer === 'links') {
      if (!byRoute || route === '/job-details') continue; // only a real status page mirrors a failed path; a shell or the job page has real links
      v.verdict = 'needs-review'; v.kind = 'heuristic'; v.reason = ERROR_PAGE_LINK_REASON;
      if (v.linkTarget) v.linkTarget.reason = ERROR_PAGE_LINK_REASON;
      continue;
    }
    if (!PAGE_STRUCTURE_RULES.has(rule) && !PAGE_STRUCTURE_RULES.has(canonicalizeRuleId(rule))) continue;
    v.verdict = 'needs-review';
    v.fix = { ...v.fix, hint: `${v.fix?.hint || v.description || ''} (${note}: no main landmark or heading is expected)`.trim() };
  }
  return violations;
}

// The template that serves `route` (<pages>/<route>.liquid or <route>/index.liquid) has no body: only layout/block/comment tags.
export function isEmptyPageTemplate(pagesDir, pageUrl) {
  let route;
  try { route = decodeURIComponent(new URL(pageUrl).pathname).replace(/^\/+|\/+$/g, ''); } catch { return false; }
  if (route.split('/').includes('..')) return false;
  const file = [`${route || 'index'}.liquid`, path.join(route, 'index.liquid')].map((f) => path.join(pagesDir, f)).find((f) => existsSync(f));
  if (!file) return false;
  const body = readFileSync(file, 'utf8').replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}|<!--[\s\S]*?-->|\{%-?\s*(?:layout|extends|block|endblock)\b[^%]*-?%\}/gi, '');
  return !body.trim();
}

// Runs in the page: no <main>, no heading and (outside header/footer/nav chrome) almost no text: only the layout chrome rendered.
export function liveShellProbe(maxText = 80) {
  if (document.querySelector('main, [role="main"], h1, h2, h3, h4, h5, h6, [role="heading"]')) return false;
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('header, footer, nav, script, style, noscript, template, [role="banner"], [role="contentinfo"], [role="navigation"], [aria-hidden="true"]').forEach((n) => n.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim().length < maxText;
}

// Rules that claim "this node has no text": a live node that does have text contradicts them.
const EMPTINESS_RULES = new Set(['empty-heading', 'empty-table-header', 'link-name', 'button-name']);
const textOf = (html) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

/**
 * Evidence guard: a finding whose evidence node is empty but whose node in the live DOM holds text was judged on another snapshot of the page.
 * Dropped (returned list). Findings with no resolvable node are kept.
 */
export async function dropStaleEvidence(page, violations) {
  const probes = violations.filter((v) => EMPTINESS_RULES.has(v.ruleId || v.rule || v.id) && v.element?.selector && typeof v.element.outerHTML === 'string' && !textOf(v.element.outerHTML));
  if (!page || !probes.length) return violations;
  const live = await page.evaluate((sels) => Object.fromEntries(sels.map((s) => {
    try { const el = document.querySelector(s); return [s, el ? (el.textContent || '').trim().length > 0 : null]; } catch { return [s, null]; }
  })), [...new Set(probes.map((v) => v.element.selector))]).catch(() => ({}));
  const stale = new Set(probes.filter((v) => live[v.element.selector] === true));
  return violations.filter((v) => !stale.has(v));
}
