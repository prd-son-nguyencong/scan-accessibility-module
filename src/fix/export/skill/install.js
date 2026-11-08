// Installs the fix skill bundle (the .md files next to this module) into a project for Cursor or Claude Code.
// Every installed file carries the ada-scan marker; foreign files are never overwritten, stale marked files are removed.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, ownership, writeOwned } from '../tasks.js';

export const SKILL_NAME = 'ada-scan-fix';
export const SKILL_DEST = { cursor: '.cursor/rules/ada-scan-fix-skill', claude: '.claude/skills/ada-scan-fix' };
export const SKILL_ENTRY = { cursor: `${SKILL_DEST.cursor}/skill.mdc`, claude: `${SKILL_DEST.claude}/SKILL.md` };
export const SKILL_SOURCE = path.dirname(fileURLToPath(import.meta.url));
const GLOBS = '**/*.liquid,**/*.css,**/*.js';
const NOTICE = `<!-- ${MARKER}: managed by ada-scan, regenerated; edits will be overwritten -->`;

/** Relative posix paths of the bundle's markdown files. */
export function bundleFiles(dir = SKILL_SOURCE) {
  const out = [];
  const go = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) go(path.join(d, e.name), `${prefix}${e.name}/`);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(`${prefix}${e.name}`);
    }
  };
  go(dir, '');
  return out;
}

/** Splits a leading `---` frontmatter block: { front: {name: value}, body }. */
export function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) front[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { front, body: text.slice(m[0].length) };
}

/** Map relative destination path -> file content for a target ('cursor' or 'claude'). */
export function renderBundle(target, dir = SKILL_SOURCE) {
  const names = bundleFiles(dir);
  const known = new Set(names);
  const out = new Map();
  for (const rel of names) {
    const { front, body } = splitFrontmatter(readFileSync(path.join(dir, rel), 'utf8'));
    if (target === 'claude') {
      out.set(rel, rel === 'SKILL.md' ? `---\nname: ${front.name}\ndescription: ${front.description}\n---\n${NOTICE}\n${body}` : `${NOTICE}\n${body}`);
      continue;
    }
    const heading = /^#\s+(.+)$/m.exec(body)?.[1] || rel;
    const description = rel === 'SKILL.md' ? front.description : `ada-scan fix skill: ${heading}`;
    const linked = body.replace(/\b((?:patterns\/)?[a-z][a-z-]*)\.md\b/g, (all, stem) => (known.has(`${stem}.md`) ? `${stem}.mdc` : all));
    out.set(rel === 'SKILL.md' ? 'skill.mdc' : rel.replace(/\.md$/, '.mdc'),
      `---\ndescription: ${JSON.stringify(description)}\nglobs: ${GLOBS}\nalwaysApply: false\n---\n${NOTICE}\n${linked}`);
  }
  return out;
}

/** True when `p` is absent or a real directory (a symlink or file in the way is refused). */
const realDirOrAbsent = (p) => { try { return lstatSync(p).isDirectory(); } catch { return true; } };

/**
 * Plans (and unless dryRun, performs) the install. Returns { dir, created, updated, unchanged, refused, removed } (relative names).
 * Unmarked files and symlinks are never written; marked files no longer in the bundle are removed.
 */
export function installSkill(target, root, { dryRun = false } = {}) {
  const dest = SKILL_DEST[target];
  if (!dest) return null;
  const dir = path.join(root, dest);
  const res = { dir, created: [], updated: [], unchanged: [], refused: [], removed: [] };
  const files = renderBundle(target);
  const blocked = (rel) => {
    let d = path.dirname(path.join(dir, rel));
    for (; d.length >= dir.length; d = path.dirname(d)) if (!realDirOrAbsent(d)) return true;
    return !realDirOrAbsent(path.join(root, path.dirname(dest)));
  };
  for (const [rel, content] of files) {
    const file = path.join(dir, rel);
    const own = blocked(rel) ? 'foreign' : ownership(file);
    if (own === 'foreign') { res.refused.push(rel); continue; }
    if (own === 'absent') res.created.push(rel);
    else if (readFileSync(file, 'utf8') === content) { res.unchanged.push(rel); continue; } else res.updated.push(rel);
    if (!dryRun) { mkdirSync(path.dirname(file), { recursive: true }); writeOwned(file, content); }
  }
  const walk = (d, prefix) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) { walk(path.join(d, e.name), `${rel}/`); continue; }
      if (!e.isFile() || files.has(rel)) continue;
      if (ownership(path.join(d, e.name)) === 'owned') { res.removed.push(rel); if (!dryRun) unlinkSync(path.join(d, e.name)); }
    }
    if (!dryRun && prefix) { try { rmdirSync(d); } catch { /* not empty */ } }
  };
  walk(dir, '');
  return res;
}

const EXCLUDE_PATTERNS = { cursor: ['.cursor/rules/ada-scan.mdc', '.cursor/rules/ada-scan-fix-skill/'], claude: ['.claude/ada-scan.md', '.claude/skills/ada-scan-fix/'] };

/**
 * The export writes agent rules into the project (the editor reads them there). Returns { written, patterns, tracked, advice }: the patterns that
 * git does not already ignore, for the maintainer's own `.git/info/exclude` (local, never committed). Nothing is written: git metadata is not ours.
 * null when the root is not a git work tree or the target has no rules.
 */
export function excludeAdvice(target, root) {
  const patterns = EXCLUDE_PATTERNS[target];
  if (!patterns) return null;
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return null; } catch { return null; }
  const open = patterns.filter((p) => { try { git('check-ignore', '-q', '--no-index', p.replace(/\/$/, '/x')); return false; } catch { return true; } });
  const advice = open.length ? `ada-scan wrote ${patterns.join(' and ')} into this project (the editor reads them there). They are not git-ignored: keep them out of commits with\n  printf '%s\\n' ${open.map((p) => `'${p}'`).join(' ')} >> "$(git rev-parse --git-path info/exclude)"\n(a local exclude, never committed), or delete them after the editor pass.` : null;
  return { written: patterns, patterns: open, advice };
}

/** One line that always says where the export wrote agent rules in the source tree (git-ignored or not, repo or not). null for a target without rules. */
export function writtenNotice(target, advice) {
  const patterns = EXCLUDE_PATTERNS[target];
  if (!patterns) return null;
  return `ada-scan wrote agent rules into the source tree: ${patterns.join(', ')}${advice ? (advice.patterns.length ? ' (not git-ignored, see below)' : ' (already git-ignored)') : ' (not a git work tree)'}.`;
}
