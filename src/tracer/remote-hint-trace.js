import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readBoundedFile } from '../fix/review/secure-io.js';
import { buildSourcePreimage } from './preimage.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const LIQUID_EXT = '.liquid';

export const DEFAULT_SOURCE_ROOTS = Object.freeze([
  'src/partials',
  'src/pages',
  'src/components',
]);

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveContainedSearchRoots(localRoot, searchRoots = DEFAULT_SOURCE_ROOTS) {
  if (!localRoot || typeof localRoot !== 'string') return [];
  let resolvedRoot;
  try {
    resolvedRoot = realpathSync(localRoot);
  } catch {
    return [];
  }

  const contained = [];
  for (const relRoot of searchRoots) {
    if (typeof relRoot !== 'string' || !relRoot || relRoot.includes('..') || isAbsolute(relRoot)) {
      continue;
    }
    const candidate = resolve(resolvedRoot, relRoot);
    if (!existsSync(candidate)) continue;
    let resolvedCandidate;
    try {
      resolvedCandidate = realpathSync(candidate);
    } catch {
      continue;
    }
    const rel = relative(resolvedRoot, resolvedCandidate);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    if (!lstatSync(resolvedCandidate).isDirectory()) continue;
    contained.push({ relRoot, absRoot: resolvedCandidate, localRoot: resolvedRoot });
  }
  return contained;
}

function walkLiquidFiles(dir, localRoot, matches, hint) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkLiquidFiles(full, localRoot, matches, hint);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(LIQUID_EXT)) continue;
    if (!isRegularFile(full)) continue;

    let resolvedPath;
    try {
      resolvedPath = realpathSync(full);
    } catch {
      continue;
    }
    const rel = relative(localRoot, resolvedPath);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;

    let raw;
    try {
      raw = readBoundedFile(resolvedPath, MAX_SOURCE_BYTES);
    } catch {
      continue;
    }
    if (raw == null) continue;

    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(hint)) continue;
      const line = index + 1;
      const preimage = buildSourcePreimage(raw, line);
      matches.push({
        file: rel.split('\\').join('/'),
        line,
        preimageSha256: preimage?.preimageSha256 || null,
        preimageRange: preimage?.range || null,
      });
    }
  }
}

/**
 * Collect every file+line match for a hint under contained source roots.
 */
export function searchLiquidHintMatches(localRoot, hint, searchRoots = DEFAULT_SOURCE_ROOTS) {
  if (typeof hint !== 'string' || hint.length < 3) return [];
  const roots = resolveContainedSearchRoots(localRoot, searchRoots);
  const matches = [];
  for (const root of roots) {
    walkLiquidFiles(root.absRoot, root.localRoot, matches, hint);
  }

  const distinct = new Map();
  for (const match of matches) {
    distinct.set(`${match.file}|${match.line}`, match);
  }
  return [...distinct.values()];
}

export function extractHtmlHints(outerHTML = '') {
  const html = String(outerHTML);
  if (html.length < 10) return [];

  const idMatch = html.match(/id="([^"]+)"/);
  const classStr = (html.match(/class="([^"]+)"/) || [])[1] || '';
  const uniqueClasses = classStr.split(/\s+/).filter((value) =>
    value.length > 4 && !value.startsWith('text-') && !value.startsWith('p-') && !value.includes(':'),
  );
  const ariaLabel = (html.match(/aria-label="([^"]+)"/) || [])[1];
  const dataTestid = (html.match(/data-testid="([^"]+)"/) || [])[1];
  const href = (html.match(/href="([^"]{5,})"/) || [])[1];

  return [
    idMatch?.[1],
    ariaLabel,
    dataTestid,
    uniqueClasses.length >= 2 ? uniqueClasses.slice(0, 2).join(' ') : null,
    ...uniqueClasses,
    href && !href.startsWith('#') && !href.startsWith('http') ? href : null,
  ].filter(Boolean);
}

/**
 * Assign remote hint attribution only when exactly one distinct file+line matches.
 */
export function applyRemoteHintAttribution(violation, localRoot, {
  searchRoots = DEFAULT_SOURCE_ROOTS,
} = {}) {
  if (!violation || !localRoot) return violation;
  if (violation.source?.file && violation.source.file !== 'unknown' && violation.source?.line) {
    return violation;
  }

  const hints = extractHtmlHints(violation.element?.outerHTML || '');
  const allMatches = new Map();
  for (const hint of hints) {
    for (const match of searchLiquidHintMatches(localRoot, hint, searchRoots)) {
      allMatches.set(`${match.file}|${match.line}`, match);
    }
  }

  const distinct = [...allMatches.values()];
  if (distinct.length === 0) {
    return violation;
  }

  if (distinct.length === 1) {
    const match = distinct[0];
    violation.source = {
      ...(violation.source || {}),
      mode: violation.source?.mode || 'url',
      file: match.file,
      line: match.line,
      partial: match.file,
      confidence: 'medium',
      method: 'hybrid-verified-unique-hint',
      preimageSha256: match.preimageSha256,
      preimageRange: match.preimageRange || null,
    };
    return violation;
  }

  violation.source = {
    ...(violation.source || {}),
    mode: violation.source?.mode || 'url',
    file: null,
    line: null,
    confidence: 'none',
    method: 'hybrid-ambiguous-hint',
    preimageSha256: null,
    preimageRange: null,
  };
  violation.sourceCandidates = distinct.map((match) => ({
    file: match.file,
    line: match.line,
    confidence: 'low',
    method: 'hybrid-ambiguous-hint',
    preimageSha256: match.preimageSha256,
  }));
  return violation;
}

export function applyAttestedRemoteTracing(pageResults, localRoot, {
  searchRoots = DEFAULT_SOURCE_ROOTS,
} = {}) {
  if (!localRoot || !Array.isArray(pageResults)) return pageResults;
  return pageResults.map((pageResult) => ({
    ...pageResult,
    violations: (pageResult.violations || []).map((violation) =>
      applyRemoteHintAttribution(structuredClone(violation), localRoot, { searchRoots }),
    ),
  }));
}
