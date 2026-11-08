// Working-tree hunk ownership: a closing tag is bound to its own opener, and a script-traced task owns the template that renders its element.
import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkingTreeFixer } from '../../src/fix/harness/fixers/external.js';
import { normalizeTask } from '../../src/fix/harness/runner.js';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const gitRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'i4-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), text); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
};

test('an unrelated later hunk with the same closing tag is not absorbed into the task that rewrote another element', async () => {
  const L = ['<nav>', '<a href="/x" class="btn" id="cta">', '  Go', '</a>', '<p>1</p>', '<p>2</p>', '<p>3</p>', '<p>4</p>', '<p>5</p>', '<p>6</p>', '<a href="/careers" class="other">Jobs</a>', '<p>7</p>', '</nav>'];
  const dir = gitRepo({ 'src/a.liquid': `${L.join('\n')}\n` });
  try {
    const ed = [...L]; ed[1] = '<button type="button" class="btn" id="cta">'; ed[3] = '</button>'; ed[10] = '<a href="/careers" class="other">Open roles</a>';
    writeFileSync(join(dir, 'src/a.liquid'), `${ed.join('\n')}\n`);
    const fixer = createWorkingTreeFixer({ dir });
    const raw = { id: 'T', rule: 'x', source: { file: 'src/a.liquid', line: 2 }, element: { html: '<a href="/x" class="btn" id="cta">' }, occurrences: [{ selector: '#cta' }] };
    fixer.setTasks([normalizeTask(raw)]);
    const t = normalizeTask(fixer.retarget([raw])[0]);
    assert.ok(!t.allowlist.some((e) => e.startLine === 11), 'the unrelated hunk does not widen the allowlist');
    const r = await fixer.propose(t, { read: () => `${L.join('\n')}\n` });
    assert.match(r.files[0].after, /<\/button>/, 'its own closing tag still follows it');
    assert.doesNotMatch(r.files[0].after, /Open roles/);
    assert.deepEqual(fixer.unassigned().map((u) => u.line), [11], 'the unrelated edit stays unassigned');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a task traced to a script owns the component template that renders its element', async () => {
  const comp = ['{% if kind == "olivia" %}', '<a href="#" role="button" class="oliviaButton btn">', '  {{ label }}', '</a>', '{% else %}', '<a href="{{ url }}" class="btn">{{ label }}</a>', '{% endif %}'];
  const dir = gitRepo({ 'src/components/button.liquid': `${comp.join('\n')}\n`, 'src/scripts/index.js': `${'//\n'.repeat(14)}document.querySelector('.oliviaButton').addEventListener('click', go);\n` });
  try {
    const ed = [...comp]; ed[1] = '<button type="button" class="oliviaButton btn">'; ed[3] = '</button>';
    writeFileSync(join(dir, 'src/components/button.liquid'), `${ed.join('\n')}\n`);
    const fixer = createWorkingTreeFixer({ dir });
    const raw = { id: 'R', rule: 'role-button-not-keyboard-operable', source: { file: 'src/scripts/index.js', line: 15 }, element: { html: '<a href="#" role="button" class="oliviaButton btn">' }, occurrences: [{ selector: 'a.oliviaButton' }] };
    fixer.setTasks([normalizeTask(raw)]);
    const t = normalizeTask(fixer.retarget([raw])[0]);
    const r = await fixer.propose(t, { read: () => `${comp.join('\n')}\n` });
    assert.equal(r.declined, undefined, JSON.stringify(r));
    assert.match(r.files[0].after, /<button type="button" class="oliviaButton btn">/);
    assert.match(r.files[0].after, /<\/button>/);
    assert.deepEqual(fixer.unassigned().filter((u) => !u.ownedBy), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remaining: a defect seen under two ids or two layers is counted once, and the not-seen list leaves out what the rescan saw', async () => {
  const { buildRemainingReport, renderRemainingMarkdown } = await import('../../src/fix/harness/index.js');
  const f = (id, rule, selector) => ({ stableId: id, nativeRuleId: rule, impact: 'serious', verdict: 'confirmed', ownership: 'source', element: { selector } });
  const report = { pages: [{ route: '/', findings: [f('rep1', 'aria-hidden-focus', 'body>header#header>nav#mobile-navigation'), f('lh', 'meta-viewport', 'html>head>meta'), f('as', 'MetaViewportScalable', 'meta[name=viewport]')] }] };
  const n = (id, rule, selector) => ({ id, rule, native: rule, route: '/', selector, tier: 'confirmed' });
  const rows = [n('r1', 'aria-hidden-focus', '#mobile-navigation'), n('as', 'MetaViewportScalable', 'meta[name=viewport]'), n('lh', 'meta-viewport', 'html>head>meta')];
  const tasks = [{ id: 't1', ids: ['r1'], rule: 'aria-hidden-focus' }, { id: 't2', ids: ['lh'], rule: 'meta-viewport' }];
  const r = buildRemainingReport({ report, tasks, results: [{ taskId: 't1', outcome: 'rolled_back', failedGates: ['G1'] }, { taskId: 't2', outcome: 'skipped' }], baselineFindings: rows, finalFindings: rows, finalScan: { proved: true }, scanDelta: { before: 3, after: 3, fixed: 0, added: 0 } });
  assert.deepEqual(r.notRescanned, [], 'aria-hidden-focus was seen by the rescan under another id');
  assert.equal(r.remaining.length, 2);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.confirmedSiteOwned.remaining, 2);
  assert.equal(r.perClass.gate_failed, 1);
  assert.match(renderRemainingMarkdown(r), /Same defect reported twice/);
  assert.match(renderRemainingMarkdown(r), /Reconciliation: 0 accepted/);
});

test('quiet console: project plugin output goes to the log file, the harness progress line stays visible, and the console is restored', async () => {
  const { withQuietConsole } = await import('../../src/fix/harness/quiet.js');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'i4q-'));
  const orig = console.log; const seen = [];
  try {
    console.log = (...a) => seen.push(a.join(' '));
    await withQuietConsole(join(dir, 'x/out.log'), async (say) => { console.log('[file-watcher] changed a'); say('  progress'); });
    assert.deepEqual(seen, ['  progress']);
    assert.match(readFileSync(join(dir, 'x/out.log'), 'utf8'), /\[file-watcher\] changed a/);
    console.log('after'); assert.equal(seen.at(-1), 'after');
  } finally { console.log = orig; rmSync(dir, { recursive: true, force: true }); }
});

