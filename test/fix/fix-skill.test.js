import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFixSubcommand } from '../../src/index.js';
import { MARKER } from '../../src/fix/export/tasks.js';
import { SKILL_DEST, SKILL_SOURCE, bundleFiles, installSkill, renderBundle, splitFrontmatter } from '../../src/fix/export/skill/install.js';
import { checkCoverage } from '../../src/fix/export/skill/coverage.js';
import { verifyDiff } from '../../src/fix/export/skill/diff-check.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), `ada-skill-${p}-`));
const walk = (d, p = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`])).sort();
const headLines = (f) => readFileSync(f, 'utf8').split('\n', 8);

test('bundle has the required files and one pattern file per topic', () => {
  const names = bundleFiles();
  for (const f of ['SKILL.md', 'workflow.md', 'paradox-liquid-rules.md', 'no-break-guardrails.md', 'design-locked.md', 'when-to-ask-a-human.md']) assert.ok(names.includes(f), f);
  const patterns = names.filter((n) => n.startsWith('patterns/')).map((n) => n.slice(9, -3));
  for (const p of ['button-name', 'link-name', 'image-alt', 'form-labels', 'landmarks-navs', 'skip-link', 'headings', 'disclosure', 'dialogs-focus', 'tabs', 'carousels', 'target-size', 'focus-visible', 'label-in-name', 'language', 'reflow', 'role-button-keyboard']) assert.ok(patterns.includes(p), p);
});

test('cursor install: .mdc files with valid frontmatter and a marker, links point to .mdc', () => {
  const root = tmp('cur');
  const res = installSkill('cursor', root);
  const dir = path.join(root, SKILL_DEST.cursor);
  assert.equal(res.created.length, bundleFiles().length);
  const files = walk(dir);
  assert.ok(files.includes('skill.mdc') && files.includes('patterns/disclosure.mdc') && files.every((f) => f.endsWith('.mdc')));
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    const m = /^---\ndescription: (".*")\nglobs: (.+)\nalwaysApply: false\n---\n/.exec(text);
    assert.ok(m, `${f} frontmatter`);
    assert.ok(typeof JSON.parse(m[1]) === 'string' && JSON.parse(m[1]).length > 10);
    assert.equal(m[2], '**/*.liquid,**/*.css,**/*.js');
    assert.ok(headLines(path.join(dir, f)).some((l) => l.includes(MARKER)), `${f} marker`);
    assert.ok(!/\b[a-z-]+\.md\b/.test(text.replace(/tasks\/INDEX\.md|INDEX\.md|CLAUDE\.md/g, '')), `${f} has a stale .md link`);
  }
  assert.match(readFileSync(path.join(dir, 'skill.mdc'), 'utf8'), /patterns\/button-name\.mdc/);
});

test('claude install: .claude/skills/ada-scan-fix with SKILL.md frontmatter name and description', () => {
  const root = tmp('cl');
  installSkill('claude', root);
  const dir = path.join(root, SKILL_DEST.claude);
  assert.deepEqual(walk(dir), bundleFiles().sort());
  const { front } = splitFrontmatter(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  assert.equal(front.name, 'ada-scan-fix');
  assert.match(front.description, /fix accessibility findings from ada-scan/);
  assert.match(front.description, /apply ada-scan tasks/);
  assert.ok(!front.description.includes(': '), 'plain YAML scalar must not hold ": "');
  assert.ok(headLines(path.join(dir, 'SKILL.md')).some((l) => l.includes(MARKER)));
  assert.equal(installSkill('generic', root), null);
});

test('install is idempotent, dry-run writes nothing, foreign files and symlinked dirs are never overwritten, stale marked files are removed', () => {
  const root = tmp('idem');
  assert.equal(installSkill('claude', root, { dryRun: true }).created.length, bundleFiles().length);
  assert.ok(!existsSync(path.join(root, '.claude')));
  installSkill('claude', root);
  const dir = path.join(root, SKILL_DEST.claude);
  const again = installSkill('claude', root);
  assert.equal(again.unchanged.length, bundleFiles().length);
  assert.deepEqual([again.created, again.updated, again.removed, again.refused], [[], [], [], []]);
  // foreign file in the way
  writeFileSync(path.join(dir, 'workflow.md'), 'my own workflow\n');
  writeFileSync(path.join(dir, 'mine.md'), 'keep me\n');
  mkdirSync(path.join(dir, 'patterns'), { recursive: true });
  writeFileSync(path.join(dir, 'patterns/old.md'), `<!-- ${MARKER} -->\nstale\n`);
  writeFileSync(path.join(dir, 'gone.md'), `<!-- ${MARKER} -->\nstale\n`);
  const r = installSkill('claude', root);
  assert.deepEqual(r.refused, ['workflow.md']);
  assert.deepEqual(r.removed.sort(), ['gone.md', 'patterns/old.md']);
  assert.equal(readFileSync(path.join(dir, 'workflow.md'), 'utf8'), 'my own workflow\n');
  assert.equal(readFileSync(path.join(dir, 'mine.md'), 'utf8'), 'keep me\n');
  assert.ok(!existsSync(path.join(dir, 'gone.md')) && !existsSync(path.join(dir, 'patterns/old.md')));
  // a symlinked skill folder is refused entirely
  const root2 = tmp('sym');
  const elsewhere = tmp('else');
  mkdirSync(path.join(root2, '.claude/skills'), { recursive: true });
  symlinkSync(elsewhere, path.join(root2, SKILL_DEST.claude));
  const s = installSkill('claude', root2);
  assert.equal(s.refused.length, bundleFiles().length);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(lstatSync(path.join(root2, SKILL_DEST.claude)).isSymbolicLink());
});

test('fix --export --target claude installs the skill and the rules file points to it; cursor likewise', async () => {
  for (const [target, entry] of [['claude', '.claude/skills/ada-scan-fix/SKILL.md'], ['cursor', '.cursor/rules/ada-scan-fix-skill/skill.mdc']]) {
    const root = tmp(`cli-${target}`);
    const out = path.join(root, '.ada-scan');
    mkdirSync(out);
    const rep = path.join(out, 'report.json');
    const { buildScanReportV2 } = await import('../../src/reporter/report-v2.js');
    writeFileSync(rep, JSON.stringify(buildScanReportV2([{ name: '/', page: '/', url: 'https://site-001.example.test/', scannerRuns: [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }], violations: [] }], { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://site-001.example.test/' } })));
    const log = console.log;
    console.log = () => {};
    try { await runFixSubcommand(['--export', '--report', rep, '--source', root, '--out-dir', out, '--target', target]); } finally { console.log = log; }
    assert.ok(existsSync(path.join(root, entry)), entry);
    const rules = readFileSync(path.join(root, target === 'claude' ? '.claude/ada-scan.md' : '.cursor/rules/ada-scan.mdc'), 'utf8');
    assert.ok(rules.includes(entry));
    assert.match(rules, /ada-scan fix --verify/);
  }
});

// ---- fix --verify

function repo() {
  const root = tmp('git');
  const g = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' });
  g('init', '-q');
  const w = (f, t) => { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), t); };
  w('src/partials/home/hero.liquid', '<img src="{{data:hero.image}}" class="a text-white" data-pdk-id="h1">\n{{component:cta}}\n');
  w('src/partials/home/hero.liquid.json', '{"title":"x"}\n');
  w('src/styles/base.css', 'a { color: #ffffff; background-color: #123456; }\n');
  w('src/pages/other.liquid', '<p>x</p>\n');
  w('dist/index.html', '<p>built</p>\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const tasks = [{ source: { file: 'src/partials/home/hero.liquid', line: 1 }, requiresDesignDecision: false, evidence: [], fix: { cautions: [] } },
    { source: { file: 'src/styles/base.css', line: 1 }, requiresDesignDecision: true, evidence: [], fix: { cautions: [] } }];
  return { root, w, tasks, rows: () => Object.fromEntries(verifyDiff({ root, tasks }).rows.map((r) => [r.file, r])) };
}

test('verify: a good diff (alt added in a named file and its sidecar) passes; no changes passes', () => {
  const r = repo();
  assert.deepEqual(verifyDiff({ root: r.root, tasks: r.tasks }).rows, []);
  r.w('src/partials/home/hero.liquid', '<img src="{{data:hero.image}}" class="a text-white" data-pdk-id="h1" alt="Team">\n{{component:cta}}\n');
  r.w('src/partials/home/hero.liquid.json', '{"title":"x","alt":"Team"}\n');
  const res = verifyDiff({ root: r.root, tasks: r.tasks });
  assert.equal(res.violations, 0);
  assert.deepEqual(res.rows.map((x) => [x.file, x.result]), [['src/partials/home/hero.liquid', 'ok'], ['src/partials/home/hero.liquid.json', 'ok']]);
});

test('verify: colour change, removed data-pdk, removed data tag, extra file and dist change are violations', () => {
  const r = repo();
  r.w('src/styles/base.css', 'a { color: #000000; background-color: #123456; }\n');
  r.w('src/partials/home/hero.liquid', '<img src="{{data:hero.image}}" class="a text-black" alt="x">\n');
  r.w('src/pages/other.liquid', '<p>changed</p>\n');
  r.w('src/pages/new.liquid', '<p>new</p>\n');
  r.w('dist/index.html', '<p>edited</p>\n');
  const rows = r.rows();
  assert.match(rows['src/styles/base.css'].detail, /colour declarations changed/);
  assert.match(rows['src/partials/home/hero.liquid'].detail, /data tags changed \(removed 2, added 0\)/);
  assert.match(rows['src/partials/home/hero.liquid'].detail, /colour declarations changed/);
  assert.match(rows['src/pages/other.liquid'].detail, /no task names this file/);
  assert.match(rows['src/pages/new.liquid'].detail, /no task names this file/);
  assert.match(rows['dist/index.html'].detail, /generated or built output/);
  assert.ok(Object.values(rows).every((x) => x.result === 'violation'));
});

test('verify: colour additions in an unlocked file warn, in a design-locked file fail; tool-owned files are ignored', () => {
  const r = repo();
  r.w('src/partials/home/hero.liquid', '<img src="{{data:hero.image}}" class="a text-white bg-black" data-pdk-id="h1" alt="x">\n{{component:cta}}\n');
  r.w('.claude/skills/ada-scan-fix/SKILL.md', `<!-- ${MARKER} -->\n`);
  r.w('.ada-scan/tasks/INDEX.md', 'x\n');
  let rows = r.rows();
  assert.deepEqual(Object.keys(rows), ['src/partials/home/hero.liquid']);
  assert.equal(rows['src/partials/home/hero.liquid'].result, 'warn');
  r.w('src/styles/base.css', 'a { color: #ffffff; background-color: #123456; border-color: #ff0000; }\n');
  rows = r.rows();
  assert.equal(rows['src/styles/base.css'].result, 'violation');
});

test('fix --verify (CLI) prints a table and exits 1 on a violation, reading the exported task JSON', async () => {
  const r = repo();
  const out = path.join(r.root, '.ada-scan');
  await assert.rejects(() => runFixSubcommand(['--verify', '--source', r.root, '--out-dir', out]), /No export found/);
  mkdirSync(path.join(out, 'tasks'), { recursive: true });
  writeFileSync(path.join(out, 'tasks/t1.json'), JSON.stringify({ generator: MARKER, ...r.tasks[0] }));
  writeFileSync(path.join(out, 'tasks/t2.json'), JSON.stringify({ generator: MARKER, file: 'src/styles/base.css', tasks: [r.tasks[1]] }));
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await runFixSubcommand(['--verify', '--source', r.root, '--out-dir', out]);
    r.w('src/styles/base.css', 'a { color: #000000; background-color: #123456; }\n');
    await assert.rejects(() => runFixSubcommand(['--verify', '--source', r.root, '--out-dir', out]), (e) => e.exitCode === 1 && /1 violation/.test(e.message));
  } finally { console.log = log; }
  assert.match(lines.join('\n'), /No changed files to check/);
  assert.match(lines.join('\n'), /FILE\s+STATUS\s+RESULT\s+DETAIL/);
  assert.match(lines.join('\n'), /src\/styles\/base\.css\s+M\s+violation/);
  await assert.rejects(() => runFixSubcommand(['--verify', '--export', '--source', r.root, '--out-dir', out]), /cannot be combined/);
  rmSync(r.root, { recursive: true, force: true });
});

// ---- lint and coverage

const DASH = /[–—]/;
const FORBIDDEN = [
  /\b(?:change|adjust|darken|lighten|tweak|swap|replace)\s+(?:the\s+)?(?:text\s+|background\s+)?(?:colou?rs?|opacity|tokens?)\b/i,
  /\buse\s+(?:the\s+)?nearest\s+passing\b/i,
  /\bremove\s+the\s+(?:element|button|link|image)\s+to\b/i,
  /\btabindex="[1-9]/,
  /\bdisplay:\s*none\b[^\n]*skip/i,
];
const NEGATED = /\b(?:never|not|don't|do not|no|wrong|avoid|tempting|instead|why)\b|n't\b/i;

test('lint: no em or en dashes and no forbidden advice in any skill file (source or installed)', () => {
  const all = [...bundleFiles().map((f) => [f, readFileSync(path.join(SKILL_SOURCE, f), 'utf8')]),
    ...['cursor', 'claude'].flatMap((t) => [...renderBundle(t)].map(([f, c]) => [`${t}:${f}`, c]))];
  for (const [f, text] of all) {
    assert.ok(!DASH.test(text), `${f}: dash character`);
    text.split('\n').forEach((line, i) => {
      if (/no-break-guardrails\.mdc?$/.test(f) && line.startsWith('| `')) return; // first column of the wrong-fix table is wrong by design
      for (const re of FORBIDDEN) if (re.test(line) && !NEGATED.test(line)) assert.fail(`${f}:${i + 1} forbidden advice: ${line}`);
    });
  }
});

