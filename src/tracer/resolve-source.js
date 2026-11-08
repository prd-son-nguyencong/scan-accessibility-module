import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { getProjectRoot, containedPath } from '../utils/paths.js';
import { resolveProject } from '../utils/project.js';
import { findLineForTagText, findLineForHref } from './liquid-tag-index.js';

const ROOT = getProjectRoot();

// Cache of dist/*.html page contents, keyed by dist-relative path
let pageHtmlCache = null;

function distDirName() {
  return resolveProject().outDir;
}

/** dist-relative HTML path for a page URL pathname, or null when it is not built. */
function findDistPath(cache, pageUrl) {
  const out = distDirName();
  const pathname = new URL(pageUrl).pathname.replace(/\/+$/, '') || '/';
  const index = pathname === '/' ? `${out}/index.html` : `${out}${pathname}/index.html`;
  return cache[index] ? index : `${out}${pathname}.html`;
}

// Set when the instrumented build is unavailable: whatever sits in dist/ is stale or partial and must not decide an owner.
let builtOutputDisabled = false;
export const isBuiltOutputDisabled = () => builtOutputDisabled;
export function disableBuiltOutput(on = true) {
  builtOutputDisabled = Boolean(on);
  pageHtmlCache = null;
}

function loadPageHtmlCache() {
  if (pageHtmlCache) return pageHtmlCache;
  pageHtmlCache = {};
  if (builtOutputDisabled) return pageHtmlCache;
  const distDir = resolveProject().distDir;
  if (existsSync(distDir)) walkAndLoad(distDir);
  return pageHtmlCache;
}

function walkAndLoad(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndLoad(full);
    } else if (entry.name.endsWith('.html')) {
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      try { pageHtmlCache[rel] = readFileSync(full, 'utf8'); } catch { /* skip */ }
    }
  }
}

/**
 * Parse <!-- scan:begin:src/partials/X.liquid --> ... <!-- scan:end:X --> markers
 * from rendered HTML. Returns boundaries sorted by content length (innermost = smallest first),
 * so the most specific partial match wins.
 */
function parseLegacySnippetBoundaries(html) {
  const beginRe = /<!-- scan:begin:(src\/partials\/[^\s>]+\.liquid) -->/g;
  const boundaries = [];
  let m;
  while ((m = beginRe.exec(html)) !== null) {
    const srcFile = m[1];
    const contentStart = m.index + m[0].length;
    const endMarker = `<!-- scan:end:${srcFile} -->`;
    const endIdx = html.indexOf(endMarker, contentStart);
    if (endIdx < 0) continue;
    boundaries.push({
      srcFile,
      snippetId: srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, ''),
      contentStart,
      endIdx,
      length: endIdx - contentStart,
      method: 'page-html-comment',
    });
  }
  return boundaries;
}

