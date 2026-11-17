import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadVendors } from './ownership.js';

export const SITE_FIX_NOTE = 'covered by a third-party overlay (not the site\'s markup); the site can still mitigate it with scroll-padding-bottom or bottom padding on html/body, or by changing how the vendor script is loaded';

const GLOBAL_DECL = /(?:^|[}\s,])(?:html|body)\b[^{}]*\{[^}]*?\b(?:scroll-padding(?:-top|-bottom)?|padding-bottom)\s*:/;
const walk = (dir, ext, out = []) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out); else if (ext.test(e.name)) out.push(p);
  }
  return out;
};
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Where the site mitigates an overlay it does not own: the global stylesheet that already styles html/body (the rule to add scroll-padding-bottom or
 * padding-bottom to), else the template that loads the vendor script. null when the project holds neither. shortcut: first match wins, text search not a CSS parse.
 */
export function findSiteFixSource(root, vendor) {
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  for (const f of walk(path.join(root, 'src/styles'), /\.css$/)) {
    if (path.basename(f) === '+.css') continue;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const hit = GLOBAL_DECL.exec(text) || /(?:^|[}\s,])(?:html|body)\b[^{}]*\{/.exec(text);
    if (hit) return { file: rel(f), line: lineOf(text, hit.index + hit[0].search(/(?:html|body)/)), method: 'global-stylesheet', confidence: 'low' };
  }
  const src = (vendor?.patterns?.src || []).flatMap((p) => { try { return [new RegExp(p, 'i')]; } catch { return []; } });
  const token = vendor?.id ? new RegExp(`\\b${vendor.id.replace(/[^\w-]/g, '')}`, 'i') : null;
  for (const dir of ['src/partials', 'src/layouts']) {
    for (const f of walk(path.join(root, dir), /\.liquid$/)) {
      let lines;
      try { lines = readFileSync(f, 'utf8').split('\n'); } catch { continue; }
      const i = lines.findIndex((l) => /<script\b/i.test(l) && (src.some((r) => r.test(l)) || (token && token.test(l))));
      if (i >= 0) return { file: rel(f), line: i + 1, method: 'vendor-script-loader', confidence: 'low' };
    }
  }
  return null;
}

/** Findings covered by a third-party overlay keep their third-party owner (outside the gate) and gain `siteFix.candidate`: where the site mitigates it. */
export function attachSiteFix(violations, root) {
  if (!existsSync(path.join(root, 'src'))) return;
  const cache = new Map();
  for (const v of violations) {
    if (!v.siteFix || v.siteFix.candidate) continue;
    const id = v.origin?.vendor || '';
    if (!cache.has(id)) cache.set(id, findSiteFixSource(root, loadVendors().find((x) => x.id === id)));
    v.siteFix.candidate = cache.get(id);
  }
}
