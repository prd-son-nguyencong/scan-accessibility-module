import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkingTreeFixer } from '../../src/fix/harness/fixers/external.js';
import { isDeclined } from '../../src/fix/harness/fixers/common.js';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const LINES = ['<header>', '<button>', '  <i></i>', '</button>', '<p>text</p>', '<p>more</p>', '<img src="a.png">', '<footer></footer>'];

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-'));
  mkdirSync(join(dir, 'src'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'src/a.liquid'), `${LINES.join('\n')}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const task = (id, line) => ({ id, rule: 'x', allowlist: [{ file: 'src/a.liquid', startLine: line - 1, endLine: line + 1 }] });

test('working-tree fixer gives each task only the hunks in its scope and lists the rest as unassigned', async () => {
  const dir = repo();
  try {
    const edited = [...LINES]; edited[1] = '<button aria-label="Menu">'; edited[6] = '<img src="a.png" alt="A">'; edited[4] = '<p class="x">text</p>';
    writeFileSync(join(dir, 'src/a.liquid'), `${edited.join('\n')}\n`);
    const fixer = createWorkingTreeFixer({ dir });
    assert.deepEqual(fixer.changedPaths(), ['src/a.liquid']);
    let current = `${LINES.join('\n')}\n`;
    const read = () => current;
    const img = await fixer.propose(task('img', 7), { read });
    assert.equal(isDeclined(img), false);
    assert.match(img.files[0].after, /alt="A"/);
    assert.doesNotMatch(img.files[0].after, /aria-label/);
    current = img.files[0].after;
    const btn = await fixer.propose(task('btn', 2), { read });
    assert.match(btn.files[0].after, /aria-label="Menu"/);
    assert.match(btn.files[0].after, /alt="A"/);
    assert.equal(fixer.unassigned().length, 1); // the class edit on line 5 belongs to no task
    assert.equal(fixer.unassigned()[0].line, 5);
    const none = await fixer.propose(task('far', 8), { read });
    assert.equal(isDeclined(none), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('working-tree fixer declines when a hunk straddles the task scope', async () => {
  const dir = repo();
  try {
    const edited = [...LINES]; edited[1] = '<button aria-label="Menu">'; edited[2] = '  <i class="far"></i>'; edited[3] = '</button><!--x-->';
    writeFileSync(join(dir, 'src/a.liquid'), `${edited.join('\n')}\n`);
    const r = await createWorkingTreeFixer({ dir }).propose({ id: 't', rule: 'x', allowlist: [{ file: 'src/a.liquid', startLine: 2, endLine: 2 }] }, { read: () => `${LINES.join('\n')}\n` });
    assert.equal(isDeclined(r), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- real export-shaped tasks (buildTaskSet output through the runner's normalizeTask)
const { buildTaskSet } = await import('../../src/fix/export/tasks.js');
const { buildScanReportV2 } = await import('../../src/reporter/report-v2.js');
const { normalizeTask } = await import('../../src/fix/harness/runner.js');
const axe = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const found = (ruleId, selector, outerHTML, file, line, route = '/') => ({ route, v: { ruleId, layer: 'axe', impact: 'serious', verdict: 'confirmed', wcagRef: 'wcag2a, wcag412', element: { selector, outerHTML }, fix: { hint: 'x' },
  evidence: { failureSummary: 'measured' }, source: file ? { file, line, confidence: 'medium', mode: 'local', method: 'marker' } : undefined } });
const reportOf = (rows) => buildScanReportV2([...new Set(rows.map((r) => r.route))].map((route) => ({ name: route, page: route, url: `https://e.test${route}`, scannerRuns: [axe], violations: rows.filter((r) => r.route === route).map((r) => r.v) })),
  { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'local-only', url: 'http://localhost:1234/' } });
const HEAD = ['<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, user-scalable=no">', '<meta name="description" content="d">', '<title>t</title>', '</head>',
  '<body>', '<nav id="mobile-navigation" aria-hidden="true">', '  <a href="/">a</a>', '</nav>', '<p>one</p>', '<p>two</p>', '<p>three</p>', '<p>four</p>', '<p>five</p>', '<p class="z">six</p>'];

