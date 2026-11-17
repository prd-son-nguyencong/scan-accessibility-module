import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isLoopbackUrl } from '../utils/host-classify.js';

// A template string the Paradox runtime translates or binds (`_translate("...")`, `{{...}}`) is not text until the platform resolves it. A local
// render that still holds the wrapper proves nothing about what a user reads, so a label-in-name finding built on it is a question (needs-review).
const UNBOUND_REASON_TEXT = 'platform data not bound in local render';
export const UNRESOLVED_REASON = 'text not resolved in local render';
export const UNRESOLVED_TEXT = /_translate\s*\(|\{\{|\}\}|%7B%7B|&#123;&#123;/i;
const LABEL_RULES = new Set(['label-content-name-mismatch', 'VisibleTextPartOfAccessibleName', 'label-in-name']);

const entityDecoded = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** The strings a label-in-name judgement used: the measured label and name, plus the element's own aria-label / title / alt and its text. */
function judgedStrings(v) {
  const ev = v.evidence || {};
  const html = v.element?.outerHTML || v.element?.html || v.html || '';
  const attrs = [...String(html).matchAll(/\s(?:aria-label|title|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]);
  const text = String(html).replace(/<[^>]*>/g, ' ');
  const measured = (ev.measured || []).flatMap((m) => [m.label, m.name]);
  return [ev.visibleText, ev.accessibleName, ...measured, ...attrs, text].filter((s) => typeof s === 'string').map(entityDecoded);
}

export const hasUnresolvedText = (v) => judgedStrings(v).some((s) => UNRESOLVED_TEXT.test(s));

/** Caps a row at needs-review with a reason; the old proof no longer holds. */
function capNeedsReview(v, reason) {
  v.verdict = 'needs-review';
  v.reason = reason;
  v.evidence = { ...(v.evidence || {}), reviewReason: reason };
  if (v.evidence.proof) delete v.evidence.proof;
}

/** Caps label-in-name rows built on unresolved wrapper text at needs-review. Returns the number of rows capped. */
export function applyUnresolvedText(violations) {
  let n = 0;
  for (const v of violations) {
    if (!LABEL_RULES.has(v.ruleId || v.rule || v.id) || !hasUnresolvedText(v)) continue;
    capNeedsReview(v, UNRESOLVED_REASON);
    n++;
  }
  return n;
}

// Raw Liquid in a text node: a partial that was rendered as text, not a backend tag ({{data:..}} and friends are the platform's).
const LIQUID_LEAK = /\{%-?[\s\S]*?-?%\}|\{\{(?!\s*(?:component|snippet|data|attribute)\s*:)[\s\S]*?\}\}/;

/** Live page: the first visible-text node holding raw Liquid (trimmed, 80 characters), else null. */
export function probeLiquidLeak(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA']);
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (skip.has(n.parentElement?.tagName) || !re.test(n.nodeValue)) continue;
      return n.nodeValue.trim().replace(/\s+/g, ' ').slice(0, 80);
    }
    return null;
  }, LIQUID_LEAK.source).catch(() => null);
}

const REGION = 'section, header, footer, nav, aside, article, form, [role=region], [role=banner], [role=contentinfo], [role=navigation]';

/**
 * Of the given selectors, those whose element shares a layout region with a raw Liquid text node: the leak sits inside the element or inside
 * its closest section-level container (a leak elsewhere on the page cannot move the element's backdrop). An unresolvable selector counts as near.
 */
export function leakNearSelectors(page, selectors) {
  return page.evaluate(([src, sels, region]) => {
    const re = new RegExp(src);
    const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA']);
    const leaks = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!skip.has(n.parentElement?.tagName) && re.test(n.nodeValue)) leaks.push(n);
    const regionOf = (el) => el.closest(region) || [...(function* () { for (let e = el; e && e !== document.body; e = e.parentElement) if (e.parentElement === document.body || e.parentElement?.tagName === 'MAIN') yield e; })()][0] || el;
    return sels.filter((sel) => {
      let el = null;
      try { el = document.querySelector(sel); } catch { /* unresolvable */ }
      if (!el) return true;
      const scope = regionOf(el);
      return leaks.some((n) => scope.contains(n));
    });
  }, [LIQUID_LEAK.source, [...new Set(selectors)], REGION]).catch(() => selectors);
}

