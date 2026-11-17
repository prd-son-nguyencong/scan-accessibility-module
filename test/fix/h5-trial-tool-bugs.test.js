// Tool bugs found by the real-site editor trials (round 2): remaining from the final rescan, decline classes, untracked files, closing tags,
// truncated element html, partial scope of the h1 task, script hints, G1 evidence and the .cursor exclude advice.
import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRemainingReport, renderRemainingMarkdown, evaluateTargeted } from '../../src/fix/harness/index.js';
import { declineReasonClass } from '../../src/fix/harness/remaining.js';
import { createWorkingTreeFixer } from '../../src/fix/harness/fixers/external.js';
import { normalizeTask } from '../../src/fix/harness/runner.js';
import { buildTaskSet } from '../../src/fix/export/tasks.js';
import { parseElement } from '../../src/fix/export/recipes.js';
import { excludeAdvice } from '../../src/fix/export/skill/install.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const gitRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'h5-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), text); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
};

test('remaining is counted from the final rescan; report findings the rescan never saw are listed apart and block the zero claim', () => {
  const f = (id, rule) => ({ stableId: id, nativeRuleId: rule, impact: 'serious', verdict: 'confirmed', ownership: 'source', element: { selector: `#${id}` } });
  const report = { pages: [{ route: '/', findings: [f('a', 'button-name'), f('b', 'image-alt'), f('c', 'meta-viewport'), f('d', 'label')] }] };
  const tasks = [{ id: 't-a', ids: ['a'], rule: 'button-name' }];
  const n = (id, rule) => ({ id, rule, native: rule, route: '/', selector: `#${id}`, tier: 'confirmed' });
  const baseline = [n('a', 'button-name'), n('b', 'image-alt'), n('d', 'label')];
  const final = [n('b', 'image-alt'), n('d', 'label')];
  const r = buildRemainingReport({ report, tasks, results: [{ taskId: 't-a', outcome: 'accepted' }], baselineFindings: baseline, finalFindings: final, finalScan: { proved: true }, scanDelta: { before: 3, after: 2, fixed: 1, added: 0 } });
  assert.equal(r.source, 'final-rescan');
  assert.deepEqual([r.totals.fixed, r.totals.remaining, r.totals.baselineRescan, r.totals.finalRescan, r.totals.notRescanned], [1, 2, 3, 2, 1]);
  assert.deepEqual(r.notRescanned.map((x) => x.id), ['c']);
  assert.equal(r.zeroRemainingClaim, false);
  assert.match(renderRemainingMarkdown(r), /Not seen by the rescan/);
  // An accepted task whose finding the rescan still reports is remaining, not fixed.
  const again = buildRemainingReport({ report, tasks, results: [{ taskId: 't-a', outcome: 'accepted' }], baselineFindings: baseline, finalFindings: baseline, finalScan: { proved: true }, scanDelta: { before: 3, after: 3, fixed: 0, added: 0 } });
  assert.equal(again.totals.fixed, 0);
  assert.equal(again.remaining.find((x) => x.id === 'a').cls, 'fixer_could_not_produce_safe_change');
  // Nothing left and nothing unseen: the claim is possible.
  const clean = buildRemainingReport({ report: { pages: [{ route: '/', findings: [f('a', 'button-name')] }] }, tasks, results: [{ taskId: 't-a', outcome: 'accepted' }], baselineFindings: [n('a', 'button-name')], finalFindings: [], finalScan: { proved: true }, scanDelta: { before: 1, after: 0, fixed: 1, added: 0 } });
  assert.equal(clean.zeroRemainingClaim, true);
});

test('editor-declined tasks: heading-one and name rules are needs_human_content, the wording says the editor made no change', () => {
  assert.equal(declineReasonClass('page-has-heading-one'), 'needs_human_content');
  assert.equal(declineReasonClass('button-name'), 'needs_human_content');
  assert.equal(declineReasonClass('aria-hidden-focus'), null);
  const report = { pages: [{ route: '/', findings: [{ stableId: 'h', nativeRuleId: 'aria-hidden-focus', impact: 'serious', verdict: 'confirmed', ownership: 'source', element: { selector: '#h' } }] }] };
  const r = buildRemainingReport({ report, tasks: [{ id: 't', ids: ['h'], rule: 'aria-hidden-focus' }], results: [{ taskId: 't', outcome: 'declined', editorFlow: true, detail: 'NO_CHANGE_FOR_TASK' }] });
  assert.match(r.remaining[0].detail, /the editor made no change for this task/);
  assert.doesNotMatch(r.remaining[0].detail, /fixer declined/);
});

test('G1 evidence names the rule and selector of a new or remaining finding; a focus behaviour finding carries the unmasking note', () => {
  const x = (id, rule, tier = 'confirmed') => ({ id, rule, native: rule, selector: `#${id}`, route: '/', tier, rootCauseKey: `${rule}|#${id}` });
  const g = evaluateTargeted({ targetFindingIds: ['t'], affectedRoutes: ['/'], before: [x('t', 'aria-hidden-focus')], after: [x('t', 'aria-hidden-focus'), x('n', 'focus-lost-after-escape'), x('m', 'image-alt')] });
  const byId = Object.fromEntries(g.evidence.map((e) => [e.id, e]));
  assert.deepEqual([byId.t.rule, byId.t.selector], ['aria-hidden-focus', '#t']);
  assert.match(byId.n.note, /unmasked/);
  assert.equal(byId.m.note, undefined);
  assert.equal(byId.m.rule, 'image-alt');
});

