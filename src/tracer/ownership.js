import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseRenderedTag } from './liquid-tag-index.js';

/**
 * Who can change an element. Every finding gets `origin: { owner, kind, vendor?, label, evidence[] }`:
 *   owner site | platform | third-party; kind site-source | react-widget | platform-component | vendor-script | injected-runtime | unbound-data | unknown-probe-failed | iframe.
 * `unknown-probe-failed` (site-owned): the live probe could not resolve the node (page gone, probe timeout, node removed since the layers ran) and no vendor token proves injection offline; never confirmed.
 * `unbound-data` is site-owned markup (data-pdk-for / data-pdk-var, unresolved {{data:..}} {{component:..}} {{attribute:..}} {{snippet:..}}) whose content only exists on the platform: its findings are capped needs-review.
 * `ownership` ('source' | 'platform' | 'third-party') is the same owner under the legacy names; only `source` findings belong in a dev fix list.
 *
 * What is the site's own code: everything authored in its source, PDK included (data-pdk-* attributes, {{data:..}} / {{component:..}} /
 * {{snippet:..}} tags and the Liquid around them). Those never make a node platform- or third-party-owned; a widget mount point authored
 * in a template is the site's too, only what the widget renders at run time inside it is the platform's.
 * Not the site's: a node missing from the served HTML (and any template) that a vendor from vendors.json injected (third-party), a
 * cross-origin iframe's content (third-party), Paradox-rendered widgets and chat (platform). An injected node no vendor claims stays site-owned
 * (`injected-runtime`) but is never confirmed: nothing proves the site cannot change it.
 * `el`: outerHTML, selector, plus `ownership` / `platformOwned` / `origin` when the caller already knows (e.g. a locked page).
 * `hints` (from the live-DOM probe in scanner/origin.js): { chain: [{tag, attrs}] self first, servedSelf: true|false|null, injectedRoot: index|null, servedKnown }.
 * shortcut: without a live probe only the root tag and the selector are known; page locks only come in through `el.platformOwned`.
 */
export const OWNERSHIPS = Object.freeze(['source', 'platform', 'third-party']);
export const OWNERS = Object.freeze(['site', 'platform', 'third-party']);
const OWNER_TO_OWNERSHIP = { site: 'source', platform: 'platform', 'third-party': 'third-party' };

