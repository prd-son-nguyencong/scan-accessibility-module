// Shared helpers for Fixer adapters. A fixer is { name, mechanicallySafe, propose(task, context) }.
//   task    : an export task (src/fix/export/tasks.js JSON: rule, source {file,line}, element {selector,html}, evidence[], ids[]) plus an
//             optional harness `allowlist: [{file, startLine?, endLine?}]`.
//   context : { files: { [path]: { text } | string }, readonly?: { [path]: string }, siteLang?, previous?, gateEvidence? }
//             `files` holds the allowlisted files (read through readTaskContext); `readonly` is reference text (scripts, css) that may
//             be consulted but never edited.
//   result  : { files: [{ path, before, after }], rationale, confidence } or { declined: reason, detail? } (never throws for refusals).
import path from 'node:path';
import { resolveSecureSourceFile } from '../../candidate/path.js';
import { diffLines } from '../gates.js';

export const decline = (reason, detail) => ({ declined: reason, ...(detail ? { detail } : {}) });
export const isDeclined = (r) => !r || Boolean(r.declined);

export const ruleOf = (task) => String(task?.rule || '').toLowerCase().replace(/_/g, '-');
export const taskSource = (task) => ({ file: task?.source?.file ?? null, line: Number.isInteger(task?.source?.line) ? task.source.line : null });

export function fileText(context, p) {
  const f = context?.files?.[p];
  if (typeof f === 'string') return f;
  return typeof f?.text === 'string' ? f.text : null;
}

/** Edited file list is accepted only when every changed hunk (before-text line numbers) lies in an allowlist entry; no allowlist means no restriction here (G2 still decides). */
export function withinAllowlist(task, files) {
  const list = task?.allowlist;
  if (!Array.isArray(list)) return null;
  for (const f of files) {
    const entries = list.filter((e) => e.file === f.path);
    if (!entries.length) return `FILE_NOT_ALLOWLISTED:${f.path}`;
    if (f.before == null || f.after == null) {
      if (!entries.some((e) => e.startLine == null && e.endLine == null)) return `FILE_CREATED_OR_DELETED:${f.path}`;
      continue;
    }
    for (const h of diffLines(f.before, f.after)) {
      const a = h.aStart; const b = Math.max(h.aEnd, h.aStart); // a pure insertion sits at line aStart
      if (!entries.some((e) => (e.startLine == null || e.startLine <= a) && (e.endLine == null || e.endLine >= b))) return `LINES_NOT_ALLOWLISTED:${f.path}:${a}-${b}`;
    }
  }
  return null;
}

/** Final result builder: drops no-op edits, applies the allowlist check. */
export function finish(task, files, rationale, confidence = 0.9) {
  const changed = files.filter((f) => f.before !== f.after);
  if (!changed.length) return decline('NO_CHANGE');
  const bad = withinAllowlist(task, changed);
  if (bad) return decline('OUTSIDE_ALLOWLIST', bad);
  return { files: changed, rationale, confidence };
}

/** Reads the allowlisted files (and optional read-only reference files) of a task under `root`, through the secure path resolver. */
export function readTaskContext(root, task, { readonly = [], maxBytes = 262144, siteLang } = {}) {
  const files = {};
  const read = (rel) => resolveSecureSourceFile(root, rel, { maxBytes }).bytes.toString('utf8');
  const wanted = new Set([...(task.allowlist || []).map((e) => e.file), ...(task.source?.file ? [task.source.file] : [])]);
  for (const rel of wanted) files[rel] = { text: read(rel) };
  const ro = {};
  for (const rel of readonly) { try { ro[rel] = read(rel); } catch { /* optional reference file */ } }
  return { files, readonly: ro, ...(siteLang ? { siteLang } : {}) };
}

export const normalizeRel = (p) => path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '');
