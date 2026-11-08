// G2 helpers: multisets of Paradox backend tags, data-pdk-* attributes and colour/design declarations in source text.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BACKEND_TAG = /\{\{\s*(?:data|component|snippet|attribute)\s*:[^}]*\}\}/g;
const PDK_ATTR = /\bdata-pdk-[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
const COLOR_PROPS = '--[\\w-]+|color|background(?:-color|-image)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|opacity|box-shadow|text-shadow|caret-color|accent-color';
const DECL = new RegExp(`(?:^|[;{\\s"'])(${COLOR_PROPS})\\s*:\\s*([^;}{"']+)`, 'gim');
// Tailwind colour/opacity utilities only (named palette steps, arbitrary values, white/black/...); semantic tokens such as bg-primary are a known blind spot.
const TW_COLOR = /(?<=[\s"'])(?:[\w-]+:)*-?(?:bg|text|border|fill|stroke|outline|ring|from|via|to|decoration|accent|caret|opacity)-(?:\[[^\]\s]+\]|[a-z]+-\d{2,3}(?:\/\d+)?|white|black|transparent|current|inherit|\d{1,3})(?=[\s"'])/g;

const squash = (s) => s.replace(/\s+/g, ' ').trim();

export function addAll(map, items) {
  for (const it of items) map.set(it, (map.get(it) || 0) + 1);
  return map;
}

/** Multiset (Map token -> count) of backend tags and data-pdk-* attributes. */
export function extractBackendTokens(text) {
  return addAll(new Map(), [...text.matchAll(BACKEND_TAG), ...text.matchAll(PDK_ATTR)].map((m) => squash(m[0])));
}

/** Multiset of colour/background/opacity/design-token declarations plus Tailwind colour utilities. */
export function extractDesignTokens(text) {
  const out = [];
  for (const m of text.matchAll(DECL)) {
    const value = squash(m[2]);
    // The outline shorthand is a focus style: keywords, widths and currentColor introduce no colour. A literal colour or var() still counts.
    if (m[1].toLowerCase() === 'outline' && !squash(value.replace(/!important|\b(?:none|auto|solid|dashed|dotted|double|thin|medium|thick|currentcolor|inherit|initial|unset|invert|[\d.]+(?:px|r?em)?)\b/gi, '')).length) continue;
    if (m[1].startsWith('border') && !/#|rgb|hsl|oklch|var\(|\b[a-z]{3,}\b/i.test(value)) continue; // border widths alone are layout
    out.push(`${m[1].toLowerCase()}: ${value}`);
  }
  for (const m of text.matchAll(TW_COLOR)) out.push(`tw ${m[0]}`);
  return addAll(new Map(), out);
}

export function mergeMultisets(maps) {
  const out = new Map();
  for (const m of maps) for (const [k, n] of m) out.set(k, (out.get(k) || 0) + n);
  return out;
}

/** @returns {{added:string[], removed:string[]}} entries repeated by their count difference, sorted. */
export function diffMultisets(before, after) {
  const added = [], removed = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(k) || 0) - (before.get(k) || 0);
    for (let i = 0; i < Math.abs(d); i++) (d > 0 ? added : removed).push(k);
  }
  return { added: added.sort(), removed: removed.sort() };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.ada-scan']);
const MAX_FILE = 2 * 1024 * 1024;

/** Reads a source tree into Map(relPath -> Buffer). Skips node_modules, .git and .ada-scan; dist is read so G2 can see edits to it. */
export function readTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full); } else if (st.isFile() && st.size <= MAX_FILE) {
        out.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
      }
    }
  };
  walk(dir);
  return out;
}

const TEXT_EXT = /\.(?:html?|liquid|css|js|mjs|svg|json)$/i;
const STYLE_EXT = /\.(?:html?|liquid|css|svg)$/i;

/** Compares a before and after tree (Map or directory): backend tag / data-pdk multiset and design-token multiset. */
export function compareTrees(beforeTree, afterTree) {
  const toMap = (t) => (typeof t === 'string' ? readTree(t) : t);
  const [b, a] = [toMap(beforeTree), toMap(afterTree)];
  const collect = (tree, fn, extRe) => mergeMultisets([...tree].filter(([f]) => extRe.test(f)).map(([, buf]) => fn(buf.toString('utf8'))));
  return {
    backend: diffMultisets(collect(b, extractBackendTokens, TEXT_EXT), collect(a, extractBackendTokens, TEXT_EXT)),
    design: diffMultisets(collect(b, extractDesignTokens, STYLE_EXT), collect(a, extractDesignTokens, STYLE_EXT)),
  };
}
