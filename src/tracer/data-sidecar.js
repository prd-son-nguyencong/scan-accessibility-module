import { existsSync, readFileSync } from 'node:fs';
import { containedPath } from '../utils/paths.js';
import { parseRenderedTag } from './liquid-tag-index.js';

const decode = (v) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Values worth looking up in template data, strongest first: href, src, alt, aria-label, then the element's own text. */
function lookupValues(outerHTML) {
  const tag = parseRenderedTag(outerHTML);
  if (!tag) return [];
  return [tag.attrs.href, tag.attrs.src, tag.attrs.alt, tag.attrs['aria-label'], tag.text]
    .filter((v) => typeof v === 'string' && v.trim().length >= 3 && !/^(#|\{\{)/.test(v.trim()))
    .map((v) => decode(v.trim()));
}

/**
 * Several entries hold the same value (two cards share one placeholder image): the entry whose own object also holds the element's other values
 * (its alt, its text) is the one rendered. The object is the run of lines indented deeper than its braces. Ties keep the first.
 */
function pickEntry(lines, hits, others) {
  if (hits.length === 1 || !others.length) return hits[0];
  const indent = (l) => /^\s*/.exec(l)[0].length;
  const score = (i) => {
    let a = i;
    while (a > 0 && indent(lines[a]) >= indent(lines[i])) a -= 1;
    let b = i;
    while (b < lines.length - 1 && indent(lines[b]) >= indent(lines[i])) b += 1;
    const body = lines.slice(a, b + 1).join('\n');
    return others.filter((o) => body.includes(JSON.stringify(o).slice(1, -1))).length;
  };
  const scores = hits.map(score);
  return hits[scores.indexOf(Math.max(...scores))];
}

/**
 * Where the data behind a rendered element is authored: the line of the `.liquid.json` sidecar (paired 1:1 with a
 * template) that holds the element's href / src / text as a whole string value. Sidecars of `files` are searched in
 * order (the traced template first). Null when none holds it: the markup alone then decides the source.
 */
export function findDataSource(files, outerHTML, root) {
  const values = lookupValues(outerHTML);
  for (const file of files) {
    const dataFile = `${file}.json`;
    const full = containedPath(root, dataFile);
    if (!full || !existsSync(full)) continue;
    let lines;
    try { lines = readFileSync(full, 'utf8').split('\n'); } catch { continue; }
    for (const value of values) {
      const needle = JSON.stringify(value).slice(1, -1);
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const whole = new RegExp(`(^|[:\\[,\\s])"${esc}"\\s*(?:[,}\\]]|$)`);
      const hits = lines.flatMap((l, i) => (whole.test(l.trimEnd()) ? [i] : []));
      // A url authored inside a markup string (`"notice": "... <a href=\"https://x\">here</a>"`): the string's own line holds it.
      const inMarkup = hits.length || !/^(?:https?:)?\/\/|^\//.test(value) ? [] : lines.flatMap((l, i) => (l.includes(`=\\"${needle}\\"`) ? [i] : []));
      const found = hits.length ? hits : inMarkup;
      if (found.length) return { dataFile, dataLine: pickEntry(lines, found, values.filter((v) => v !== value)) + 1 };
    }
  }
  return null;
}

/** Every sidecar of `files` that holds the element's value (first match per file), for deciding whether the data source is unique. */
export function findAllDataSources(files, outerHTML, root) {
  return files.map((f) => findDataSource([f], outerHTML, root)).filter(Boolean);
}
