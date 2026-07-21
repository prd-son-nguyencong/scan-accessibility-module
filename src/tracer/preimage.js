import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

export function computeSourcePreimage(sourceFile, line, root = getProjectRoot()) {
  if (!sourceFile || !Number.isInteger(line) || line < 1) return null;
  const fullPath = path.resolve(root, sourceFile);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(fullPath)) return null;
  try {
    return buildSourcePreimage(readFileSync(fullPath, 'utf8'), line);
  } catch {
    return null;
  }
}