// ---- l3: a hunk inside a task's own block beats whole-file scopes; ties are not decided by the id string (trial run, defect 3) ----
test('a hunk next to a task\'s own traced line is owned by that task, not by whole-file script scopes of tasks traced elsewhere', async () => {
  const index = [
    'initHeader();', '', 'const oliviaClick = document.querySelectorAll(".oliviaButton");', 'if (oliviaClick) {', '  oliviaClick.forEach((element) => {',
    '    element.addEventListener("click", () => {', '      launch();', '    });', '  });', '}', '', 'other();', 'more();',
  ];
  const header = Array.from({ length: 30 }, (_, i) => `// header ${i + 1}`);
  const dir = gitRepo({ 'src/scripts/index.js': `${index.join('\n')}\n`, 'src/scripts/header.js': `${header.join('\n')}\n` });
  try {
    const ed = [...index]; ed.splice(8, 0, '    element.addEventListener("keydown", (e) => { if (e.key === "Enter") element.click(); });'); // after line 8 (inside the forEach block, 3 lines past the traced 6)
    ed.push('extra();'); // a hunk after the last top-level statement
    writeFileSync(join(dir, 'src/scripts/index.js'), `${ed.join('\n')}\n`);
    const mk = (id, file, line, extra = {}) => ({ id, rule: 'r', source: { file, line }, ...extra });
    // '51ed0' sorts before '6d4cd': the old tie-break handed the hunk to it
    const raws = [mk('51ed0', 'src/scripts/header.js', 25, { scriptFiles: ['src/scripts/index.js'] }), mk('6d4cd', 'src/scripts/index.js', 6, { element: { html: '<a class="oliviaButton">' } }), mk('302bb', 'src/scripts/header.js', 10, { scriptFiles: ['src/scripts/index.js'] })];
    const fixer = createWorkingTreeFixer({ dir });
    fixer.setTasks(raws.map((r) => normalizeTask(r)));
    const un = fixer.unassigned();
    assert.equal(un.find((u) => u.path === 'src/scripts/index.js' && u.line === 9).ownedBy, '6d4cd', 'inside the block of its traced line');
    assert.equal(un.find((u) => u.path === 'src/scripts/index.js' && u.line === 14).ownedBy, undefined, 'two whole-file scopes traced elsewhere: no coin flip, left unassigned');
    const t = normalizeTask(fixer.retarget(raws)[1]);
    const r = await fixer.propose(t, { read: () => `${index.join('\n')}\n` });
    assert.equal(r.declined, undefined, JSON.stringify(r));
    assert.match(r.files[0].after, /keydown/);
    // the whole-file tasks never receive it
    const other = normalizeTask(fixer.retarget(raws)[0]);
    const o = await fixer.propose(other, { read: () => `${header.join('\n')}\n` });
    assert.equal(o.declined, 'NO_CHANGE_FOR_TASK', 'no hunk belongs to the header task');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a whole-file scope alone still claims a hunk; an explicit range beats a whole-file scope on the same file', async () => {
  const js = ['a();', 'b();', 'c();', 'd();', 'e();', 'f();', 'g();', 'h();'];
  const dir = gitRepo({ 'src/s.js': `${js.join('\n')}\n` });
  try {
    const ed = [...js]; ed[6] = 'g2();';
    writeFileSync(join(dir, 'src/s.js'), `${ed.join('\n')}\n`);
    const fixer = createWorkingTreeFixer({ dir });
    const whole = { id: 'aaa', rule: 'r', source: { file: 'src/other.js', line: 1 }, scriptFiles: ['src/s.js'] };
    const ranged = { id: 'zzz', rule: 'r', source: { file: 'src/s.js', line: 7 } };
    fixer.setTasks([normalizeTask(whole)]);
    assert.equal(fixer.unassigned()[0].ownedBy, 'aaa', 'alone: the whole-file scope claims');
    fixer.setTasks([normalizeTask(whole), normalizeTask(ranged)]);
    assert.equal(fixer.unassigned()[0].ownedBy, 'zzz', 'the explicit range around line 7 wins over an id that sorts first');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
