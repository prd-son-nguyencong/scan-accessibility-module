// Turns whole-file changes ({ path, before, after }) into candidate edit intents and unified diffs. Pure, plus preimage hashing.
import { buildSourcePreimage, buildSourcePreimageRange } from '../../tracer/preimage.js';
import { applyEditsToBytes, resolveEditByteOffsets } from '../candidate/bytes.js';
import { hashFileContent } from '../candidate/intent.js';
import { diffLines } from './gates.js';

export class ChangeError extends Error {
  constructor(code, message) { super(message); this.name = 'ChangeError'; this.code = code; }
}

const trimEnd = (s) => s.replace(/[ \t]+$/, '');

/** Changed line count of a before/after pair: per hunk the larger of removed and added lines. */
export function changedLineCount(before, after) {
  return diffLines(before, after).reduce((n, h) => n + Math.max(h.aEnd - h.aStart + 1, h.bEnd - h.bStart + 1), 0);
}

/**
 * Edit intents (src/fix/candidate format) for one file. Each hunk gets one context line (before it, or after it at the top of the file) so
 * pure insertions and deletions have a non-empty oldText; hunks whose widened ranges overlap are merged. `before` must be the exact
 * current file text. LF files only: a CR in either text throws (the edit model hashes normalised lines).
 */
export function fileToEdits(file, before, after) {
  if (before.includes('\r') || after.includes('\r')) throw new ChangeError('CRLF_UNSUPPORTED', `${file}: CRLF line endings are not supported`);
  if (before === after) return [];
  const bl = before.split('\n'), al = after.split('\n');
  const groups = [];
  const clean = (n) => n >= 1 && n <= bl.length && bl[n - 1] === trimEnd(bl[n - 1]); // a context line with trailing blanks cannot sit inside an edit (oldText is trimmed, the file is not)
  for (const h of diffLines(before, after)) {
    let s = h.aStart, e = h.aEnd;
    if (s === 1) e = Math.max(e, Math.min(1, bl.length));
    else if (clean(s - 1)) s -= 1;
    else if (!bl.slice(h.aStart - 1, h.aEnd).some(trimEnd)) { // nothing of its own to anchor on: use the line below
      if (!clean(h.aEnd + 1) || !trimEnd(bl[h.aEnd])) throw new ChangeError('PREIMAGE_UNAVAILABLE', `${file}: no usable context line next to line ${h.aStart}`);
      e = h.aEnd + 1;
    }
    if (e < s || !bl.length || (bl.length === 1 && !bl[0])) throw new ChangeError('EMPTY_PREIMAGE', `${file}: cannot anchor an edit in an empty file`);
    const last = groups.at(-1);
    if (last && s <= last.e) { last.e = Math.max(last.e, e); last.hunks.push(h); } else groups.push({ s, e, hunks: [h] });
  }
  const edits = groups.map(({ s, e, hunks }) => {
    const out = [];
    let cur = s;
    for (const h of hunks) {
      for (; cur < h.aStart && cur <= e; cur++) out.push(trimEnd(bl[cur - 1]));
      out.push(...al.slice(h.bStart - 1, h.bEnd));
      cur = Math.max(cur, h.aEnd + 1);
    }
    for (; cur <= e; cur++) out.push(trimEnd(bl[cur - 1]));
    const oldText = bl.slice(s - 1, e).map(trimEnd).join('\n');
    const pre = s === e ? buildSourcePreimage(before, s) : buildSourcePreimageRange(before, s, e);
    if (!pre) throw new ChangeError('PREIMAGE_UNAVAILABLE', `${file}: no preimage for lines ${s}-${e}`);
    return { file, blockRange: { startLine: s, endLine: e }, expectedBlockSha256: pre.preimageSha256, expectedFileSha256: hashFileContent(before), oldText, newText: out.join('\n') };
  });
  // The edit model trims line ends when it locates oldText: the applied bytes must still equal `after` (the text the gates verify), else refuse.
  let applied = null;
  try {
    const bytes = Buffer.from(before, 'utf8');
    applied = applyEditsToBytes(bytes, edits.map((x) => ({ ...x, ...resolveEditByteOffsets(bytes, x.oldText, x.blockRange.startLine, x.blockRange.endLine) }))).toString('utf8');
  } catch { /* the candidate validator reports it with its own code */ }
  if (applied != null && applied !== after) throw new ChangeError('WHITESPACE_MISMATCH', `${file}: the edit would not reproduce the verified text (whitespace-only or trailing-blank lines at the change)`);
  return edits;
}

/** Unified diff (2 context lines) of several files, deterministic order. files: [{ path, before, after }]. */
export function unifiedDiff(files, context = 2) {
  const out = [];
  for (const { path, before, after } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (before === after) continue;
    const bl = before.split('\n'), al = after.split('\n');
    out.push(`--- a/${path}`, `+++ b/${path}`);
    let offset = 0;
    // Hunks whose context windows touch or overlap are one hunk, so no @@ block describes a state that never existed.
    const groups = [];
    for (const h of diffLines(before, after)) {
      const g = groups[groups.length - 1];
      if (g && h.aStart - context <= g[g.length - 1].aEnd + context + 1) g.push(h); else groups.push([h]);
    }
    for (const g of groups) {
      const first = g[0], last = g[g.length - 1];
      const s = Math.max(1, first.aStart - context), e = Math.min(bl.length, last.aEnd + context);
      const body = [];
      for (let i = s; i < first.aStart; i++) body.push(` ${bl[i - 1]}`);
      g.forEach((h, k) => {
        for (let i = h.aStart; i <= h.aEnd; i++) body.push(`-${bl[i - 1]}`);
        for (let i = h.bStart; i <= h.bEnd; i++) body.push(`+${al[i - 1]}`);
        const next = g[k + 1]?.aStart ?? last.aEnd + context + 1;
        for (let i = h.aEnd + 1; i < next && i <= e; i++) body.push(` ${bl[i - 1]}`);
      });
      const removed = g.reduce((n, h) => n + h.aEnd - h.aStart + 1, 0), added = g.reduce((n, h) => n + h.bEnd - h.bStart + 1, 0);
      const oldLen = e - s + 1, newLen = oldLen - removed + added;
      out.push(`@@ -${s},${oldLen} +${s + offset},${newLen} @@`, ...body);
      offset += added - removed;
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
