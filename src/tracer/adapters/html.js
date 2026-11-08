import { existsSync } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../../utils/paths.js';
import { classifyOwnership, untraceableOwnerReason } from '../ownership.js';
import { htmlFiles, indexHtmlFile, parseHtml, textOf, hashOf } from '../html-source-index.js';
import { detectFramework } from './index.js';
import { registerAdapter } from './registry.js';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Stable, authored attributes (the same idea as the Liquid index); runtime-added ones are ignored.
const SCORED_ATTRS = ['href', 'src', 'type', 'role', 'name', 'alt', 'title', 'placeholder', 'aria-label', 'for', 'value', 'data-testid'];
const MIN_SCORE = 3; // below this a candidate has no evidence beyond its tag name
const MARGIN = 2; // a winner must lead the runner-up by this much, else the tie is ambiguous

/** Ancestor segments of a CSS selector (`main > #nav > ul`), minus the element itself and `:nth-*` noise. */
function selectorAncestors(selector) {
  const segs = String(selector || '').split(/\s*>\s*|\s+/).filter(Boolean).slice(0, -1);
  return segs.map((s) => s.replace(/:[\w-]+(\([^)]*\))?/g, '')).map((s) => (/#([\w-]+)/.exec(s) ? `#${/#([\w-]+)/.exec(s)[1]}` : s.replace(/[.[].*$/, '').toLowerCase())).filter(Boolean);
}

function ancestorScore(wanted, have) {
  let at = 0;
  let hits = 0;
  for (const seg of wanted) {
    const found = have.indexOf(seg, at);
    if (found !== -1) { hits++; at = found + 1; }
  }
  return Math.min(hits, 3);
}

/** Score one source element against the rendered one; null = ruled out (different id or contradicting text). */
function score(src, r) {
  if (src.tag !== r.tag) return null;
  if (r.id && src.id && r.id !== src.id) return null;
  const evidence = [];
  let total = 0;
  const add = (points, label) => { total += points; evidence.push(label); };
  if (r.id && src.id === r.id) add(10, 'id');
  if (r.hash === src.hash) add(10, 'exact-structure');
  for (const k of SCORED_ATTRS) {
    if (src.attrs[k] === undefined) continue;
    if (r.attrs[k] === undefined) add(-1, `missing:${k}`);
    else if (norm(r.attrs[k]) === norm(src.attrs[k])) add(2, `attr:${k}`);
    else add(-3, `differs:${k}`);
  }
  const rendered = new Set(r.classes);
  const shared = src.classes.filter((c) => rendered.has(c));
  if (shared.length) add(Math.min(shared.length, 3), 'classes');
  if (src.classes.length > shared.length) add(-1, 'classes-missing');
  if (r.text && src.text) {
    const [a, b] = [r.text, src.text];
    if (a === b) add(4, 'text');
    else if (a.startsWith(b) || b.startsWith(a)) add(2, 'text-prefix'); // outerHTML may be truncated, DOM text may grow
    else return null;
  }
  const near = ancestorScore(r.ancestors, src.ancestry);
  if (near) add(near, 'ancestry');
  return { total, evidence };
}

/**
 * Locate a scanned element in plain `.html` source.
 * @param {object} el outerHTML, selector, text, pageFile (project-relative .html; omit to search every file),
 *   root (source folder, from --source for preview scans), ownership/platformOwned as for traceElement.
 * @returns {{ confidence: 'high'|'medium'|'ambiguous'|'untraceable', candidates: object[], reason: string|null }}
 *   `high`: one candidate by unique id or identical structure. `medium`: one clear winner by attributes + text +
 *   ancestry, or the only element with that tag. Same-looking repeats are `ambiguous` with every candidate, no
 *   `:nth-child` tie-break on purpose. Candidates: { file, line, col, method, score, evidence }.
 */
export function locateHtml(el = {}) {
  const untraceable = (reason) => ({ confidence: 'untraceable', candidates: [], reason });
  if (classifyOwnership(el) !== 'source') return untraceable(untraceableOwnerReason(el));
  const first = parseHtml(String(el.outerHTML || '')).roots[0];
  if (!first) return untraceable('no-element');
  const root = el.root || getProjectRoot();
  if (el.pageFile && !existsSync(path.join(root, el.pageFile))) return untraceable('page-source-missing');
  const rendered = {
    tag: first.tag,
    attrs: first.attrs,
    id: first.attrs.id || null,
    classes: (first.attrs.class || '').split(/\s+/).filter(Boolean),
    text: norm(el.text) || textOf(first),
    hash: hashOf(first),
    ancestors: selectorAncestors(el.selector),
  };

  const pool = (el.pageFile ? [el.pageFile] : htmlFiles(root)).flatMap((f) => indexHtmlFile(f, root));
  const scored = pool.map((src) => ({ src, s: score(src, rendered) })).filter((c) => c.s);
  const best = scored.filter((c) => c.s.total >= MIN_SCORE).sort((a, b) => b.s.total - a.s.total);
  const toCandidate = ({ src, s }) => ({
    file: src.file, line: src.line, col: src.col, method: s.evidence.includes('id') ? 'html-id' : s.evidence.includes('exact-structure') ? 'html-exact' : 'html-score',
    score: s.total, evidence: s.evidence,
  });

  if (best.length === 0) {
    // No evidence beyond the tag: only worth `medium` when that tag exists exactly once in scope.
    const sameTag = pool.filter((c) => c.tag === rendered.tag);
    const only = scored.length === 1 && sameTag.length === 1 ? scored[0] : null;
    return only ? { confidence: 'medium', candidates: [{ ...toCandidate(only), method: 'html-unique-tag' }], reason: null } : untraceable('no-match');
  }
  const tied = best.filter((c) => best[0].s.total - c.s.total < MARGIN);
  if (tied.length > 1) return { confidence: 'ambiguous', candidates: tied.map(toCandidate), reason: 'multiple-candidates' };
  const [win] = tied;
  const decisive = win.s.evidence.includes('id') || win.s.evidence.includes('exact-structure');
  return { confidence: decisive ? 'high' : 'medium', candidates: [toCandidate(win)], reason: null };
}

/** Plain HTML folders: parse with line/col, match by id, exact structure, then attribute + text + ancestry scoring. */
export const html = registerAdapter({
  id: 'html',
  detect: (root) => detectFramework(root).id === 'html',
  index: (root) => htmlFiles(root).flatMap((file) => indexHtmlFile(file, root).map(({ tag, line }) => ({ file, line, tagName: tag }))),
  locate: locateHtml,
  supports: { local: true, preview: true },
});