// Markup the platform widget loader injects at run time: its host element, its own script and the recaptcha scripts.
const INJECTED = /^\s*<apply-widget\b|^\s*<script\b[^>]*\ssrc="[^"]*(?:\/static\/(?:widget\/|site\/js\/widget)|gstatic\.com\/recaptcha\/)/i;
const PLATFORM_SELECTOR = /\[data-react-component\b|#chat-widget(?![\w-])|apply-messenger-launcher(?![\w-])|#apply-widget(?![\w-])|apply-widget\b|\.ol-text-message(?![\w-])|\.el-popper(?![\w-])/;
export const PLATFORM_ANCESTOR_SELECTOR = '[data-react-component],[component_data],#chat-widget,#apply-widget,apply-widget,.apply-messenger-launcher,.ol-text-message,.el-popper';
const CATEGORY_LABEL = {
  'cookie-consent': 'Cookie consent', 'tag-manager': 'Tag manager', analytics: 'Analytics', chat: 'Chat widget',
  video: 'Video embed', captcha: 'Captcha', other: 'Third-party script',
};

const VENDORS_FILE = new URL('./vendors.json', import.meta.url);
let bundledVendors;

/** The bundled vendors.json merged with the project's `tracing.vendors` (same shape; an entry with a known id replaces it). */
export function loadVendors(extra = []) {
  bundledVendors ||= JSON.parse(readFileSync(VENDORS_FILE, 'utf8')).vendors;
  if (!extra?.length) return bundledVendors;
  const byId = new Map(bundledVendors.map((v) => [v.id, v]));
  for (const v of extra) byId.set(v.id, v);
  return [...byId.values()];
}

const compiled = new WeakMap();
function compile(vendors) {
  if (!compiled.has(vendors)) {
    const rx = (list) => (list || []).flatMap((p) => { try { return [new RegExp(p, 'i')]; } catch { return []; } });
    compiled.set(vendors, vendors.map((v) => ({
      v, src: rx(v.patterns?.src), id: rx(v.patterns?.id), class: rx(v.patterns?.class), attr: rx(v.patterns?.attr), html: rx(v.patterns?.html),
    })));
  }
  return compiled.get(vendors);
}

const escAttr = (v) => String(v).replace(/"/g, '&quot;');
const openTag = (n) => `<${n.tag}${Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}>`;

/** First vendor whose patterns match one of `nodes` ({tag, attrs}, nearest first): { vendor, evidence, url? } or null. */
export function matchVendor(nodes, vendors = loadVendors()) {
  const list = compile(vendors);
  for (const node of nodes) {
    const a = node.attrs || {};
    const html = openTag(node);
    for (const c of list) {
      const hit = (why, url, token) => ({ vendor: c.v, evidence: `${why} on <${node.tag}> matches vendor ${c.v.id}`, ...(url ? { url } : {}), ...(token ? { token } : {}) });
      // href on a/area is site navigation, not a vendor resource; only src, data-src and <link>/<script> href count
      for (const k of ['src', 'href', 'data-src']) if (a[k] && !(k === 'href' && /^(a|area)$/i.test(node.tag)) && c.src.some((r) => r.test(a[k]))) return hit(`${k} "${a[k].slice(0, 120)}"`, a[k]);
      if (a.id && c.id.some((r) => r.test(a.id))) return hit(`id "${a.id}"`, null, a.id);
      const cls = (a.class || '').split(/\s+/).filter(Boolean).find((t) => c.class.some((r) => r.test(t)));
      if (cls) return hit(`class "${cls}"`, null, cls);
      const attr = Object.keys(a).find((k) => c.attr.some((r) => r.test(k)));
      if (attr) return hit(`attribute ${attr}`);
      if (c.html.some((r) => r.test(html))) return hit('markup');
    }
  }
  return null;
}

function platformRoot(node) {
  const a = node.attrs || {};
  const cls = (a.class || '').split(/\s+/);
  if (a['data-react-component'] !== undefined) return { kind: 'react-widget', name: a['data-react-component'] || 'unnamed', why: 'data-react-component' };
  if (a.component_data !== undefined) return { kind: 'platform-component', name: 'component_data', why: 'component_data' };
  if (a.id === 'chat-widget' || a.id === 'apply-widget' || node.tag === 'apply-widget'
    || ['apply-messenger-launcher', 'ol-text-message', 'el-popper'].some((c) => cls.includes(c))) return { kind: 'platform-component', name: 'chat widget', why: 'chat widget root' };
  return null;
}

const mk = (owner, kind, label, evidence = [], vendor) => ({ owner, kind, ...(vendor ? { vendor } : {}), label, evidence });
const SITE = () => mk('site', 'site-source', 'Site source');
const platformOrigin = (root, evidence) => mk('platform', root.kind, root.kind === 'react-widget' ? `Paradox React widget: ${root.name}` : `Paradox platform component: ${root.name}`, evidence);
/** Origin of an element whose template line also holds the widget's rendered snapshot (pulled from the platform): the platform re-renders it, the template line is not where it is fixed. */
export const widgetSnapshotOrigin = (name) => platformOrigin({ kind: 'react-widget', name: name || 'unnamed' }, ['rendered snapshot of the widget on its template line (the mount tag precedes the element on that line)']);
const vendorOrigin = (hit, evidence, kind = 'vendor-script') => mk('third-party', kind, `${CATEGORY_LABEL[hit.vendor.category] || CATEGORY_LABEL.other} (${kind}: ${hit.vendor.id})`,
  [...evidence, hit.evidence, ...(hit.url ? [`script ${hit.url}`] : [])], hit.vendor.id);
/** The vendor that owns an obscuring overlay (nodes {tag, attrs}, overlay first), as a third-party origin; null when no vendor claims it. */
export function vendorOverlayOrigin(nodes, vendors = loadVendors()) {
  const hit = nodes?.length && matchVendor(nodes, vendors);
  if (!hit) return null;
  const o = vendorOrigin(hit, ['the element that covers the focused control is a vendor overlay; the fix is site CSS (scroll-padding / bottom padding) or the vendor banner configuration']);
  return { ...o, label: o.label.replace('(vendor-script', 'overlay (vendor-script') };
}
const isOrigin = (o) => o && typeof o === 'object' && OWNERS.includes(o.owner) && typeof o.kind === 'string' && typeof o.label === 'string';

function crossOriginResource(nodes, pageOrigin) {
  for (const n of nodes) {
    // Only a script or iframe is a vendor resource: an injected <a href> or <img src> pointing elsewhere is still the site's markup.
    if (n.tag !== 'script' && n.tag !== 'iframe') continue;
    const src = n.attrs?.src;
    try { if (src && pageOrigin && new URL(src, pageOrigin).origin !== pageOrigin && /^https?:/i.test(src)) return { host: new URL(src).host, src }; } catch { /* not a URL */ }
  }
  return null;
}

function fromProbe({ chain, servedSelf, injectedRoot, pageOrigin }, vendors) {
  const pi = chain.findIndex((n) => platformRoot(n));
  if (pi >= 0) {
    const root = platformRoot(chain[pi]);
    // The mount node (and any node of it the served HTML already contains) is authored in a site template; what the widget renders is the platform's.
    const authored = root.kind === 'react-widget' && (pi === 0 || servedSelf === true);
    if (!authored) return platformOrigin(root, [`inside ${root.why}${pi ? ` (ancestor ${pi} level${pi > 1 ? 's' : ''} up)` : ''}`]);
  }
  if (injectedRoot == null) return SITE();
  const sub = chain.slice(0, injectedRoot + 1);
  const rootDesc = `${sub[injectedRoot].tag}${sub[injectedRoot].attrs?.id ? `#${sub[injectedRoot].attrs.id}` : ''}`;
  const evidence = [`not in the served HTML (injected root <${rootDesc}>)`];
  const hit = matchVendor(sub, vendors);
  if (hit) return vendorOrigin(hit, evidence);
  const ext = crossOriginResource(sub, pageOrigin);
  if (ext) return mk('third-party', 'vendor-script', `Third-party script resource (vendor-script: ${ext.host})`, [...evidence, `script ${ext.src}`], ext.host);
  return mk('site', 'injected-runtime', 'Runtime-injected DOM (injecting script unknown)', [...evidence, 'no vendor pattern matched']);
}

/** The origin of a finding's element. `opts.hints` come from the live-DOM probe; `opts.vendors` from loadVendors(config.tracing.vendors). `el.rule` (ruleId|rule|id) scopes the unbound-data cap. */
export function classifyOrigin(el = {}, opts = {}) {
  const o = baseOrigin(el, opts);
  if (o.owner !== 'site' || !['site-source', 'injected-runtime', 'unknown-probe-failed'].includes(o.kind)) return o;
  const rule = el.ruleId || el.rule || el.id;
  const why = unboundMarker(el.outerHTML, opts.hints?.chain, rule, opts.hints?.refs, opts.hints) || servedHeadBound(el, rule, opts.servedHtml);
  return why ? mk('site', 'unbound-data', 'Site source: platform data not bound in local render', [why, UNBOUND_REASON]) : o;
}

export const UNBOUND_REASON = 'platform data not bound in local render';
// A PDK loop/variable or a backend tag the local build left as-is: the markup is the site's, its content only exists on the platform.
const UNBOUND_TAG = /\{\{\s*(?:data|component|attribute|snippet):[^}]*\}\}|\{%-?[^%]*\b(?:data|attribute|component|snippet):[^%]*%\}/i;
const UNBOUND_ATTR = /(?:^|\s)data-pdk-(?:for|var)(?=[\s=>/]|$)/i;
// Rules whose verdict depends on what the platform binds (emptiness, accessible name, contrast). Any other rule (html-has-lang, image-alt on a
// literal <img>, landmark-unique, aria-allowed-role ...) judges static markup and keeps its verdict inside a loop or a container with a bound child.
const BOUND_CONTENT_RULES = new Set([
  'empty-heading', 'empty-table-header', 'link-name', 'button-name', 'color-contrast', 'color-contrast-enhanced', 'input-button-name', 'label',
  'ListEmpty', 'list', 'listitem', 'aria-required-children', 'aria-required-parent', 'dead-link-empty-href', 'identical-links-same-purpose', 'link-in-text-block',
]);
// Rules about a node's children: a bound tag anywhere inside the node (an empty <ul> whose <li> is a loop) is relevant.
const CHILD_CONTENT_RULES = new Set(['ListEmpty', 'list', 'aria-required-children']);
const openOf = (html) => (html ? html.match(/^\s*<[^>]*>/)?.[0] || '' : '');
// The node's own text: its markup minus the opening/closing tag and minus descendant elements.
function ownText(html) {
  let s = (html || '').replace(/^\s*<[^>]*>/, '').replace(/<\/[^>]+>\s*$/, '');
  for (let prev; prev !== s;) { prev = s; s = s.replace(/<([a-z][\w-]*)\b[^>]*>[^<]*<\/\1\s*>/gi, ''); }
  return s.replace(/<[^>]*>/g, '');
}
// A PDK attribute that outputs content at runtime (data-pdk-out, -render, -bind, -param-*): its text/href is filled by the platform.
// Others (-click, -src, -lazy, -bind, -if ...) only wire behaviour; the node's name, alt and label are still the site's own markup.
const PDK_BIND = /(?:^|\s)data-pdk-(?:out|render|bind|param-[\w-]+)(?=[\s=>/]|$)/i;
const PLACEHOLDER_HREF = /(?:^|\s)href\s*=\s*(?:"(?:#?)"|'(?:#?)'|#)(?=[\s>/]|$)/i;
const VOID = /^\s*<(?:img|input|br|hr|meta|link|area|base|col|embed|source|track|wbr)\b/i;
// A PDK-bound node whose bound content is missing in the render: no text (and no labelled image), or, for the dead-link rule only, a placeholder href.
// A void element has no text to be empty.
const emptyBound = (html, rule) => !VOID.test(html) && ((rule === 'dead-link-empty-href' && PLACEHOLDER_HREF.test(openOf(html)))
  || (!/\balt\s*=\s*["'][^"']/i.test(html) && !html.replace(/<[^>]*>/g, '').trim()));
// aria-labelledby / describedby targets inside the node's own markup that are PDK-bound and empty (the name comes from data the local render lacks).
function unboundRef(html) {
  const ids = (openOf(html).match(/aria-(?:labelledby|describedby)\s*=\s*["']([^"']+)["']/gi) || []).flatMap((m) => m.replace(/^[^=]*=\s*["']|["']$/g, '').split(/\s+/));
  for (const id of ids) {
    const m = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>[\\s\\S]*?</\\1\\s*>`, 'i').exec(html);
    if (m && (PDK_BIND.test(openOf(m[0])) || UNBOUND_TAG.test(m[0])) && emptyBound(m[0], 'empty-heading')) return id;
  }
  return null;
}
// Head metadata (<title>, <meta>, <link>, <html lang>): the live DOM holds the empty/unresolved value, the served HTML holds the backend tag the platform fills at run time.
const TITLE_RULE = /page-?title|document-title|empty-title|\btitle\b/i;
function servedHeadBound(el, rule, servedHtml) {
  if (!servedHtml) return null;
  const tag = openOf(el.outerHTML).match(/^\s*<([a-z][\w-]*)/i)?.[1]?.toLowerCase();
  const tags = (name) => servedHtml.match(new RegExp(`<${name}\\b[^>]*>${name === 'title' ? '[\\s\\S]*?</title\\s*>' : ''}`, 'gi')) || [];
  const hit = (list) => list.map((t) => UNBOUND_TAG.exec(t)?.[0]).find(Boolean);
  let found;
  if (tag === 'title' || (rule && TITLE_RULE.test(rule))) found = hit(tags('title'));
  else if (tag === 'html') found = hit(tags('html').slice(0, 1));
  else if (tag === 'meta' || tag === 'link') {
    const a = parseRenderedTag(openOf(el.outerHTML))?.attrs || {};
    const key = ['name', 'property', 'rel', 'http-equiv'].find((k) => a[k]);
    found = key && hit(tags(tag).filter((t) => new RegExp(`\\b${key}\\s*=\\s*["']?${a[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s>]`, 'i').test(t)));
  }
  return found ? `served <head> ${tag === 'title' || TITLE_RULE.test(rule || '') ? 'title' : `<${tag}>`} is the unrendered backend tag ${found}` : null;
}
/**
 * Head metadata (title, meta, link, html lang) whose own template line holds a backend tag is unbound-data, whatever the served HTML or the
 * live probe showed: the platform fills the value at run time. Decided from the source line the tracer found; a multi-line tag is read to its closing `>`.
 * Mutates `v.origin` of site-owned findings; returns the count changed.
 */
export function unboundFromSource(violations, root) {
  let n = 0;
  for (const v of violations) {
    const file = v.source?.file;
    const line = Number(v.source?.line);
    if (v.origin?.owner !== 'site' || v.origin.kind === 'unbound-data' || !file || file === 'unknown' || !(line > 0)) continue;
    const tag = openOf(v.element?.outerHTML).match(/^\s*<([a-z][\w-]*)/i)?.[1]?.toLowerCase();
    const rule = v.ruleId || v.rule || v.id;
    if (!['title', 'meta', 'link', 'html'].includes(tag) && !(tag === 'head' && TITLE_RULE.test(rule || ''))) continue;
    let text;
    try { text = readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).slice(line - 1, line + 5); } catch { continue; }
    const end = text.findIndex((l) => l.includes('>') && (tag !== 'title' || /<\/title/i.test(l)));
    const hit = UNBOUND_TAG.exec(text.slice(0, end < 0 ? 1 : end + 1).join(' '))?.[0];
    if (!hit) continue;
    v.origin = mk('site', 'unbound-data', 'Site source: platform data not bound in local render', [`source ${file}:${line} holds the backend tag ${hit}`, UNBOUND_REASON]);
    n++;
  }
  return n;
}
function unboundMarker(outerHTML, chain = [], rule, refs = [], hints = null) {
  const html = outerHTML || '';
  const open = openOf(html);
  const content = !rule || BOUND_CONTENT_RULES.has(rule); // no rule known: assume content-dependent (conservative)
  const bound = content && PDK_BIND.exec(open);
  if (bound && !UNBOUND_ATTR.test(open) && emptyBound(html, rule)) return `unrendered PDK binding ${bound[0].trim()} is empty in the node`;
  const ref = unboundRef(html) || refs.find((r) => (PDK_BIND.test(r.open || '') || UNBOUND_TAG.test(r.open || '')) && r.empty)?.id;
  if (ref) return `accessible name comes from #${ref}, whose PDK data is not bound in the local render`;
  const scoped = !content;
  const hit = UNBOUND_TAG.exec(open) || UNBOUND_ATTR.exec(open) || UNBOUND_TAG.exec(ownText(html)) || (CHILD_CONTENT_RULES.has(rule) ? UNBOUND_TAG.exec(html) || PDK_BIND.exec(html.slice(open.length)) : null);
  if (hit) return `unrendered PDK marker ${hit[0].trim()} in the node`;
  // The live probe sees what a truncated finding snippet does not: the node's own text, and a bound tag/loop anywhere below it.
  const live = UNBOUND_TAG.exec(hints?.ownText || '') || (CHILD_CONTENT_RULES.has(rule) ? UNBOUND_TAG.exec(hints?.subtreeText || '') : null);
  if (live) return `unrendered PDK marker ${live[0].trim()} in the node`;
  if (scoped) return null;
  for (const n of chain || []) {
    const a = n.attrs || {};
    const k = Object.keys(a).find((x) => /^data-pdk-(?:for|var)$/i.test(x));
    if (k) return `inside <${n.tag}> with ${k}`;
    const v = Object.values(a).find((x) => UNBOUND_TAG.test(x));
    if (v) return `inside <${n.tag}> with unrendered tag ${UNBOUND_TAG.exec(v)[0]}`;
  }
  return null;
}

const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The live probe could not resolve the node (page closed, probe timed out, the node is gone by now). Deterministic on the markup alone:
 * a vendor id/class token on the node that the served HTML never contains means a script injected it (third-party, as on every page);
 * anything else stays unknown (site-owned, never confirmed) instead of silently becoming site-source.
 */
function probeFailedOrigin(self, { vendors, servedHtml }) {
  const why = 'live DOM probe did not resolve this node';
  const hit = self && matchVendor([self], vendors);
  if (hit?.token && servedHtml && !new RegExp(`\\b(?:class|id)\\s*=\\s*["'][^"']*(?<![\\w-])${reEsc(hit.token)}(?![\\w-])`, 'i').test(servedHtml)) {
    return vendorOrigin(hit, [`not in the served HTML (${why}; compared offline)`]);
  }
  return mk('site', 'unknown-probe-failed', 'Origin unknown (live DOM probe failed)', [why, 'ownership could not be proven either way: needs review, never confirmed']);
}

function baseOrigin(el = {}, { vendors = loadVendors(), hints = null, probeFailed = false, servedHtml = null } = {}) {
  if (isOrigin(el.origin)) return el.origin;
  if (el.ownership === 'source') return SITE();
  const rendered = el.outerHTML ? parseRenderedTag(el.outerHTML) : null;
  const self = rendered ? { tag: rendered.tagName, attrs: rendered.attrs } : null;
  if (hints?.chain?.length) return fromProbe(hints, vendors);
  // An iframe's own tag is authored in source (a missing title is fixable there): only the content inside it is foreign,
  // and that arrives from the scanner as `el.ownership`.
  if (el.ownership === 'third-party') return mk('third-party', 'iframe', 'Cross-origin iframe content', ['inside a cross-origin iframe']);
  const root = (self && platformRoot(self)) || (el.ownership === 'platform' ? { kind: 'platform-component', name: 'widget', why: 'scanner-marked widget' } : null);
  if (root) return platformOrigin(root, [`root tag carries ${root.why}`]);
  if (el.platformOwned) return mk('platform', 'platform-component', 'Paradox platform page (locked)', ['platformOwned']);
  if (INJECTED.test(el.outerHTML || '')) return mk('platform', 'platform-component', 'Paradox platform component: widget loader', ['widget loader markup']);
  if (PLATFORM_SELECTOR.test(el.selector || '')) return mk('platform', 'platform-component', 'Paradox platform component: widget', ['selector under a widget root']);
  if (probeFailed) return probeFailedOrigin(self, { vendors, servedHtml });
  // shortcut: without the live probe no vendor is assigned (.cmp-hero or .cc-btn is not proof of a vendor); only the probe's not-in-served-HTML evidence is.
  return SITE();
}

/** Legacy owner names: `source` | `platform` | `third-party`. */
export function classifyOwnership(el = {}, opts) {
  return OWNER_TO_OWNERSHIP[classifyOrigin(el, opts).owner];
}

/** Why an element that is not `source` has no source file: its content is a third party's or the platform's. */
export const untraceableOwnerReason = (el) => (classifyOwnership(el) === 'third-party' ? 'third-party' : 'platform-owned');

/** What a dev should do with a finding that is not their code. */
export const suggestedAction = (origin) => (origin?.owner === 'third-party'
  ? `Report to the vendor${origin.vendor ? ` (${origin.vendor})` : ''} or adjust the consent / tag-manager (GTM) configuration that loads it; not fixable in site source.`
  : 'Report to the platform team or configure it in the Paradox platform; not fixable in site source.');