test('working tree: an untracked sidecar is listed as a new file, and the closing tag of a rewritten element follows its opener', async () => {
  const L = ['<div>', '<a href="/x" class="btn" id="cta">', '  Go', '</a>', '<p>one</p>', '<p>two</p>', '<p>three</p>', '<p>four</p>', '<p>five</p>', '<p>six</p>', '</div>'];
  const dir = gitRepo({ 'src/a.liquid': `${L.join('\n')}\n` });
  try {
    const ed = [...L]; ed[1] = '<button type="button" class="btn" id="cta">'; ed[3] = '</button>';
    writeFileSync(join(dir, 'src/a.liquid'), `${ed.join('\n')}\n`);
    writeFileSync(join(dir, 'src/a.liquid.json'), '{"title":"x"}\n');
    mkdirSync(join(dir, '.ada-scan'), { recursive: true }); writeFileSync(join(dir, '.ada-scan/x.json'), '{}');
    const fixer = createWorkingTreeFixer({ dir });
    assert.deepEqual(fixer.changedPaths().sort(), ['src/a.liquid', 'src/a.liquid.json']);
    const raw = { id: 'T', rule: 'x', source: { file: 'src/a.liquid', line: 2 }, element: { html: '<a href="/x" class="btn" id="cta">' }, occurrences: [{ selector: '#cta' }] };
    fixer.setTasks([normalizeTask(raw)]);
    const r = await fixer.propose(normalizeTask(fixer.retarget([raw])[0]), { read: () => `${L.join('\n')}\n` });
    assert.equal(r.declined, undefined, JSON.stringify(r));
    assert.match(r.files[0].after, /<\/button>/, 'the closing tag hunk is owned by the same task');
    const un = fixer.unassigned();
    assert.deepEqual(un.map((u) => u.path), ['src/a.liquid.json']);
    assert.match(un[0].reason, /new file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export: an element cut in its opening tag still names tag and attributes; long opening tags are kept whole; the h1 task names the rendered partials; behaviour tasks name the script', () => {
  assert.equal(parseElement('<a href="/x" data-pdk-param-one="1" data-pdk-param-tw').tag, 'a');
  assert.equal(parseElement('<a href="/x" data-pdk-param-one="1" data-pdk-par').attrs['data-pdk-param-one'], '1');
  const dir = mkdtempSync(join(tmpdir(), 'h5-src-'));
  try {
    mkdirSync(join(dir, 'src/pages'), { recursive: true }); mkdirSync(join(dir, 'src/partials/home'), { recursive: true }); mkdirSync(join(dir, 'src/scripts'), { recursive: true });
    writeFileSync(join(dir, 'src/pages/index.liquid'), '<main>{% render "home/hero" %}</main>\n');
    writeFileSync(join(dir, 'src/partials/home/hero.liquid'), '<section></section>\n');
    writeFileSync(join(dir, 'src/scripts/header.js'), "el.setAttribute('tabindex', '-1');\n");
    const longTag = `<a href="/x" ${Array.from({ length: 20 }, (_, i) => `data-pdk-param-${i}="value-${i}"`).join(' ')} class="btn">Go</a>`;
    assert.ok(longTag.indexOf('>') > 300);
    const axe = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
    const row = (ruleId, selector, outerHTML, layer = 'axe') => ({ ruleId, layer, impact: 'serious', verdict: 'confirmed', wcagRef: 'wcag2a', element: { selector, outerHTML }, fix: { hint: 'x' }, evidence: { failureSummary: 'm' } });
    const report = buildScanReportV2([{ name: '/', page: '/', url: 'https://e.test/', scannerRuns: [axe], violations: [row('page-has-heading-one', 'html', '<html>'), row('menu-links-unreachable-by-keyboard', '.nav a', longTag)] }],
      { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'local-only', url: 'http://localhost:1234/' } });
    const set = buildTaskSet(report, { sourceRoot: dir });
    const h1 = set.tasks.find((t) => t.rule === 'page-has-heading-one');
    assert.ok(h1.locateManually.likely.some((l) => l.file === 'src/partials/home/hero.liquid' && /rendered by src\/pages\/index\.liquid/.test(l.role)));
    assert.ok(normalizeTask(h1).locateFiles.includes('src/partials/home/hero.liquid'), 'the harness scopes the partial too');
    const menu = set.tasks.find((t) => t.rule === 'menu-links-unreachable-by-keyboard');
    assert.equal(parseElement(menu.element.html).tag, 'a');
    assert.ok(menu.element.html.endsWith('class="btn">'.slice(0, 0) + menu.element.html.slice(-1)) && menu.element.html.includes('class="btn"'), 'the whole opening tag is kept');
    assert.deepEqual(menu.scriptFiles, ['src/scripts/header.js']);
    assert.ok(normalizeTask(menu).allowlist.some((e) => e.file === 'src/scripts/header.js'));
    assert.ok(menu.evidence.some((e) => /Script fix/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('excludeAdvice: agent rules that git does not ignore get a .git/info/exclude suggestion; ignored ones and non-repos get none', () => {
  const dir = gitRepo({ 'a.txt': 'x' });
  try {
    const a = excludeAdvice('cursor', dir);
    assert.deepEqual(a.patterns, ['.cursor/rules/ada-scan.mdc', '.cursor/rules/ada-scan-fix-skill/']);
    assert.match(a.advice, /info\/exclude/);
    writeFileSync(join(dir, '.gitignore'), '.cursor/\n');
    assert.equal(excludeAdvice('cursor', dir).advice, null);
    assert.equal(excludeAdvice('generic', dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const plain = mkdtempSync(join(tmpdir(), 'h5-plain-'));
  try { assert.equal(excludeAdvice('claude', plain), null); } finally { rmSync(plain, { recursive: true, force: true }); }
});
