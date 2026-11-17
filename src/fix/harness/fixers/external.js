// External-tool fixer: converts the output of Cursor, Claude Code or any agent into the common candidate format.
// Inputs (one of): { diff } unified diff text, { diffFile }, { dir } a git working tree (git diff HEAD), { dir, baseDir } two directory trees.
// The tool runs elsewhere, on a scratch copy; this adapter only reads. Fail closed: a path outside the allowlist, a binary or mode or
// symlink change, a rename or a hunk that does not apply declines the WHOLE candidate (G2 would fail it anyway).
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseElement } from '../../export/recipes.js';
import { diffLines } from '../gates.js';
import { decline, fileText, finish, normalizeRel, withinAllowlist } from './common.js';

const MAX_FILES = 200; const MAX_BYTES = 2 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules']);

function safeRel(p) {
  const n = normalizeRel(p);
  return !n || n.startsWith('/') || n.split('/').includes('..') || /(^|\/)\.git(\/|$)/.test(n) || /^[a-zA-Z]:/.test(n) ? null : n;
}

/** Parses unified/git diff text into [{ path, oldPath, created, deleted, hunks:[{oldStart, lines:[{op,text}]}] }] or { error }. */
export function parseUnifiedDiff(text) {
  const rows = String(text).replace(/\r\n/g, '\n').split('\n');
  const files = []; let cur = null; let hunk = null;
  const strip = (p) => (p === '/dev/null' ? null : p.replace(/^[ab]\//, '').replace(/\t.*$/, ''));
  for (let i = 0; i < rows.length; i += 1) {
    const l = rows[i];
    if (l.startsWith('diff --git ')) { cur = { path: null, oldPath: null, created: false, deleted: false, hunks: [] }; files.push(cur); hunk = null; continue; }
    if (/^(GIT binary patch|Binary files )/.test(l)) return { error: 'BINARY_CHANGE' };
    if (/^(old mode|new mode|rename from|rename to|copy from|similarity index|new file mode 120000|deleted file mode 120000)/.test(l)) return { error: 'MODE_OR_RENAME_CHANGE' };
    if (/^--- /.test(l) && !hunk) { if (!cur) { cur = { path: null, oldPath: null, created: false, deleted: false, hunks: [] }; files.push(cur); } cur.oldPath = strip(l.slice(4)); continue; }
    if (/^\+\+\+ /.test(l) && !hunk) { cur.path = strip(l.slice(4)); continue; }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) { hunk = { oldStart: Number(h[1]), oldCount: h[2] == null ? 1 : Number(h[2]), lines: [] }; cur.hunks.push(hunk); continue; }
    if (hunk && /^[ +\-\\]/.test(l)) { if (l[0] !== '\\') hunk.lines.push({ op: l[0], text: l.slice(1) }); continue; }
    if (hunk && l === '' && i < rows.length - 1) { hunk.lines.push({ op: ' ', text: '' }); continue; }
    if (l && !/^(index |new file mode|deleted file mode)/.test(l)) hunk = null;
  }
  for (const f of files) {
    f.created = f.oldPath == null; f.deleted = f.path == null;
    if (f.created && f.path == null) return { error: 'MALFORMED_DIFF' };
    if (!f.created && !f.deleted && f.oldPath !== f.path) return { error: 'MODE_OR_RENAME_CHANGE' };
    if (!f.hunks.length && !f.deleted) return { error: 'MALFORMED_DIFF' };
  }
  return { files: files.filter((f) => f.path || f.oldPath) };
}

/**
 * Hunks are in HEAD line numbers, the shadow may already hold edits of tasks accepted earlier (a multi-hunk task is replayed in one go, so the
 * order is not strictly bottom up for its other hunks). Moves each hunk by the line count change of the HEAD to shadow edits entirely above it;
 * a hunk that overlaps such an edit keeps its coordinates and fails the exact match in applyHunks (fail closed).
 */
export function shiftHunks(hunks, headText, base) {
  if (!headText || base == null || headText === base) return hunks;
  const diff = diffLines(headText, base);
  return hunks.map((h) => {
    const at = h.oldCount === 0 ? h.oldStart : h.oldStart - 1; // lines before the hunk
    if (diff.some((d) => d.aStart <= at && d.aEnd > at)) return h;
    const delta = diff.filter((d) => d.aEnd <= at && d.aStart <= at).reduce((n, d) => n + (d.bEnd - d.bStart + 1) - (d.aEnd - d.aStart + 1), 0);
    return delta ? { ...h, oldStart: h.oldStart + delta } : h;
  });
}

/** Applies hunks to text; every context and removed line must match exactly. Returns text or null. */
export function applyHunks(before, hunks) {
  const src = before == null ? [] : before.split('\n');
  const out = []; let pos = 0;
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1 + (h.oldCount === 0 ? 1 : 0)) ;
    const at = h.oldCount === 0 && before == null ? 0 : start;
    if (at < pos) return null;
    out.push(...src.slice(pos, at)); pos = at;
    for (const l of h.lines) {
      if (l.op === '+') { out.push(l.text); continue; }
      if (src[pos] !== l.text) return null;
      if (l.op === ' ') out.push(l.text);
      pos += 1;
    }
  }
  out.push(...src.slice(pos));
  return out.join('\n');
}