function pdkOwnerFromTag(tag) {
  const partial = tag.match(/\bdata-pdk-partial=(["'])([^"']+)\1/i)?.[2];
  const render = tag.match(/\bdata-pdk-render=(["'])([^"']+)\1/i)?.[2];
  const name = partial || render;
  const normalizedName = name?.replace(/\\/g, '/').replace(/\.liquid$/, '');
  if (!normalizedName || normalizedName.startsWith('/') || normalizedName.split('/').includes('..')) return null;
  if (partial) {
    return {
      srcFile: `src/partials/${normalizedName}.liquid`,
      snippetId: normalizedName,
      method: 'pdk-partial-boundary',
    };
  }
  return {
    srcFile: normalizedName.startsWith('components/')
      ? `src/${normalizedName}.liquid`
      : `src/components/${normalizedName}.liquid`,
    snippetId: normalizedName,
    method: 'pdk-render-boundary',
  };
}

function parsePdkSnippetBoundaries(html) {
  const boundaries = [];
  const stack = [];
  const voidTags = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);
  const tagRe = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const rawTag = match[0];
    const tagName = match[1].toLowerCase();
    const closing = rawTag.startsWith('</');
    if (closing) {
      let openIndex = stack.length - 1;
      while (openIndex >= 0 && stack[openIndex].tagName !== tagName) openIndex -= 1;
      if (openIndex < 0) continue;
      const [open] = stack.splice(openIndex);
      if (open.owner) {
        boundaries.push({
          ...open.owner,
          contentStart: open.contentStart,
          endIdx: tagRe.lastIndex,
          length: tagRe.lastIndex - open.contentStart,
        });
      }
      continue;
    }

    const owner = pdkOwnerFromTag(rawTag);
    const selfClosing = rawTag.endsWith('/>') || voidTags.has(tagName);
    if (selfClosing) {
      if (owner) {
        boundaries.push({
          ...owner,
          contentStart: match.index,
          endIdx: tagRe.lastIndex,
          length: tagRe.lastIndex - match.index,
        });
      }
      continue;
    }
    stack.push({ tagName, owner, contentStart: match.index });
  }
  return boundaries;
}

function parseSnippetBoundaries(html) {
  return [
    ...parsePdkSnippetBoundaries(html),
    ...parseLegacySnippetBoundaries(html),
  ].sort((a, b) => a.length - b.length);
}

/**
 * The one boundary that owns an element, or null when that cannot be proven: `occurrences(text)`
 * counts the element in a slice of the page. Matches in boundaries that do not nest (same markup in
 * two snippets) or matches outside the owning boundary (page-level duplicate) are ambiguous, so the
 * caller gets no boundary rather than the first one.
 */
function ownerBoundary(html, boundaries, occurrences) {
  const hits = boundaries
    .map((b) => ({ b, n: occurrences(html.slice(b.contentStart, b.endIdx)) }))
    .filter((h) => h.n > 0);
  if (hits.length === 0) return null;
  const [inner] = hits; // boundaries are sorted innermost first
  const nested = hits.every((h) => h.b.contentStart <= inner.b.contentStart && inner.b.endIdx <= h.b.endIdx);
  return nested && occurrences(html) === inner.n ? inner.b : null;
}

const countOf = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

/**
 * Find 1-based line in a source .liquid file that matches the rendered HTML snippet.
 * Strips Paradox tokens and normalises whitespace before comparison.
 */
function findLineInSource(srcFile, snippetHtml) {
  const fullPath = containedPath(ROOT, srcFile);
  if (!fullPath || !existsSync(fullPath)) return null;
  try {
    const src = readFileSync(fullPath, 'utf8');
    const lines = src.split('\n');
    const tagM = snippetHtml.match(/<[a-zA-Z][^>]{4,}/);
    if (!tagM) return null;
    const key = tagM[0]
      .replace(/\s+/g, ' ')
      .replace(/\{\{[^}]+\}\}/g, '')
      .trim()
      .slice(0, 80);
    if (key.length < 8) return null;
    for (let i = 0; i < lines.length; i++) {
      const norm = lines[i].replace(/\s+/g, ' ').replace(/\{\{[^}]+\}\}/g, '');
      if (norm.includes(key)) return i + 1;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Core resolver: given a violation object and the full rendered page HTML
 * (containing scan:begin/end markers), finds the innermost partial boundary
 * that contains the violation's HTML snippet and returns source attribution.
 *
 * Enhanced JSON fields returned:
 *   originFile  — source .liquid path (e.g. "src/partials/index/hero.liquid")
 *   originLine  — 1-based line number within that .liquid file, or null
 *   snippetId   — partial identifier (e.g. "index/hero")
 *   confidence  — "high" (with line) | "medium" (boundary matched, no line)
 *   method      — "page-html-comment"
 *
 * @param {object} violation - has .html / .extract / .element.extract / .snippet
 * @param {string} renderedHtml - full page HTML with scan: markers
 * @returns {{ originFile, originLine, snippetId, confidence, method } | null}
 */
export function resolveSourceViolation(violation, renderedHtml) {
  const snippetHtml = (
    violation.html ||
    violation.extract ||
    violation.element?.extract ||
    violation.snippet ||
    ''
  ).trim();

  if (!snippetHtml || snippetHtml.length < 10) return null;

  const boundaries = parseSnippetBoundaries(renderedHtml);
  if (boundaries.length === 0) return null;

  // Use first 80 normalised chars as search key
  const searchNorm = snippetHtml.slice(0, 100).replace(/\s+/g, ' ');
  const searchKey = searchNorm.slice(0, 80);

  const b = ownerBoundary(renderedHtml, boundaries, (text) => countOf(text.replace(/\s+/g, ' '), searchKey));
  if (b) {
    const originLine = findLineInSource(b.srcFile, snippetHtml);
    const snippetId = b.snippetId
      || b.srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, '');

    return {
      originFile: b.srcFile,
      originLine,
      snippetId,
      // The line comes from a substring search, not the tag index: never better than medium here.
      confidence: 'medium',
      method: b.method || 'page-html-comment',
    };
  }

  return null;
}

/**
 * Resolve a violation using the built dist/*.html file for the given page URL.
 * Requires that pnpm build (or SCAN_MODE=true pnpm build) has been run so that
 * dist/*.html files exist with scan:begin/end markers injected by the Liquid adapter.
 *
 * @param {object} violation
 * @param {string} pageUrl - e.g. "http://localhost:1234/"
 * @returns {{ originFile, originLine, snippetId, confidence, method } | null}
 */
export async function resolveFromPageUrl(violation, pageUrl) {
  const cache = loadPageHtmlCache();

  let distPath;
  try {
    distPath = findDistPath(cache, pageUrl);
  } catch {
    return null;
  }

  const html = cache[distPath];
  if (!html) return null;

  return resolveSourceViolation(violation, html);
}

/**
 * Resolve a keyboard violation that has tag + text but no HTML snippet.
 * Searches scan:begin/end boundaries for a matching `<TAG[^>]*>...text` pattern.
 *
 * @param {string} tag  - e.g. "BUTTON", "A"
 * @param {string} text - visible text content of the element
 * @param {string} pageUrl
 * @returns {{ originFile, originLine, snippetId, confidence, method } | null}
 */
export async function resolveFromElementText(tag, text, pageUrl) {
  const cache = loadPageHtmlCache();
  let distPath;
  try {
    distPath = findDistPath(cache, pageUrl);
  } catch {
    return null;
  }
  const html = cache[distPath];
  if (!html) return null;

  const tagLower = (tag || '').toLowerCase();
  const escapedText = (text || '').slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!tagLower || escapedText.length < 3) return null;

  const re = new RegExp(`<${tagLower.replace(/[^a-z0-9-]/g, '')}(?=[\\s>/])[^>]*>[^<]*${escapedText}`, 'gi');
  const boundaries = parseSnippetBoundaries(html);

  {
    const b = ownerBoundary(html, boundaries, (text) => (text.match(re) || []).length);
    if (!b) return null;
    const snippetId = b.srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, '');
    // The boundary names the file; the tag index turns tag + text into a line.
    const located = findLineForTagText(b.srcFile, tagLower, text);
    return {
      originFile: b.srcFile,
      originLine: located?.line ?? null,
      snippetId,
      // No element markup here, so traceElement cannot confirm it: never above medium.
      confidence: 'medium',
      method: located ? `text-fingerprint+${located.method}` : 'text-fingerprint',
    };
  }
  return null;
}

/**
 * Resolve a screen-reader violation that has an href fingerprint.
 * Searches scan:begin/end boundaries for `href="${href}"`.
 *
 * @param {string} href     - e.g. "/career-paths"
 * @param {string} pageUrl
 * @returns {{ originFile, originLine, snippetId, confidence, method } | null}
 */
export async function resolveFromHref(href, pageUrl) {
  const cache = loadPageHtmlCache();
  let distPath;
  try {
    distPath = findDistPath(cache, pageUrl);
  } catch {
    return null;
  }
  const html = cache[distPath];
  if (!html) return null;

  const boundaries = parseSnippetBoundaries(html);
  const dq = `href="${href}"`;
  const sq = `href='${href}'`;

  {
    const b = ownerBoundary(html, boundaries, (text) => countOf(text, dq) + countOf(text, sq));
    if (!b) return null;
    const snippetId = b.srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, '');
    const located = findLineForHref(b.srcFile, href);
    return {
      originFile: b.srcFile,
      originLine: located?.line ?? null,
      snippetId,
      // No element markup here, so traceElement cannot confirm it: never above medium.
      confidence: 'medium',
      method: located ? `href-fingerprint+${located.method}` : 'href-fingerprint',
    };
  }
  return null;
}

/** Built (marker-carrying) HTML of the page for `pageUrl`, or null when it is not built. */
export function getBuiltPageHtml(pageUrl) {
  try {
    const cache = loadPageHtmlCache();
    return cache[findDistPath(cache, pageUrl)] || null;
  } catch {
    return null;
  }
}

export function clearResolverCache() {
  pageHtmlCache = null;
}

/**
 * Adapts a resolver result ({ originFile, originLine, ... }) to the report source shape
 * ({ file, line, ... }) that scanners attach to violations.
 */
export function toSource(resolved) {
  if (!resolved) return null;
  const { originFile, originLine, ...rest } = resolved;
  return { ...rest, file: originFile, line: originLine };
}
