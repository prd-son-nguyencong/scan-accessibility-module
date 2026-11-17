// `ada-scan fix --verify`: checks the working tree diff (git, against HEAD) against the fix export.
// Violations: a changed file no task named, a dist/ or generated file, a changed data-tag multiset, a changed colour declaration.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { diffMultisets, extractBackendTokens, extractDesignTokens } from '../../harness/tokens.js';
import { MARKER, ownership } from '../tasks.js';

const TEXT_EXT = /\.(?:html?|liquid|css|js|mjs|svg|json)$/i;
const STYLE_EXT = /\.(?:html?|liquid|css|svg)$/i;
const GENERATED = [/^dist\//, /(^|\/)paradox-export\.json$/, /(^|\/)\+\.css$/];
// Files this tool or the project's reports own: not part of the fix.
const OWN = [/^\.ada-scan\//, /^\.cursor\/rules\/ada-scan/, /^\.claude\/ada-scan\.md$/, /^\.claude\/skills\/ada-scan-fix\//];
const SCRIPT_REF = /src\/scripts\/[\w./-]+\.(?:js|mjs|ts)/g;
const norm = (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '');

const git = (root, args) => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { throw new Error(`git failed in ${root}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
};

/** Task objects from <tasksDir>/*.json (single task files and per-file groups). */
export function readExportedTasks(tasksDir) {
  if (!existsSync(tasksDir)) return null;
  const out = [];
  for (const name of readdirSync(tasksDir).filter((n) => n.endsWith('.json')).sort()) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(tasksDir, name), 'utf8')); } catch { continue; }
    if (j.generator !== MARKER) continue;
    out.push(...(Array.isArray(j.tasks) ? j.tasks : [j]));
  }
  return out;
}

/** Files a task set allows editing, and the files named by design-locked tasks. Sidecars of allowed .liquid files are allowed. */
export function allowedFiles(tasks) {
  const allowed = new Set(), locked = new Set();
  for (const t of tasks) {
    const files = [t.source?.file, t.proposedChange?.file, ...(t.locateManually?.candidates || []).map((c) => c.file), ...(t.locateManually?.likely || []).map((l) => l.file),
      ...(JSON.stringify([t.evidence, t.fix?.cautions]).match(SCRIPT_REF) || [])].filter(Boolean).map(norm);
    for (const f of files) {
      (t.requiresDesignDecision ? locked : allowed).add(f);
      if (!t.requiresDesignDecision && f.endsWith('.liquid')) allowed.add(`${f}.json`);
    }
  }
  return { allowed, locked };
}

/** Changed paths relative to root: [{ file, status: 'M'|'A'|'D' }], tracked changes against HEAD plus untracked files. */
export function changedFiles(root) {
  const rows = new Map();
  const tracked = git(root, ['diff', '--name-status', '--no-renames', '--relative', '-z', 'HEAD']).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < tracked.length; i += 2) rows.set(norm(tracked[i + 1]), tracked[i][0]);
  for (const f of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) rows.set(norm(f), 'A');
  return [...rows].map(([file, status]) => ({ file, status })).sort((a, b) => a.file.localeCompare(b.file));
}

const headText = (root, file) => { try { return git(root, ['show', `HEAD:./${file}`]); } catch { return ''; } };
const nowText = (root, file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch { return ''; } };

/**
 * @param {{root:string, tasks:object[]}} o
 * @returns {{rows:{file:string,status:string,result:'ok'|'warn'|'violation',detail:string}[], violations:number, warnings:number}}
 */
export function verifyDiff({ root, tasks }) {
  const { allowed, locked } = allowedFiles(tasks);
  const rows = [];
  for (const { file, status } of changedFiles(root)) {
    if (OWN.some((re) => re.test(file)) || (status !== 'D' && ownership(path.join(root, file)) === 'owned')) continue;
    const problems = [], notes = [];
    if (GENERATED.some((re) => re.test(file))) problems.push('generated or built output must not be edited');
    else if (!allowed.has(file)) problems.push(locked.has(file) ? 'file belongs to a design-locked task only' : 'no task names this file');
    if (TEXT_EXT.test(file)) {
      const [before, after] = [headText(root, file), status === 'D' ? '' : nowText(root, file)];
      const tags = diffMultisets(extractBackendTokens(before), extractBackendTokens(after));
      // Removing or editing an existing tag breaks the platform binding; adding one (a title bound to {{attribute:..}}) is allowed but worth a look.
      if (tags.removed.length) problems.push(`data tags changed (removed ${tags.removed.length}, added ${tags.added.length}): ${[...tags.removed.map((t) => `-${t}`), ...tags.added.map((t) => `+${t}`)].slice(0, 3).join(' ')}`);
      else if (tags.added.length) notes.push(`data tags added (${tags.added.length}): ${tags.added.slice(0, 3).map((t) => `+${t}`).join(' ')}; check the platform has them`);
      if (STYLE_EXT.test(file)) {
        const d = diffMultisets(extractDesignTokens(before), extractDesignTokens(after));
        if (d.removed.length || (d.added.length && locked.has(file))) problems.push(`colour declarations changed (removed ${d.removed.length}, added ${d.added.length}): ${[...d.removed.map((t) => `-${t}`), ...d.added.map((t) => `+${t}`)].slice(0, 3).join(' ')}`);
        else if (d.added.length) notes.push(`colour declarations added (${d.added.length}): check with the design owner`);
      }
    }
    rows.push({ file, status, result: problems.length ? 'violation' : notes.length ? 'warn' : 'ok', detail: [...problems, ...notes].join('; ') });
  }
  return { rows, violations: rows.filter((r) => r.result === 'violation').length, warnings: rows.filter((r) => r.result === 'warn').length };
}

export function renderVerifyTable(res) {
  if (!res.rows.length) return 'No changed files to check.';
  const w = Math.max(4, ...res.rows.map((r) => r.file.length));
  return [`${'FILE'.padEnd(w)}  STATUS  RESULT     DETAIL`, ...res.rows.map((r) => `${r.file.padEnd(w)}  ${r.status.padEnd(6)}  ${r.result.padEnd(9)}  ${r.detail}`),
    `${res.violations} violation(s), ${res.warnings} warning(s)`].join('\n');
}
