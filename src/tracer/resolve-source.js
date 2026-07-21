import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';

const ROOT = getProjectRoot();

// Cache of dist/*.html page contents, keyed by dist-relative path
let pageHtmlCache = null;

function loadPageHtmlCache() {
  if (pageHtmlCache) return pageHtmlCache;
  pageHtmlCache = {};
  const distDir = path.join(ROOT, 'dist');
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
  if (!name || name.startsWith('/') || name.split('/').includes('..')) return null;
  const normalizedName = name.replace(/\\/g, '/').replace(/\.liquid$/, '');
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
 * Find 1-based line in a source .liquid file that matches the rendered HTML snippet.
 * Strips Paradox tokens and normalises whitespace before comparison.
 */
function findLineInSource(srcFile, snippetHtml) {
  const fullPath = path.join(ROOT, srcFile);
  if (!existsSync(fullPath)) return null;
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

  for (const b of boundaries) {
    const contentSlice = renderedHtml.slice(b.contentStart, b.endIdx);
    if (!contentSlice.replace(/\s+/g, ' ').includes(searchKey)) continue;

    const originLine = findLineInSource(b.srcFile, snippetHtml);
    const snippetId = b.snippetId
      || b.srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, '');

    return {
      originFile: b.srcFile,
      originLine,
      snippetId,
      confidence: originLine ? 'high' : 'medium',
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
    const pathname = new URL(pageUrl).pathname.replace(/\/$/, '') || '/';
    distPath = pathname === '/' ? 'dist/index.html' : `dist${pathname}/index.html`;
    if (!cache[distPath]) {
      distPath = `dist${pathname}.html`;
    }
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
    const pathname = new URL(pageUrl).pathname.replace(/\/$/, '') || '/';
    distPath = pathname === '/' ? 'dist/index.html' : `dist${pathname}/index.html`;
    if (!cache[distPath]) distPath = `dist${pathname}.html`;
  } catch {
    return null;
  }
  const html = cache[distPath];
  if (!html) return null;

  const tagLower = (tag || '').toLowerCase();
  const escapedText = (text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60);
  if (!tagLower || escapedText.length < 3) return null;

  const re = new RegExp(`<${tagLower}[^>]*>[^<]*${escapedText}`, 'i');
  const boundaries = parseSnippetBoundaries(html);

  for (const b of boundaries) {
    const contentSlice = html.slice(b.contentStart, b.endIdx);
    if (!re.test(contentSlice)) continue;
    const snippetId = b.srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, '');
    return {
      originFile: b.srcFile,
      originLine: null,
      snippetId,
      confidence: 'medium',
      method: 'text-fingerprint',
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
    const pathname = new URL(pageUrl).pathname.replace(/\/$/, '') || '/';
    distPath = pathname === '/' ? 'dist/index.html' : `dist${pathname}/index.html`;
    if (!cache[distPath]) distPath = `dist${pathname}.html`;
  } catch {
    return null;
  }
  const html = cache[distPath];
  if (!html) return null;

  const boundaries = parseSnippetBoundaries(html);
  const dq = `href="${href}"`;
  const sq = `href='${href}'`;

  for (const b of boundaries) {
    const contentSlice = html.slice(b.contentStart, b.endIdx);
    if (!contentSlice.includes(dq) && !contentSlice.includes(sq)) continue;
    const snippetId = b.srcFile.replace(/^src\/partials\//, '').replace(/\.liquid$/, '');
    return {
      originFile: b.srcFile,
      originLine: null,
      snippetId,
      confidence: 'medium',
      method: 'href-fingerprint',
    };
  }
  return null;
}

export function clearResolverCache() {
  pageHtmlCache = null;
}