function headRepo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-'));
  mkdirSync(join(dir, 'src'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'src/head.liquid'), `${HEAD.join('\n')}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const setup = (dir, rows) => {
  const set = buildTaskSet(reportOf(rows), { sourceRoot: dir });
  const norm = set.tasks.map((t) => normalizeTask(t));
  const fixer = createWorkingTreeFixer({ dir }); fixer.setTasks(norm);
  return { set, norm, fixer, tasks: fixer.retarget(set.tasks) };
};
const base = `${HEAD.join('\n')}\n`;

test('working-tree: export-shaped tasks own the hunk of their element even when the trace is lines off; unrelated hunks stay unassigned', async () => {
  const dir = headRepo();
  try {
    const ed = [...HEAD]; ed[2] = '<meta name="viewport" content="width=device-width">'; ed[7] = '<nav id="mobile-navigation">'; ed[14] = '<p class="new">five</p>';
    writeFileSync(join(dir, 'src/head.liquid'), `${ed.join('\n')}\n`);
    // viewport reported at line 7 (<body>), 4 lines below the real one: outside the +-3 radius, so only the element can claim the hunk
    const { fixer, tasks, norm } = setup(dir, [
      found('meta-viewport', 'head>meta:nth-of-type(2)', '<meta name="viewport" content="width=device-width, user-scalable=no">', 'src/head.liquid', 7),
      found('aria-hidden-focus', '#mobile-navigation', '<nav id="mobile-navigation" aria-hidden="true">', 'src/head.liquid', 8),
    ]);
    assert.ok(norm.every((n) => n.allowlist.length), 'normalised tasks carry an allowlist (the old raw tasks did not)');
    const read = () => base;
    const byRule = (rule) => tasks.find((t) => t.rule === rule);
    const vp = await fixer.propose(normalizeTask(byRule('meta-viewport')), { read });
    assert.equal(isDeclined(vp), false, JSON.stringify(vp));
    assert.match(vp.files[0].after, /content="width=device-width">/);
    assert.match(vp.files[0].after, /aria-hidden="true"/); // the nav hunk is not this task's
    const nav = await fixer.propose(normalizeTask(byRule('aria-hidden-focus')), { read });
    assert.equal(isDeclined(nav), false, JSON.stringify(nav));
    assert.deepEqual(fixer.unassigned().map((u) => u.line), [15]); // the class edit on <p>five</p> names no element of any task
    assert.equal(byRule('meta-viewport').source.line, 3); // moved onto its hunk so the harness orders bottom-up by real position
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('working-tree: a real defect fix is not swallowed by a nearer task, and an untraced task claims only what names its element or is alone', async () => {
  const dir = headRepo();
  try {
    const ed = [...HEAD]; ed[7] = '<nav id="mobile-navigation">'; ed[10] = '<p class="a">one</p>';
    writeFileSync(join(dir, 'src/head.liquid'), `${ed.join('\n')}\n`);
    // nav task traced at 8 (right), a second task traced at 11 whose element is <p id="other">: the nav hunk at 8 is not within its +-3 radius anyway; the <p> hunk names no task element.
    const { fixer, norm } = setup(dir, [
      found('aria-hidden-focus', '#mobile-navigation', '<nav id="mobile-navigation" aria-hidden="true">', 'src/head.liquid', 8),
      found('region', '#other', '<p id="other">x</p>', 'src/head.liquid', 11),
    ]);
    const read = () => base;
    const nav = norm.find((n) => n.rule === 'aria-hidden-focus');
    const r = await fixer.propose(nav, { read });
    assert.equal(isDeclined(r), false);
    assert.doesNotMatch(r.files[0].after, /class="a"/);
    // the <p> hunk (line 11) is inside the region task's allowlist and no element tier applies: line distance still gives it to the region task, not to nav
    const reg = await fixer.propose(norm.find((n) => n.rule === 'region'), { read });
    assert.equal(isDeclined(reg), false);
    assert.match(reg.files[0].after, /class="a"/);
    assert.equal(fixer.unassigned().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('working-tree: two untraced tasks sharing a file claim a hunk only by element; the same edit with no element match stays unassigned', async () => {
  const dir = headRepo();
  try {
    const ed = [...HEAD]; ed[15] = '<p class="z y">six</p>'; ed[7] = '<nav id="mobile-navigation">';
    writeFileSync(join(dir, 'src/head.liquid'), `${ed.join('\n')}\n`);
    const locate = (likely) => ({ file: null, line: null, likely });
    const mk = (id, rule, selector, html) => ({ ...buildTaskSet(reportOf([found(rule, selector, html, null, 0)]), { sourceRoot: dir }).tasks[0], id });
    const a = mk('A', 'page-has-heading-one', 'main', '<main>');
    const b = mk('B', 'aria-hidden-focus', '#mobile-navigation', '<nav id="mobile-navigation" aria-hidden="true">');
    for (const t of [a, b]) t.locateManually = { ...t.locateManually, ...locate([{ file: 'src/head.liquid', line: null, role: 'x' }]) };
    const fixer = createWorkingTreeFixer({ dir }); fixer.setTasks([a, b].map((t) => normalizeTask(t)));
    const out = fixer.retarget([a, b]);
    assert.deepEqual(out.map((t) => t.allowlist.map((e) => e.file)), [['src/head.liquid'], ['src/head.liquid']]);
    const nav = await fixer.propose(normalizeTask(out[1]), { read: () => base });
    assert.equal(isDeclined(nav), false);
    assert.doesNotMatch(nav.files[0].after, /class="z y"/);
    assert.deepEqual(fixer.unassigned().map((u) => u.line), [16]); // two whole-file tasks, no element in the hunk: nobody claims it
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('working-tree: a multi-hunk task that adds a line above an interleaved task does not break the bottom-up replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-'));
  try {
    mkdirSync(join(dir, 'src'));
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
    const L = ['<div>', '<p>x</p>', '<img class="logo" src="/a.png">', '<p>1</p>', '<p>2</p>', '<p>3</p>', '<button class="go" id="go-btn"><span></span></button>', '<p>4</p>', '<p>5</p>', '<p>6</p>', '<p>7</p>', '<img class="logo" src="/a.png">', '</div>'];
    writeFileSync(join(dir, 'src/a.liquid'), `${L.join('\n')}\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
    const ed = [...L]; ed[2] = '<img class="logo"\n  src="/a.png" alt="">'; ed[6] = '<button class="go" id="go-btn" aria-label="Go"><span></span></button>'; ed[11] = '<img class="logo" src="/a.png" alt="">';
    const finalText = `${ed.join('\n')}\n`;
    writeFileSync(join(dir, 'src/a.liquid'), finalText);
    const { tasks, fixer } = setup2(dir, [
      found('image-alt', 'img.logo', '<img class="logo" src="/a.png">', 'src/a.liquid', 3),
      found('button-name', '#go-btn', '<button class="go" id="go-btn"><span></span></button>', 'src/a.liquid', 7),
    ]);
    let shadow = `${L.join('\n')}\n`;
    const seen = [];
    for (const t of [...tasks].sort((a, b) => b.source.line - a.source.line)) { // the runner's order: bottom up by source line
      const r = await fixer.propose(normalizeTask(t), { read: () => shadow });
      seen.push([t.rule, isDeclined(r)]);
      if (!isDeclined(r)) shadow = r.files[0].after;
    }
    assert.deepEqual(seen.map((x) => x[1]), [false, false], JSON.stringify(seen));
    assert.equal(shadow, finalText); // both valid fixes land, nothing is lost or shifted
    assert.equal(fixer.unassigned().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function setup2(dir, rows) {
  const set = buildTaskSet(reportOf(rows), { sourceRoot: dir });
  const fixer = createWorkingTreeFixer({ dir }); fixer.setTasks(set.tasks.map((t) => normalizeTask(t)));
  return { fixer, tasks: fixer.retarget(set.tasks) };
}

test('working-tree: a hunk whose lines were already changed in the shadow still declines (shifting never forces a match)', async () => {
  const dir = repo();
  try {
    const edited = [...LINES]; edited[6] = '<img src="a.png" alt="A">';
    writeFileSync(join(dir, 'src/a.liquid'), `${edited.join('\n')}\n`);
    const shifted = ['<new>', ...LINES]; shifted[7] = '<img src="other.png">'; // one line added above, and the img line itself differs
    const r = await createWorkingTreeFixer({ dir }).propose(task('img', 7), { read: () => `${shifted.join('\n')}\n` });
    assert.equal(isDeclined(r), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