const HEADING_EMPTY_RULES = new Set(['empty-heading', 'heading-empty']);
export const ARTEFACT_PREFIX = 'local render artefact';

/** True when the template's own heading for this row is a `_translate("...")` token, which the local dev translator renders blank. */
function emptyIsTranslateToken(v, root) {
  const file = v.source?.file;
  const tag = /^\s*<(h[1-6])\b/i.exec(v.element?.outerHTML || '')?.[1]?.toLowerCase();
  if (!root || !file || !tag) return false;
  const full = path.resolve(root, file);
  if (!full.startsWith(path.resolve(root) + path.sep)) return false;
  let src;
  try { src = readFileSync(full, 'utf8'); } catch { return false; }
  const els = [...src.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => ({
    line: src.slice(0, m.index).split('\n').length, token: /^\s*_translate\s*\(/.test(m[1]), empty: !m[1].trim(),
  }));
  const line = Number(v.source?.line) || 0;
  if (line) return els.some((e) => e.line === line && e.token);
  // No line: only when the file's heading of this level is a token and none is a literal empty heading.
  return els.some((e) => e.token) && !els.some((e) => e.empty);
}

/**
 * Findings that only exist because of how the local render differs from the platform become needs-review "local render artefact: ...":
 * pixel-measured contrast where raw Liquid text leaked into the element's own layout region (it moves the backdrop; `leakNear` scopes it, absent means page-wide), and an empty heading whose template
 * holds a `_translate("...")` token. A solid-background contrast row, a literal empty heading and a clean page are untouched.
 */
export function applyRenderArtefacts(violations, { liquidLeak = null, root = null, leakNear = null } = {}) {
  let n = 0;
  for (const v of violations) {
    const rule = v.ruleId || v.rule || v.id;
    let reason = null;
    if (liquidLeak && /color-contrast/i.test(rule || '') && v.evidence?.pixelContrast && (!leakNear || leakNear.has(v.element?.selector))) {
      reason = `${ARTEFACT_PREFIX}: raw Liquid text in the body ("${liquidLeak}") moves the layout, so the measured backdrop is not the platform's`;
    } else if (HEADING_EMPTY_RULES.has(rule) && emptyIsTranslateToken(v, root)) {
      reason = `${ARTEFACT_PREFIX}: the heading is a platform translate token (_translate) that renders blank locally`;
    }
    if (!reason) continue;
    capNeedsReview(v, reason);
    n++;
  }
  return n;
}

// Environment artefacts of the local render: a link whose href is a template binding the dev render never resolved, and an asset under a
// gitignored folder (public/) that the platform hosts. Neither says anything about what the platform serves.
const BARE_BINDING = /^[A-Za-z_][\w-]*(?:\.[\w-]+)+$/;
const LABEL_OR_CONTRAST = /^(?:label-content-name-mismatch|VisibleTextPartOfAccessibleName|label-in-name)$|color-contrast/i;
const LINK_LAYERS = new Set(['links', 'htmlValidate', 'w3c']);
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const PLATFORM_ASSET_REASON = 'platform-hosted-asset';

const attrOf = (html, tag, name) => {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(String(html || ''))?.[0] || '';
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(open);
  return m ? entityDecoded(m[1] ?? m[2]).trim() : null;
};

/** Why the row's anchor href is not a real value: an unrendered tag, or a bare dotted path that the template at the traced line prints as `{{ path }}`. */
function unboundHrefReason(v, root) {
  const html = v.element?.outerHTML || v.element?.html || '';
  const href = /^\s*<(?:a|area|link)\b/i.test(html) ? attrOf(html, '[a-z]+', 'href') : null;
  if (!href) return null;
  if (/\{\{|\{%|%7B%7B/i.test(href)) return `href "${href}" is an unrendered template tag`;
  const file = v.source?.file;
  if (!BARE_BINDING.test(href) || !root || !file || file === 'unknown') return null;
  const full = path.resolve(root, file);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  let lines;
  try { lines = readFileSync(full, 'utf8').split(/\r?\n/); } catch { return null; }
  const line = Number(v.source?.line) || 0;
  const window = (line ? lines.slice(Math.max(0, line - 7), line + 6) : lines).join('\n');
  return new RegExp(`\\{\\{-?\\s*${reEsc(href)}\\s*(?:\\||-?\\}\\})`).test(window) ? `href "${href}" is the template output {{ ${href} }}, a binding the local render did not resolve` : null;
}

const ignoreCache = new Map();
/** Root-relative asset path that is absent from the project and sits under a gitignored path (git repos only; null when unknown). */
function ignoredAsset(urlPath, root) {
  if (!root || !urlPath?.startsWith('/') || urlPath.includes('..')) return false;
  let rel;
  try { rel = decodeURIComponent(urlPath.split(/[?#]/)[0]).replace(/^\/+/, ''); } catch { return false; }
  if (!rel) return false;
  const key = `${root}\0${rel}`;
  if (ignoreCache.has(key)) return ignoreCache.get(key);
  const cands = [`public/${rel}`, rel];
  let hit = false;
  if (!cands.some((c) => existsSync(path.join(root, c)))) {
    hit = cands.some((c) => {
      const dirs = c.split('/').slice(0, -1).map((_, i, a) => `${a.slice(0, i + 1).join('/')}/`);
      return [c, ...dirs].some((p) => spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', p], { stdio: 'ignore' }).status === 0);
    });
  }
  ignoreCache.set(key, hit);
  return hit;
}

const pathOf = (u) => { try { const x = new URL(u, 'http://x.invalid'); return x.pathname; } catch { return null; } };

/**
 * Local-environment artefacts become needs-review (never confirmed):
 * - a link row whose href is an unbound template binding ({{ x }} residue, or a dotted path the template prints at the traced line): site-owned unbound-data;
 * - a 404 on an embedded asset (img, source, script, ...; never an <a>, whose dead page is a real defect) under a gitignored, absent path (platform-hosted): owner platform;
 * - a label-in-name or contrast row whose visible text is the alt of such a broken image.
 * Returns the number of rows changed.
 */
export function applyEnvironmentArtefacts(violations, { root = null } = {}) {
  let n = 0;
  for (const v of violations) {
    const rule = v.ruleId || v.rule || v.id;
    let reason = null;
    if (LINK_LAYERS.has(v.layer) && (reason = unboundHrefReason(v, root))) {
      reason = `${ARTEFACT_PREFIX}: ${reason}`;
      v.origin = { owner: 'site', kind: 'unbound-data', label: 'Site source: platform data not bound in local render', evidence: [reason, UNBOUND_REASON_TEXT] };
    } else if (v.layer === 'links' && rule === 'dead-link-404' && !/^\s*<(?:a|area)\b/i.test(v.element?.outerHTML || '') && v.linkTarget?.url && isLoopbackUrl(v.linkTarget.url) && ignoredAsset(pathOf(v.linkTarget.url), root)) {
      reason = `${ARTEFACT_PREFIX}: ${pathOf(v.linkTarget.url)} is under a gitignored path (platform-hosted asset), absent from the local render only`;
      v.origin = { owner: 'platform', kind: 'platform-component', label: 'Platform-hosted asset (gitignored in the project)', evidence: [reason] };
      v.linkTarget.reason = PLATFORM_ASSET_REASON;
    } else if (LABEL_OR_CONTRAST.test(rule || '')) {
      const html = v.element?.outerHTML || v.element?.html || v.html || '';
      const text = (v.evidence?.visibleText ?? '').trim();
      const broken = [...String(html).matchAll(/<img\b[^>]*>/gi)].find((m) => {
        const src = attrOf(m[0], 'img', 'src');
        const alt = attrOf(m[0], 'img', 'alt');
        return src?.startsWith('/') && !src.startsWith('//') && ignoredAsset(src, root) && (/color-contrast/i.test(rule) ? !String(html).replace(/<[^>]*>/g, '').trim() : alt && alt === text);
      });
      if (!broken) continue;
      reason = `${ARTEFACT_PREFIX}: the visible text is the alt of an image under a gitignored path (platform-hosted) that does not load locally`;
    }
    if (!reason) continue;
    if (v.layer === 'links') v.kind = 'heuristic';
    capNeedsReview(v, reason);
    n++;
  }
  return n;
}
