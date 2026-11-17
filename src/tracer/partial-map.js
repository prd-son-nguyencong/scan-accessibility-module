import { existsSync, readFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot, urlToPageFile, distToSrcLiquid } from '../utils/paths.js';
import { resolveProject } from '../utils/project.js';
import { resolveFromPageUrl, getBuiltPageHtml, clearResolverCache, isBuiltOutputDisabled } from './resolve-source.js';
import { traceElement, traceToSourceFields } from './trace-element.js';
import { computeSourcePreimage } from './preimage.js';

const ROOT = getProjectRoot();

// In-memory caches — reset by clearPartialCache() after each instrumented build
let partialContentsCache = null;
let manifestCache = null;
let projectCache = null;

function project() {
  return (projectCache ||= resolveProject());
}

const NO_SOURCE = { file: 'unknown', line: null, confidence: 'none', method: 'no-source-project' };

/** A page-level guess (src/pages/<x>.liquid) is only honest when a source project is present (template dir or build manifest). */
function hasSourceProject() {
  return existsSync(project().pagesDir) || existsSync(project().manifestPath);
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadPartialContents() {
  if (partialContentsCache) return partialContentsCache;
  partialContentsCache = {};
  if (isBuiltOutputDisabled()) return partialContentsCache;
  const files = await fg(`${project().outDir}/partials/**/*.html`, { cwd: ROOT });
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
  if (isBuiltOutputDisabled()) { manifestCache = {}; return manifestCache; }
  const manifestPath = project().manifestPath;
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
  return distToSrcLiquid(distPath, project().distMap);
}

export function normalizeTraceAttestation(source, root = ROOT) {
  const preimage = computeSourcePreimage(source.file, source.line, root);
  return preimage
    ? {
        ...source,
        preimageSha256: preimage.preimageSha256,
        preimageRange: preimage.range,
      }
    : {
        ...source,
        confidence: source.confidence === 'high' ? 'medium' : source.confidence,
        preimageSha256: null,
        preimageRange: null,
      };
}

const attachPreimage = normalizeTraceAttestation;

export function confidenceForPartialMatch({ line, manifestMatched }) {
  return line && manifestMatched ? 'high' : 'medium';
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
        const confidence = confidenceForPartialMatch({
          line,
          manifestMatched: Boolean(manifest[distFile]),
        });
        return attachPreimage({
          file: srcFile,
          line,
          confidence,
          method: manifest[distFile] ? 'instrumentation-manifest' : 'partial-file-search',
        });
      }
    }

    // 1.5. Resolve via scan:begin/end markers in the built dist page HTML
    const pageResolved = await resolveFromPageUrl({ html: snippetHtml }, pageUrl);
    if (pageResolved) {
      return attachPreimage({
        file: pageResolved.originFile,
        line: pageResolved.originLine,
        confidence: pageResolved.confidence,
        snippetId: pageResolved.snippetId,
        method: pageResolved.method,
      });
    }
  }

  // 2. URL → page source file (low confidence — correct file, no line)
  if (!hasSourceProject()) return { ...NO_SOURCE };
  try {
    const urlPath = new URL(pageUrl).pathname;
    const pageFile = urlToPageFile(urlPath, { ...project(), root: ROOT });
    const line = searchKey.length > 10 ? findLineInSource(pageFile, snippetHtml) : null;
    return attachPreimage({
      file: pageFile,
      line,
      confidence: line ? 'medium' : 'low',
      method: 'url-fallback',
    });
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
  return reconcileWithTrace(await traceToSource(node.html, pageUrl), node.html, pageUrl);
}

const OWNER_PROVEN_METHODS = new Set(['instrumentation-manifest', 'page-html-comment', 'pdk-partial-boundary', 'pdk-render-boundary']);

/**
 * traceElement is the single authority on confidence: the heuristics above only propose a file.
 * Several equally good places become unresolved (the caller falls back to the page and lists
 * candidates); a `high` the unified trace cannot confirm is replaced by its verdict or capped.
 */
function reconcileWithTrace(legacy, html, pageUrl) {
  const outerHTML = (html || '').trim();
  if (!legacy?.file || legacy.file === 'unknown' || outerHTML.length < 10 || !hasSourceProject()) return legacy;
  let pageFile = null;
  try { pageFile = urlToPageFile(new URL(pageUrl).pathname, { ...project(), root: ROOT }); } catch { /* page unknown */ }
  const result = traceElement({
    outerHTML,
    mode: 'local',
    root: ROOT,
    pageFile,
    devHost: (() => { try { return new URL(pageUrl).hostname; } catch { return undefined; } })(),
    pageHtml: getBuiltPageHtml(pageUrl) || undefined,
    ownerFile: OWNER_PROVEN_METHODS.has(legacy.method) ? legacy.file : null,
  });
  const trace = { traceConfidence: result.confidence, traceReason: result.reason };
  if (result.confidence === 'ambiguous' && legacy.confidence !== 'low') {
    return { file: 'unknown', line: null, confidence: 'none', method: 'unresolved', ...trace };
  }
  if (legacy.confidence !== 'high') return { ...legacy, ...trace };
  if (result.candidates.length === 1) {
    const traced = traceToSourceFields(result, ROOT).source;
    // Same file: keep how the owner was proven (manifest, marker) as the method.
    return { ...legacy, ...traced, method: traced.file === legacy.file ? legacy.method : traced.method };
  }
  return { ...legacy, confidence: 'medium', ...trace };
}

/**
 * Maps a non-axe violation (keyboard / SR / etc.) that has no HTML snippet.
 * Uses URL → page source only.
 */
export async function mapDescriptionToSource(pageUrl) {
  if (!hasSourceProject()) return { ...NO_SOURCE };
  try {
    const urlPath = new URL(pageUrl).pathname;
    return {
      file: urlToPageFile(urlPath, { ...project(), root: ROOT }),
      line: null,
      confidence: 'low',
      method: 'url-fallback',
    };
  } catch {
    return {
      file: 'unknown',
      line: null,
      confidence: 'none',
      method: 'url-fallback',
    };
  }
}

export function clearPartialCache() {
  partialContentsCache = null;
  manifestCache = null;
  projectCache = null;
  clearResolverCache();
}