function walk(root) {
  const out = new Map();
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) { out.set(path.relative(root, full).split(path.sep).join('/'), { link: true }); continue; }
      if (e.isDirectory()) go(full); else if (e.isFile()) { if (out.size >= MAX_FILES * 50) throw new Error('TOO_MANY_FILES'); out.set(path.relative(root, full).split(path.sep).join('/'), { full }); }
    }
  };
  go(root);
  return out;
}

const readText = (full) => { if (lstatSync(full).size > MAX_BYTES) return null; const b = readFileSync(full); return b.includes(0) ? null : b.toString('utf8'); };

/** Two-tree comparison (no diff parsing): changed, created and deleted text files. */
function compareDirs(baseDir, dir) {
  const a = walk(baseDir); const b = walk(dir); const files = [];
  for (const rel of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(rel); const y = b.get(rel);
    if (x?.link || y?.link) { if (x?.link !== y?.link || !x || !y) return { error: 'SYMLINK_CHANGE' }; continue; }
    const before = x ? readText(x.full) : null; const after = y ? readText(y.full) : null;
    if ((x && before == null) || (y && after == null)) { if (!x || !y || readFileSync(x.full).compare(readFileSync(y.full)) !== 0) return { error: 'BINARY_OR_OVERSIZE_CHANGE' }; continue; }
    if (before !== after) files.push({ path: rel, before, after });
  }
  return { files };
}

/**
 * @param {{ diff?: string, diffFile?: string, dir?: string, baseDir?: string, name?: string }} source
 * Reference text for a diff comes from context.files, else baseDir, else `git show HEAD:<path>` in dir.
 */
// A hunk is covered when its old-line span lies inside the entry; a pure insertion after line N sits at line N+1 (same rule as withinAllowlist).
const hunkSpan = (h) => (h.oldCount === 0 ? [h.oldStart + 1, h.oldStart + 1] : [h.oldStart, h.oldStart + h.oldCount - 1]);
const covers = (e, h) => { const [a, b] = hunkSpan(h); return (e.startLine == null || e.startLine <= a) && (e.endLine == null || e.endLine >= b); };

// `git diff HEAD` skips untracked files, but an editor's new file (a .liquid.json sidecar) is part of its edit: list it as a created file.
const TOOL_OWN = /^(?:\.ada-scan\/|\.cursor\/rules\/ada-scan|\.claude\/ada-scan\.md$|\.claude\/skills\/ada-scan-fix\/|scan-reports\/)/;
// Only files an editor adds as part of a template fix (a sidecar, a partial, a stylesheet, a script), not reports or scratch files.
const SOURCE_NEW = /^src\/.+\.(?:liquid|liquid\.json|css|js|mjs)$/;
function untrackedDiff(dir) {
  let names;
  try { names = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: MAX_BYTES }).split('\0').filter(Boolean); } catch { return ''; }
  let out = '';
  for (const rel of names.slice(0, MAX_FILES)) {
    const p = safeRel(rel);
    if (!p || TOOL_OWN.test(p) || !SOURCE_NEW.test(p)) continue;
    let text;
    try { text = readText(path.join(dir, rel)); } catch { continue; }
    if (text == null) continue;
    const rows = text.split('\n'); if (rows[rows.length - 1] === '') rows.pop();
    if (!rows.length) continue;
    out += `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${rows.length} @@\n${rows.map((r) => `+${r}`).join('\n')}\n`;
  }
  return out;
}

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (id) => new RegExp(`(?<![\\w-])${escRe(id)}(?![\\w-])`);