test('lint: the design-locked rule is stated, and the skill never offers a colour change as an action', () => {
  const dl = readFileSync(path.join(SKILL_SOURCE, 'design-locked.md'), 'utf8');
  assert.match(dl, /Never fix colour contrast by changing colours, tokens, utility colour classes, opacity or background images/);
  const skill = readFileSync(path.join(SKILL_SOURCE, 'SKILL.md'), 'utf8');
  assert.match(skill, /Never change colours, tokens, utility colour classes, opacity or background images/);
});

test('lint: every referenced bundle file exists', () => {
  const names = new Set(bundleFiles());
  for (const f of names) {
    for (const m of readFileSync(path.join(SKILL_SOURCE, f), 'utf8').matchAll(/`((?:patterns\/)?[a-z][a-z-]*\.md)`/g)) assert.ok(names.has(m[1]), `${f} references missing ${m[1]}`);
  }
});

test('instruction coverage: every export rule family has a pattern file listed in SKILL.md', () => {
  const c = checkCoverage();
  assert.deepEqual(c, { unmapped: [], missingFiles: [], unlisted: [], orphans: [] });
});

test('verify: a "locate manually" task accepts edits to the templates it lists only; an added backend tag is a warning, a removed one a violation', () => {
  const r = repo();
  const untraced = { source: null, locateManually: { likely: [{ file: 'src/pages/other.liquid', line: null, role: 'page template' }], candidates: [] }, requiresDesignDecision: false, evidence: [], fix: { cautions: [] } };
  const tasks = [...r.tasks, untraced];
  r.w('src/pages/other.liquid', '<h1>{{attribute:og_title}}</h1>\n<p>x</p>\n'); // listed, adds a tag
  const rows = () => Object.fromEntries(verifyDiff({ root: r.root, tasks }).rows.map((x) => [x.file, x]));
  assert.equal(rows()['src/pages/other.liquid'].result, 'warn');
  assert.match(rows()['src/pages/other.liquid'].detail, /data tags added \(1\)/);
  // a template the task does not list stays a violation while the task is open: edit, creation, deletion and a data sidecar alike (real defect shapes)
  r.w('src/partials/home/hero.liquid.json', '{"title":"y"}\n'); // allowed through the traced task, so not a violation
  r.w('src/partials/layout/head.liquid', '<title>x</title>\n');
  r.w('src/partials/layout/new.liquid', '<script>alert(1)</script>\n');
  r.w('src/partials/layout/head.liquid.json', '{"a":1}\n');
  r.w('src/scripts/other.js', 'x\n');
  for (const f of ['src/partials/layout/head.liquid', 'src/partials/layout/new.liquid', 'src/partials/layout/head.liquid.json', 'src/scripts/other.js']) {
    assert.equal(rows()[f].result, 'violation', f);
    assert.match(rows()[f].detail, /no task names this file/);
  }
  r.w('src/partials/layout/footer.liquid', '<footer>hi</footer>\n');
  execFileSync('git', ['-C', r.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'add', '-A']);
  execFileSync('git', ['-C', r.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'footer']);
  rmSync(path.join(r.root, 'src/partials/layout/footer.liquid'));
  assert.equal(rows()['src/partials/layout/footer.liquid'].status, 'D');
  assert.equal(rows()['src/partials/layout/footer.liquid'].result, 'violation');
  // editing an existing tag is still a violation
  r.w('src/partials/home/hero.liquid', '<img src="{{data:hero.other}}" class="a text-white" data-pdk-id="h1">\n{{component:cta}}\n');
  assert.match(rows()['src/partials/home/hero.liquid'].detail, /data tags changed \(removed 1, added 1\)/);
});
