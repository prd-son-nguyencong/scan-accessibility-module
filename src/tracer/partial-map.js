import { existsSync, readFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot, urlToPageFile } from '../utils/paths.js';
import { resolveFromPageUrl, clearResolverCache } from './resolve-source.js';

const ROOT = getProjectRoot();

// In-memory caches — reset by clearPartialCache() after each instrumented build
let partialContentsCache = null;
let manifestCache = null;

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadPartialContents() {
  if (partialContentsCache) return partialContentsCache;
  partialContentsCache = {};
  const files = await fg('dist/partials/**/*.html', { cwd: ROOT });
  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    if (existsSync(fullPath)) {
      partialContentsCache[file] = readFileSync(fullPath, 'utf8');
    }
  }
  return partialContentsCache;
}

function loadManifest() {
  if (manifestCache) return manifestCache;
  const manifestPath = path.join(ROOT, 'dist', 'scan-manifest.json');
  if (!existsSync(manifestPath)) { manifestCache = {}; return manifestCache; }
  try {
    manifestCache = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    manifestCache = {};
  }
  return manifestCache;
}

// ─── Line number detection ────────────────────────────────────────────────────

/**
 * Searches a source .liquid file for the first tag attribute fingerprint from
 * the violation HTML snippet. Returns 1-based line number or null.
 */
function findLineInSource(sourceFile, snippetHtml) {
  const fullPath = path.join(ROOT, sourceFile);
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    // Strategy 1: Extract the first tag's attribute string as a search key
    const tagMatch = snippetHtml.match(/<[a-zA-Z][^>]{4,}/);
    if (tagMatch) {
      const searchKey = tagMatch[0]
        .replace(/\s+/g, ' ')
        .replace(/\{\{[^}]+\}\}/g, '')
        .trim()
        .slice(0, 80);

      if (searchKey.length >= 8) {
        for (let i = 0; i < lines.length; i++) {
          const normalised = lines[i].replace(/\s+/g, ' ').replace(/\{\{[^}]+\}\}/g, '');
          if (normalised.includes(searchKey)) return i + 1;
        }
      }
    }

    // Strategy 2: Search by unique attribute values (id, aria-label, href, data-testid)
    const attrPatterns = [
      /id="([^"]+)"/,
      /aria-label="([^"]+)"/,
      /data-testid="([^"]+)"/,
    ];
    for (const pat of attrPatterns) {
      const m = snippetHtml.match(pat);
      if (m && m[1].length >= 3) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(m[1])) return i + 1;
        }
      }
    }

    // Strategy 3: Search by unique CSS class combinations
    const classStr = (snippetHtml.match(/class="([^"]+)"/) || [])[1] || '';
    const uniqueClasses = classStr.split(/\s+/).filter(c =>
      c.length > 5 && !c.startsWith('text-') && !c.startsWith('p-') &&
      !c.startsWith('m-') && !c.includes(':') && !c.startsWith('w-') &&
      !c.startsWith('h-') && !c.startsWith('flex') && !c.startsWith('gap-')
    );
    for (const cls of uniqueClasses) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(cls)) return i + 1;
      }
    }
  } catch {
    // ignore read errors
  }
  return null;
}

function distPathToSourcePath(distPath) {
  return distPath.replace(/^dist\//, 'src/').replace(/\.html$/, '.liquid');
}

// ─── Core tracer ──────────────────────────────────────────────────────────────

/**
 * Traces a violation HTML snippet to the source .liquid file.
 *
 * Confidence levels:
 *  'high'   — snippet found verbatim in a dist/partials sub-folder HTML file,
 *             manifest maps that dist path → src path, line number resolved.
 *  'medium' — snippet found in a partial but manifest entry missing (path-derived).
 *  'low'    — URL-to-page fallback; no partial match found.
 *  'none'   — could not determine any source.
 */
async function traceToSource(snippetHtml, pageUrl) {
  const manifest = loadManifest();
  const partialContents = await loadPartialContents();

  const rawKey = (snippetHtml || '').trim().slice(0, 120);
  const searchKey = rawKey.replace(/\s+/g, ' ');

  if (searchKey.length > 10) {
    // 1. Search individual partial HTML files for the snippet (SCAN_MODE build outputs)
    //    Normalize whitespace so multiline dist HTML matches single-line browser outerHTML.
    for (const [distFile, content] of Object.entries(partialContents)) {
      const normContent = content.replace(/\s+/g, ' ');
      if (normContent.includes(searchKey)) {
        let srcFile = manifest[distFile] || distPathToSourcePath(distFile);
        let line = findLineInSource(srcFile, snippetHtml);
        if (!line && !existsSync(path.join(ROOT, srcFile))) {
          const stripped = srcFile.replace(/^src\/partials\/[^/]+\//, 'src/partials/');
          if (stripped !== srcFile && existsSync(path.join(ROOT, stripped))) {
            srcFile = stripped;
            line = findLineInSource(srcFile, snippetHtml);
          }
        }
        const confidence = line ? 'high' : (manifest[distFile] ? 'high' : 'medium');
        return { file: srcFile, line, confidence, method: 'partial-file-search' };
      }
    }

    // 1.5. Resolve via scan:begin/end markers in the built dist page HTML
    const pageResolved = await resolveFromPageUrl({ html: snippetHtml }, pageUrl);
    if (pageResolved) {
      return {
        file: pageResolved.originFile,
        line: pageResolved.originLine,
        confidence: pageResolved.confidence,
        snippetId: pageResolved.snippetId,
        method: pageResolved.method,
      };
    }
  }

  // 2. URL → page source file (low confidence — correct file, no line)
  try {
    const urlPath = new URL(pageUrl).pathname;
    const pageFile = urlToPageFile(urlPath);
    const line = searchKey.length > 10 ? findLineInSource(pageFile, snippetHtml) : null;
    return { file: pageFile, line, confidence: line ? 'medium' : 'low', method: 'url-fallback' };
  } catch {
    return { file: 'unknown', line: null, confidence: 'none', method: 'url-fallback' };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Maps an axe violation node back to its source .liquid file.
 * Returns { file, line, confidence }.
 */
export async function mapViolationToSource(node, pageUrl) {
  return traceToSource(node.html, pageUrl);
}

/**
 * Maps a non-axe violation (keyboard / SR / etc.) that has no HTML snippet.
 * Uses URL → page source only.
 */
export async function mapDescriptionToSource(pageUrl) {
  try {
    const urlPath = new URL(pageUrl).pathname;
    return { file: urlToPageFile(urlPath), line: null, confidence: 'low' };
  } catch {
    return { file: 'unknown', line: null, confidence: 'none' };
  }
}

export function clearPartialCache() {
  partialContentsCache = null;
  manifestCache = null;
  clearResolverCache();
}
