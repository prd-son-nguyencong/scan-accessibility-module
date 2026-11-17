import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Preview findings are traced through the LOCAL source, so it matters whether that source is what was
 * pushed. Compares the local build export (`<outDir>/paradox-export.json`) with the pushed export
 * (`pushedPath`, else the newest `JSON_for_pushed_data/*.json`) element by element (`elements_data[].path`)
 * on the sha256 of whitespace-normalized content. Metadata only, never fatal: returns null when either side
 * is missing or unreadable.
 */
const sha = (content) => createHash('sha256').update(String(content).replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()).digest('hex');

function readElements(file) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')).elements_data;
    return Array.isArray(list) ? new Map(list.filter((e) => e && typeof e.path === 'string').map((e) => [e.path, e])) : null;
  } catch {
    return null;
  }
}

function newestPushed(root) {
  const dir = path.join(root, 'JSON_for_pushed_data');
  if (!existsSync(dir)) return null;
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.report.json')).sort(); } catch { return null; }
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

export function detectSourceDrift(root, { outDir = 'dist', pushedPath } = {}) {
  const pushedFile = pushedPath || newestPushed(root);
  // The host's paradox-export plugin writes dist/paradox-export.json regardless of the configured outDir.
  const local = readElements(path.join(root, outDir, 'paradox-export.json')) || readElements(path.join(root, 'dist', 'paradox-export.json'));
  const pushed = pushedFile && readElements(pushedFile);
  if (!local || !pushed) return null;
  const drifted = [];
  let compared = 0;
  for (const [file, element] of [...local].sort(([a], [b]) => a.localeCompare(b))) {
    const remote = pushed.get(file);
    if (!remote) continue;
    compared++;
    const [localSha256, pushedSha256] = [sha(element.content ?? ''), sha(remote.content ?? '')];
    if (localSha256 !== pushedSha256) drifted.push({ path: file, localSha256, pushedSha256 });
  }
  return {
    pushedFile: path.basename(pushedFile),
    compared,
    drifted,
    warnings: drifted.map((d) => `local source differs from pushed version for ${d.path}`),
  };
}
