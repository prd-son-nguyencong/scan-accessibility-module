import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../utils/paths.js';

function hashBlock(block) {
  return `sha256:${createHash('sha256').update(block).digest('hex')}`;
}

export function buildSourcePreimage(content, line, radius = 2) {
  if (!Number.isInteger(line) || line < 1) return null;
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  if (line > lines.length) return null;
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return buildSourcePreimageRange(content, start, end);
}

export function buildSourcePreimageRange(content, startLine, endLine) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return null;
  }
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  if (endLine > lines.length) return null;
  const block = lines
    .slice(startLine - 1, endLine)
    .map((sourceLine) => sourceLine.replace(/[ \t]+$/g, ''))
    .join('\n');
  return {
    preimageSha256: hashBlock(block),
    range: { start: startLine, end: endLine },
  };
}

/** Path of `rel` inside `root` after resolving symlinks, or null when it escapes (segment check, not a string prefix). */
function realContainedPath(root, rel) {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(path.resolve(root, rel));
    const within = path.relative(realRoot, real);
    const escapes = within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within);
    return within && !escapes ? real : null;
  } catch {
    return null;
  }
}

export function computeSourcePreimage(sourceFile, line, root = getProjectRoot()) {
  if (!sourceFile || !Number.isInteger(line) || line < 1) return null;
  const fullPath = realContainedPath(root, sourceFile);
  if (!fullPath) return null;
  try {
    return buildSourcePreimage(readFileSync(fullPath, 'utf8'), line);
  } catch {
    return null;
  }
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `sha256:<hex>` of each project-relative file's bytes; files that cannot be read are left out. */
export function hashSourceFiles(root, files) {
  const hashes = {};
  for (const file of [...new Set(files)].sort()) {
    const full = realContainedPath(root, file);
    if (!full) continue;
    try { hashes[file] = hashBlock(readFileSync(full)); } catch { /* unreadable: not attested */ }
  }
  return hashes;
}

/** Files whose current content no longer matches the hash recorded at build time (deleted or unreadable count as changed). */
export function findChangedSources(root, recorded) {
  if (!recorded || typeof recorded !== 'object') return [];
  return Object.entries(recorded)
    .filter(([file, hash]) => SHA256_PATTERN.test(hash) && hashSourceFiles(root, [file])[file] !== hash)
    .map(([file]) => file)
    .sort();
}