/** What a task says about its element: ids (element id, #id in selectors) and, for an id-less element, a tag plus distinguishing attribute values. */
function elementNeedles(task) {
  const el = parseElement(task.element?.html || '');
  const ids = new Set([el.attrs.id, ...[task.element?.selector, ...(task.occurrences || []).map((o) => o.selector)].flatMap((x) => [...String(x || '').replace(/\[[^\]]*\]/g, '').matchAll(/#([\w-]{3,})/g)].map((m) => m[1]))].filter((x) => x && x.length >= 3));
  const vals = Object.entries(el.attrs).filter(([k]) => k !== 'id' && k !== 'style').flatMap(([k, v]) => (k === 'class' ? v.split(/\s+/) : [v])).filter((v) => v && v.length >= 3 && !/^(true|false)$/i.test(v));
  return { ids: [...ids], tag: el.tag, vals };
}
/** HEAD line (1-based) of the closing tag that balances the `<tag` opened on `openLine`, or null. Nesting of the same tag name is counted. */
function closeLineOf(lines, openLine, tag) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])`, 'gi'); let depth = 0;
  for (let i = openLine - 1; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(re)) { depth += m[1] ? -1 : 1; if (depth <= 0) return i + 1; }
  }
  return null;
}
/** [first, last] HEAD lines of the top-level statement (column 0 start, up to its column 0 closer) that contains `line` in a script or stylesheet, or null. */
function topLevelBlock(lines, line) {
  let a = Math.min(line, lines.length);
  if (a < 1) return null;
  while (a > 1 && (lines[a - 1] === '' || /^\s/.test(lines[a - 1]))) a -= 1;
  let z = a;
  for (let i = a; i < lines.length; i += 1) {
    if (/^[})\]]/.test(lines[i])) { z = i + 1; break; }
    if (lines[i] !== '' && !/^\s/.test(lines[i])) break;
    z = i + 1;
  }
  return line >= a && line <= z ? [a, z] : null;
}
const mentions = (n, text) => n.ids.some((id) => word(id).test(text)) || (Boolean(n.tag) && new RegExp(`<${n.tag}(?=[\\s>/])`, 'i').test(text) && n.vals.some((v) => text.includes(v)));

/**
 * Working-tree mode: one combined diff (`git diff HEAD --unified=0` of source.dir, e.g. everything an editor agent changed) is split per task.
 * Ownership (hunk coordinates are HEAD lines): 1. the element of a task (id, or tag plus attribute values) appears in the hunk, then in the lines
 * around it, among the tasks that name the file (the reported line may be a few lines off, so the line range is not required); 2. otherwise the
 * task whose allowlist covers the hunk and whose source line is nearest; a task without a line (whole-file scope) claims only when it is alone.
 * Hunks nobody claims are listed by `unassigned()`. Base text is the current shadow (context.read), so tasks accepted earlier in the same file are
 * already applied (the harness runs a file's tasks bottom up: `retarget` moves each task's source line onto its hunk so that order holds).
 */
export function createWorkingTreeFixer({ dir, name = 'working-tree', tasks = [] } = {}) {
  let parsed = null; const claimed = new Set(); let all = tasks; let owners = null;
  // Allowlist entries of a task; a task with no source line that names files (locate manually) says so for the whole file.
  const scopeOf = (t) => (t.allowlist?.length ? t.allowlist : (t.locateFiles || []).map((file) => ({ file })));
  const headLines = (p) => { try { return execFileSync('git', ['-C', dir, 'show', `HEAD:${p}`], { encoding: 'utf8', maxBuffer: MAX_BYTES * 2 }).split('\n'); } catch { return []; } };
  // Ranking among tasks that could own a hunk: the element named in the hunk first, then the smaller scope (an explicit line range or enclosing block
  // beats a whole-file entry), then the traced line nearest to the hunk (only a line in this very file counts), then the task order (never the id string).
  const SCRIPTY = /\.(?:m?js|css)$/;
  const BLOCK_CAP = 120;
  const blockOf = (t, p, lines) => (t.source?.file === p && t.source.line > 0 && SCRIPTY.test(p) ? topLevelBlock(lines, t.source.line) : null);
  const inBlock = (t, p, h, lines) => { const b = blockOf(t, p, lines); const [x, y] = hunkSpan(h); return Boolean(b && b[0] <= x && y <= b[1] && b[1] - b[0] < BLOCK_CAP); };
  const explicit = (t, p, h) => scopeOf(t).some((e) => e.file === p && e.startLine != null && covers(e, h));
  const ownerOf = (p, h, lines) => {
    const scoped = all.filter((t) => scopeOf(t).some((e) => e.file === p));
    const size = (t) => Math.min(1e9, ...scopeOf(t).filter((e) => e.file === p && e.startLine != null && covers(e, h)).map((e) => e.endLine - e.startLine + 1), ...[blockOf(t, p, lines)].filter((b) => b && inBlock(t, p, h, lines)).map((b) => b[1] - b[0] + 1));
    const dist = (t) => (t.source?.file === p && t.source.line != null ? Math.abs(t.source.line - h.oldStart) : 1e9);
    const own = h.lines.map((l) => l.text).join('\n');
    const around = lines.slice(Math.max(0, h.oldStart - 3), h.oldStart + h.oldCount + 2).join('\n');
    const named = (t) => (mentions(elementNeedles(t), own) || mentions(elementNeedles(t), around) ? 0 : 1);
    const pick = (list) => [...list].sort((a, b) => named(a) - named(b) || size(a) - size(b) || dist(a) - dist(b))[0].id;
    for (const text of [own, around]) {
      const hit = scoped.filter((t) => mentions(elementNeedles(t), text));
      if (hit.length) return pick(hit);
    }
    // inside the explicit line range of a task, or inside the top-level block of a script or stylesheet its traced line sits in
    const inside = scoped.filter((t) => explicit(t, p, h) || inBlock(t, p, h, lines));
    if (inside.length) return pick(inside);
    const covering = scoped.filter((t) => scopeOf(t).some((e) => e.file === p && covers(e, h)));
    const lined = covering.filter((t) => t.source?.file === p && t.source.line != null);
    if (lined.length) return pick(lined);
    if (covering.length === 1) return covering[0].id;
    return renderedBy(p, h);
  };
  // A task traced to a script or stylesheet names no template, yet its fix belongs in the template or component that renders the element:
  // a .liquid hunk whose removed lines carry that element's id, or its tag plus two distinguishing attribute values, belongs to it when exactly one such task matches.
  const renderedBy = (p, h) => {
    if (!/\.liquid$/.test(p)) return null;
    const old = h.lines.filter((l) => l.op === '-').map((l) => l.text).join('\n');
    const hit = all.filter((t) => t.source?.file && !/\.liquid$/.test(t.source.file) && !scopeOf(t).some((e) => e.file === p)).filter((t) => {
      const n = elementNeedles(t);
      return n.ids.some((id) => new RegExp(`\\bid\\s*=\\s*["']?${escRe(id)}(?![\\w-])`, 'i').test(old)) || (Boolean(n.tag) && new RegExp(`<${n.tag}(?=[\\s>/])`, 'i').test(old) && n.vals.filter((v) => old.includes(v)).length >= 2);
    });
    return hit.length === 1 ? hit[0].id : null;
  };
  const ownerMap = () => {
    if (owners) return owners;
    owners = new Map();
    const r = load(); if (r.error) return owners;
    for (const f of r.files) {
      const p = safeRel(f.path || f.oldPath);
      if (!p || f.created || f.deleted) continue;
      const lines = headLines(p);
      const hunks = [...f.hunks].sort((a, b) => a.oldStart - b.oldStart);
      for (const h of hunks) { const id = ownerOf(p, h, lines); if (id != null) owners.set(`${p}:${h.oldStart}`, id); }
      // The closing tag of an element whose opener a task rewrote (a to button) is far below the opener hunk: it follows the opener's owner,
      // but only when it is the closing tag that balances that very opener in HEAD (an unrelated later `</a>` hunk stays unowned).
      for (const h of hunks) {
        if (owners.has(`${p}:${h.oldStart}`)) continue;
        const text = h.lines.filter((l) => l.op === '-').map((l) => l.text).join('\n');
        for (const q of hunks.filter((x) => x.oldStart < h.oldStart && owners.has(`${p}:${x.oldStart}`)).reverse()) {
          const t = all.find((x) => x.id === owners.get(`${p}:${q.oldStart}`)); const tag = t && elementNeedles(t).tag;
          if (!tag || !new RegExp(`</${tag}\\s*>`, 'i').test(text)) continue;
          let n = q.oldStart - 1, open = null;
          for (const l of q.lines) { if (l.op === ' ') continue; if (l.op === '-') { n += 1; if (open == null && new RegExp(`<${tag}(?=[\\s>/])`, 'i').test(l.text)) open = n; } }
          const end = open == null ? null : closeLineOf(lines, open, tag);
          if (end != null && end >= h.oldStart && end < h.oldStart + h.oldCount) { owners.set(`${p}:${h.oldStart}`, t.id); break; }
        }
      }
    }
    return owners;
  };
  const load = () => {
    if (parsed) return parsed;
    const tracked = execFileSync('git', ['-C', dir, 'diff', 'HEAD', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', '--binary'], { encoding: 'utf8', maxBuffer: MAX_BYTES * 8 });
    const text = tracked + (tracked && !tracked.endsWith('\n') ? '\n' : '') + untrackedDiff(dir);
    parsed = text.trim() ? parseUnifiedDiff(text) : { files: [] };
    return parsed;
  };
  return {
    name, mechanicallySafe: false, noRepair: true,
    setTasks(list) { all = list; owners = null; },
    /** Raw tasks (for runHarness) with the source line moved onto the hunk the task owns and the allowlist widened to it; untraced tasks get their whole-file scope. */
    retarget(raw) {
      const own = ownerMap(); const r = load();
      return raw.map((t) => {
        const n = all.find((x) => x.id === String(t.id)); if (!n) return t;
        const entries = [...scopeOf(n)]; let source = n.source; const owned = [];
        for (const f of r.error ? [] : r.files) {
          const p = safeRel(f.path || f.oldPath);
          for (const h of f.hunks) {
            if (own.get(`${p}:${h.oldStart}`) !== n.id) continue;
            const [a, b] = hunkSpan(h);
            if (!entries.some((e) => e.file === p && covers(e, h))) entries.push({ file: p, startLine: a, endLine: b });
            owned.push({ p, h });
          }
        }
        // One line stands for a task that owns several hunks: the hunk that holds its element, else the first. Never the last (the harness replays all of them anyway).
        const file = source ? source.file : owned[0]?.p;
        const here = owned.filter((x) => x.p === file).sort((x, y) => x.h.oldStart - y.h.oldStart);
        const pick = here.find((x) => mentions(elementNeedles(n), x.h.lines.map((l) => l.text).join('\n'))) || here[0];
        if (pick) source = { file: pick.p, line: pick.h.oldStart };
        return { ...t, allowlist: entries, ...(source ? { source } : {}) };
      });
    },
    changedPaths() { const r = load(); return r.error ? [] : r.files.map((f) => safeRel(f.path || f.oldPath)).filter(Boolean); },
    unassigned() {
      const r = load(); if (r.error) return [{ path: null, reason: r.error }];
      const own = ownerMap();
      return r.files.flatMap((f) => f.hunks.filter((h) => !claimed.has(`${f.path}:${h.oldStart}`)).map((h) => {
        const p = safeRel(f.path || f.oldPath); const ownedBy = own.get(`${p}:${h.oldStart}`);
        return { path: p, line: h.oldCount === 0 ? h.oldStart + 1 : h.oldStart, ...(f.created ? { reason: 'new file: never replayed, not verified' } : {}), ...(ownedBy != null ? { ownedBy } : {}) };
      }));
    },
    async propose(task, context = {}) {
      let r;
      try { r = load(); } catch (error) { return decline('EXTERNAL_READ_FAILED', String(error.message || error).slice(0, 200)); }
      if (r.error) return decline(r.error);
      const own = all.length ? ownerMap() : null;
      const files = [];
      for (const f of r.files) {
        const p = safeRel(f.path || f.oldPath);
        if (!p) return decline('PATH_REJECTED', String(f.path || f.oldPath));
        const entries = (task.allowlist || []).filter((e) => e.file === p);
        if (!entries.length || f.created || f.deleted) continue; // created and deleted files are never assigned to a task: they stay unassigned
        const mine = f.hunks.filter((h) => (own ? own.get(`${p}:${h.oldStart}`) === task.id : entries.some((e) => covers(e, h))));
        if (!mine.length) continue;
        let base; try { base = context.read(p); } catch { return decline('BASE_TEXT_UNAVAILABLE', p); }
        const after = applyHunks(base, shiftHunks(mine, headLines(p).join('\n'), base));
        if (after == null) return decline('HUNK_DOES_NOT_APPLY', p);
        for (const h of mine) claimed.add(`${f.path}:${h.oldStart}`);
        files.push({ path: p, before: base, after });
      }
      if (!files.length) return decline('NO_CHANGE_FOR_TASK', 'no hunk of the working-tree diff belongs to this task (element not found in any changed hunk, none in its scope)');
      const bad = withinAllowlist(task, files); if (bad) return decline('OUTSIDE_ALLOWLIST', bad);
      return finish(task, files, `edits made in the working tree by an editor agent; verified only by the harness gates`, 0.4);
    },
  };
}

export function createExternalFixer(source = {}) {
  return {
    name: source.name || 'external',
    mechanicallySafe: false,
    async propose(task, context = {}) {
      let files;
      try {
        if (source.dir && source.baseDir && source.diff == null && !source.diffFile) {
          const r = compareDirs(source.baseDir, source.dir);
          if (r.error) return decline(r.error);
          files = r.files;
        } else {
          const text = source.diff ?? (source.diffFile ? readFileSync(source.diffFile, 'utf8') : source.dir ? execFileSync('git', ['-C', source.dir, 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '--binary'], { encoding: 'utf8', maxBuffer: 8 * MAX_BYTES }) : null);
          if (text == null) return decline('NO_DIFF_SOURCE');
          if (!text.trim()) return decline('EMPTY_DIFF');
          const parsed = parseUnifiedDiff(text);
          if (parsed.error) return decline(parsed.error);
          files = [];
          for (const f of parsed.files) {
            const p = safeRel(f.path || f.oldPath);
            if (!p) return decline('PATH_REJECTED', String(f.path || f.oldPath));
            const base = f.created ? null : (fileText(context, p) ?? (source.baseDir ? (() => { try { return readText(path.join(source.baseDir, p)); } catch { return null; } })() : null)
              ?? (source.dir ? (() => { try { return execFileSync('git', ['-C', source.dir, 'show', `HEAD:${p}`], { encoding: 'utf8' }); } catch { return null; } })() : null));
            if (!f.created && base == null) return decline('BASE_TEXT_UNAVAILABLE', p);
            let after = f.deleted ? null : applyHunks(base, f.hunks);
            if (f.created && after != null && !after.endsWith('\n')) after += '\n';
            if (!f.deleted && after == null) return decline('HUNK_DOES_NOT_APPLY', p);
            files.push({ path: p, before: base, after });
          }
        }
      } catch (error) {
        return decline(error.code || 'EXTERNAL_READ_FAILED', String(error.message || error).slice(0, 200));
      }
      files = files.map((f) => ({ ...f, path: safeRel(f.path) })).filter((f) => f.path || false);
      if (!files.length) return decline('EMPTY_DIFF');
      if (Array.isArray(task?.allowlist)) { const bad = withinAllowlist(task, files); if (bad) return decline('OUTSIDE_ALLOWLIST', bad); }
      return finish(task, files, `changes produced by ${source.name || 'an external tool'}; verified only by the harness gates`, 0.4);
    },
  };
}
