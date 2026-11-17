// M3: harness speed and stability. Incremental rescan (only the routes an edit can have changed), parallel capture, no write-through of the vite dep cache,
// deterministic "not seen by the rescan", queued edits in remaining.md, retarget to one hunk, index.js and the capped h1 candidates in the export.
import '../helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireBrowser } from '../helpers/require-browser.js';
import { HARNESS_SITE_SRC, renderHarnessSite, serveDir } from '../helpers/harness-site.mjs';
import { runHarness, captureSnapshot, buildRemainingReport, renderRemainingMarkdown, VIEWPORTS } from '../../src/fix/harness/index.js';
import { affectedRoutes, routeIndexFromReport } from '../../src/fix/harness/incremental.js';
import { createWorkingTreeFixer } from '../../src/fix/harness/fixers/external.js';
import { normalizeTask } from '../../src/fix/harness/runner.js';
import { createViteSiteAdapter } from '../../src/fix/verify/site.js';
import { buildTaskSet } from '../../src/fix/export/tasks.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { closeBrowser } from '../../src/scanner/browser.js';

const work = mkdtempSync(join(tmpdir(), 'm3-speed-'));
after(async () => { await closeBrowser(); rmSync(work, { recursive: true, force: true }); });
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

// ---- affectedRoutes: which routes an edit can have changed
const ROUTES = ['/', '/about', '/jobs'];
const hashes = (o) => ({ '/': 'a', '/about': 'b', '/jobs': 'c', ...o });

test('affectedRoutes: a template edit reaches the routes whose served HTML changed, the task routes and the report routeDependencies; anything else is every route', () => {
  const base = { routes: ROUTES, taskRoutes: ['/'], before: hashes({}) };
  assert.deepEqual(affectedRoutes({ ...base, touched: ['src/pages/index.liquid'], after: hashes({ '/': 'a2' }) }).routes, ['/'], 'only the page whose HTML changed');
  assert.deepEqual(affectedRoutes({ ...base, touched: ['src/partials/header.liquid'], after: hashes({ '/': 'x', '/about': 'y', '/jobs': 'z' }) }).routes, ROUTES, 'a shared partial changed every page');
  const shared = affectedRoutes({ ...base, touched: ['src/partials/header.liquid'], after: hashes({ '/': 'x', '/jobs': 'z' }) });
  assert.deepEqual(shared.routes, ['/', '/jobs'], 'the unchanged route is reused');
  assert.equal(shared.all, false);
  // never narrower than the task's own routes, even when the served HTML did not change
  assert.deepEqual(affectedRoutes({ ...base, taskRoutes: ['/about'], touched: ['src/pages/about.liquid'], after: hashes({}) }).routes, ['/about']);
  // a route with no hash on either side counts as changed
  assert.deepEqual(affectedRoutes({ ...base, touched: ['src/pages/jobs.liquid'], after: { '/': 'a', '/about': 'b' } }).routes, ['/', '/jobs']);
  // the report says a file reaches /about although its HTML hash did not move
  const idx = routeIndexFromReport({ pages: [{ route: '/about', findings: [{ source: { file: '/abs/proj/src/partials/header.liquid', routeDependencies: ['/about', '/jobs'] } }] }] });
  assert.deepEqual(affectedRoutes({ ...base, touched: ['src/partials/header.liquid'], after: hashes({}), routeIndex: idx }).routes, ['/', '/about', '/jobs']);
  // not a template, no hashes, or switched off: every route
  for (const [touched, extra] of [[['src/styles/site.css'], {}], [['src/pages/index.liquid', 'src/scripts/menu.js'], {}], [['src/pages/index.liquid'], { after: null }], [['src/pages/index.liquid'], { enabled: false }]]) {
    const r = affectedRoutes({ ...base, touched, after: hashes({ '/': 'a2' }), ...extra });
    assert.deepEqual([r.routes, r.all], [ROUTES, true], `${touched} ${JSON.stringify(extra)}`);
  }
});

// ---- the runner on a two-page site: what is rescanned, what is reused, and that a real regression is still caught
const HEADER = 'src/partials/header.liquid', CSS = 'src/styles/site.css', INDEX = 'src/pages/index.liquid';
function makeProject(name) {
  const dir = join(work, name, 'proj');
  mkdirSync(dir, { recursive: true });
  cpSync(HARNESS_SITE_SRC, join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'build.mjs'), `import { renderHarnessSite } from ${JSON.stringify(new URL('../helpers/harness-site.mjs', import.meta.url).href)};\nrenderHarnessSite('src', 'dist');\n`);
  return dir;
}
function recordingScanner(calls) {
  return async ({ siteUrl, routes }) => {
    calls.push([...routes]);
    const findings = [];
    for (const route of routes) {
      const html = await (await fetch(new URL(route, siteUrl))).text();
      if (/<button\b(?![^>]*aria-label)[^>]*>\s*<span/.test(html)) findings.push({ findingId: `btn|${route}`, canonicalRuleId: 'button-name', route, selector: '#menu-btn' });
      if (/<img\b(?![^>]*\balt=)[^>]*>/.test(html)) findings.push({ findingId: `img|${route}`, canonicalRuleId: 'image-alt', route, selector: 'img' });
    }
    return { findings };
  };
}
const swap = (ctx, path, from, to) => { const before = ctx.read(path); assert.ok(before.includes(from), `fixture drift: ${from}`); return { path, before, after: before.replace(from, to) }; };
const IMG_TASK = { id: 'img', rule: 'image-alt', source: { file: INDEX, line: 15 }, pages: ['/'], occurrences: [{ route: '/', selector: 'img', stableId: 'sid-img' }], ids: ['sid-img'], allowlist: [{ file: INDEX }] };
const BTN_TASK = { id: 'btn', rule: 'button-name', source: { file: HEADER, line: 3 }, pages: ['/'], occurrences: [{ route: '/', selector: '#menu-btn', stableId: 'sid-btn' }], ids: ['sid-btn'], allowlist: [{ file: HEADER, startLine: 1, endLine: 6 }, { file: CSS }] };
const runIt = async (name, task, files, extra = {}) => {
  const calls = [], perfUrls = [];
  const res = await runHarness({
    projectDir: makeProject(name), tasks: [task], fixer: { name: 'scripted', mechanicallySafe: true, async propose(_t, ctx) { return { files: files(ctx) }; } },
    config: { build: { command: 'node', args: ['build.mjs'] }, routes: ['/', '/about'], viewports: [VIEWPORTS[0], VIEWPORTS[2]], perfRuns: 1, scanner: recordingScanner(calls), maxRepairs: 0, dryRun: true,
      perfRunner: async (_b, url) => { perfUrls.push(new URL(url).pathname); return { score: 90, lcp: 1000, fcp: 800, cls: 0, tbt: 0, si: 1000, transfer: 5000 }; }, runDir: join(work, name, 'run'), snapshotBudgetMs: 180000, ...extra },
  });
  return { res, calls, perfUrls, it: res.tasks[0].iterations[0] };
};

test('a page-only edit rescans, captures and times only its own page; the other page keeps its baseline cells, rows and perf runs', async (t) => {
  if (!(await requireBrowser(t))) return;
  const { res, calls, perfUrls, it } = await runIt('page-only', IMG_TASK, (ctx) => [swap(ctx, INDEX, '<img src="/pic.svg"', '<img alt="Picture" src="/pic.svg"')]);
  assert.equal(res.tasks[0].outcome, 'accepted', JSON.stringify(res.tasks[0].evidence));
  assert.deepEqual(it.routesChecked, ['/']);
  assert.deepEqual(it.routesReused, ['/about']);
  assert.deepEqual(calls, [['/', '/about'], ['/'], ['/']], 'baseline scans both pages; the candidate and the final rescan only the changed one');
  assert.deepEqual(perfUrls, ['/', '/about', '/'], 'lighthouse of the unchanged page is not repeated');
  assert.equal(res.counts.snapshotCellsReused, 2, 'both viewports of /about');
  assert.equal(res.scanDelta.fixed, 1);
  assert.equal(res.scanDelta.added, 0);
  assert.ok(res.timings.totalMs > 0 && res.timings.scanMs >= 0 && res.timings.buildMs >= 0, 'phase timings are reported');
});

test('a regression on the changed page is still rejected when the other page is reused (the gates are not weakened)', async (t) => {
  if (!(await requireBrowser(t))) return;
  const { res, it } = await runIt('page-bad', IMG_TASK, (ctx) => [swap(ctx, INDEX, '<img src="/pic.svg"', '<img alt="Picture" style="margin-top:90px" src="/pic.svg"')]);
  assert.equal(res.tasks[0].outcome, 'rolled_back');
  assert.deepEqual(it.routesChecked, ['/']);
  assert.ok(it.failedGates.includes('G3') || it.failedGates.includes('G4'), `layout or pixel gate: ${it.failedGates}`);
});

test('a shared partial or a stylesheet edit covers every page, so a regression on a page the task never named is still seen', async (t) => {
  if (!(await requireBrowser(t))) return;
  const header = await runIt('shared-partial', BTN_TASK, (ctx) => [swap(ctx, HEADER, '<button class="menu-btn"', '<button class="menu-btn" aria-label="Menu"')]);
  assert.equal(header.res.tasks[0].outcome, 'accepted');
  assert.deepEqual(header.it.routesChecked, ['/', '/about'], 'the partial is rendered by both pages: the served HTML of both changed');
  assert.deepEqual(header.calls, [['/', '/about'], ['/', '/about'], ['/', '/about']]);
  const css = await runIt('css', BTN_TASK, (ctx) => [swap(ctx, HEADER, '<button class="menu-btn"', '<button class="menu-btn" aria-label="Menu"'), swap(ctx, CSS, 'padding: 12px 24px', 'padding: 28px 24px')]);
  assert.deepEqual(css.it.routesChecked, ['/', '/about'], 'a stylesheet can change a page whose HTML did not');
  assert.equal(css.res.tasks[0].outcome, 'rolled_back');
  assert.ok(css.it.failedGates.includes('G3'));
});

test('captureSnapshot: the stored snapshot does not depend on the concurrency, and reuse clones the PNGs of the routes it did not capture', async (t) => {
  if (!(await requireBrowser(t))) return;
  const src = join(work, 'cap-src'), dist = join(work, 'cap-dist');
  cpSync(HARNESS_SITE_SRC, src, { recursive: true });
  renderHarnessSite(src, dist);
  const site = await serveDir(dist);
  try {
    const vps = [VIEWPORTS[0], VIEWPORTS[2]];
    const shape = (s) => JSON.stringify(Object.fromEntries(Object.entries(s.routes).map(([r, cells]) => [r, Object.entries(cells).map(([vp, c]) => [vp, c.domHash, c.docHeight, c.tabOrder, Object.keys(c.layout)])])));
    const one = await captureSnapshot({ baseUrl: site.url, routes: ['/', '/about'], dir: join(work, 'cap-1'), viewports: vps, perfRuns: 0, concurrency: 1 });
    const many = await captureSnapshot({ baseUrl: site.url, routes: ['/', '/about'], dir: join(work, 'cap-3'), viewports: vps, perfRuns: 0, concurrency: 3 });
    assert.equal(shape(many), shape(one));
    assert.deepEqual(Object.keys(many.routes['/']), vps.map((v) => `${v.width}x${v.height}`), 'cells stored in viewport order');
    const part = await captureSnapshot({ baseUrl: site.url, routes: ['/', '/about'], dir: join(work, 'cap-r'), viewports: vps, perfRuns: 0, reuse: { snapshot: one, routes: ['/'] } });
    assert.deepEqual(part.reused, { routes: 1, cells: 2, perf: 0 });
    assert.equal(shape(part), shape(one));
    assert.deepEqual(readdirSync(join(work, 'cap-r')).filter((f) => f.endsWith('.png')).sort(), readdirSync(join(work, 'cap-1')).filter((f) => f.endsWith('.png')).sort(), 'the reused cells have their PNGs next to the new ones');
  } finally { await site.close(); }
});

// ---- node_modules and the vite dep cache stay out of the original project
test('shareNodeModules links the packages but never the tool caches: the shadow gets its own node_modules/.vite', async () => {
  const dir = join(work, 'nm', 'proj');
  mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/.vite/deps'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/.vite-temp'), { recursive: true }); // vite writes its bundled config here
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dep/package.json'), '{"name":"dep","version":"1.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules/dep/index.js'), 'module.exports = 1;');
  writeFileSync(join(dir, 'build.cjs'), "require('dep'); require('fs').mkdirSync('dist', { recursive: true });");
  const stopHere = { async start(shadow) { throw Object.assign(new Error('site stub reached'), { shadow }); } };
  await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { build: { command: 'node', args: ['build.cjs'] }, routes: ['/'], runDir: join(work, 'nm', 'run'), keepShadow: true, site: stopHere } }), /site stub reached/);
  const nm = join(work, 'nm', 'run', 'shadow', 'node_modules');
  assert.equal(lstatSync(nm).isSymbolicLink(), false, 'a real folder in the shadow');
  assert.equal(lstatSync(join(nm, 'dep')).isSymbolicLink(), true, 'packages are shared');
  assert.equal(existsSync(join(nm, '.vite')), false, 'the project dep cache is not linked');
  assert.equal(existsSync(join(nm, '.vite-temp')), false, 'the vite config temp folder is not linked (a write there would reach the original project)');
  assert.equal(lstatSync(join(nm, '.bin')).isSymbolicLink(), true, '.bin stays shared');
  assert.equal(existsSync(join(dir, 'node_modules/.vite/deps')), true, 'the project cache is untouched');
});

test('the vite site adapter keeps its dep cache in the shadow, never in a linked node_modules', async () => {
  const dir = join(work, 'vite-cache');
  cpSync(new URL('../fixtures/harness-paradox-fragments', import.meta.url).pathname, dir, { recursive: true });
  const real = join(work, 'vite-cache-real-nm');
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(dir, 'node_modules'), 'dir'); // the old whole-folder link
  const cfg = join(dir, 'vite.config.js');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('plugins: [{', "plugins: [{ name: 'probe', configResolved(c) { writeFileSync(join(c.root, 'cachedir.txt'), c.cacheDir); } }, {").replace("import { readFileSync, existsSync }", "import { readFileSync, existsSync, writeFileSync }"));
  const h = await createViteSiteAdapter().start(dir);
  try { assert.equal((await fetch(new URL('/about', h.url))).status, 200); } finally { await h.stop(); }
  const cacheDir = readFileSync(join(dir, 'cachedir.txt'), 'utf8');
  assert.ok(!cacheDir.includes('node_modules'), cacheDir);
  assert.match(cacheDir, /\.ada-scan[\\/]vite-cache$/);
  assert.equal(existsSync(join(real, '.vite')), false, 'nothing written through the link');
});

// ---- remaining report
const f = (id, rule, route = '/') => ({ stableId: id, nativeRuleId: rule, impact: 'serious', verdict: 'confirmed', ownership: 'source', route, element: { selector: `#${id}` } });
const n = (id, rule, route = '/') => ({ id, rule, native: rule, route, selector: `#${id}`, tier: 'confirmed' });
const shuffle = (xs, seed) => xs.map((x, i) => [x, Math.sin(seed * 7 + i * 13)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);

test('"not seen by the rescan" is the same for identical runs: deduped by defect and sorted, whatever order the report and the rescan list rows in', () => {
  const unseen = [f('u1', 'meta-viewport'), f('u2', 'meta-viewport'), f('u3', 'link-name', '/about'), f('u4', 'region', '/jobs')];
  // u1 and u2 are one defect reported under two ids; u3 and u4 are distinct
  unseen[1] = { ...unseen[1], element: { selector: '#u1' } };
  unseen[0] = { ...unseen[0], verdict: 'needs-review' }; // the same defect under a lower tier on one id: the list shows the highest tier, not whichever id sorts first
  const seenRows = [n('a', 'button-name'), n('b', 'image-alt', '/about'), n('c', 'label', '/jobs')];
  const base = [...seenRows, n('d', 'button-name', '/about')], final = seenRows;
  const runs = [1, 2, 3, 4].map((seed) => {
    const report = { pages: shuffle([{ route: '/', findings: shuffle([f('a', 'button-name'), unseen[0], unseen[1]], seed) }, { route: '/about', findings: shuffle([f('b', 'image-alt', '/about'), f('d', 'button-name', '/about'), unseen[2]], seed) }, { route: '/jobs', findings: shuffle([f('c', 'label', '/jobs'), unseen[3]], seed) }], seed) };
    return buildRemainingReport({ report, tasks: [], results: [], baselineFindings: shuffle(base, seed), finalFindings: shuffle(final, seed), finalScan: { proved: true }, scanDelta: { before: 4, after: 3 } });
  });
  assert.equal(runs[0].totals.notRescanned, 3, 'two ids of one defect count once');
  assert.equal(runs[0].notRescanned[0].tier, 'confirmed');
  for (const r of runs) {
    assert.equal(r.totals.notRescanned, 3);
    assert.deepEqual(r.notRescanned.map((x) => `${x.route} ${x.rule}`), ['/ meta-viewport', '/about link-name', '/jobs region']);
    assert.equal(renderRemainingMarkdown(r), renderRemainingMarkdown(runs[0]), 'the written report is identical too');
    assert.deepEqual(r.remaining.map((x) => x.id), runs[0].remaining.map((x) => x.id));
  }
  // a defect the rescan did see is not listed (no false "not seen")
  assert.equal(runs[0].notRescanned.some((x) => x.rule === 'button-name'), false);
});

test('queued edits are listed in remaining.md with their location; in the working-tree flow the text says the edit stays in the tree', () => {
  const report = { pages: [{ route: '/', findings: [f('a', 'button-name')] }] };
  const tasks = [{ id: 'T1', ids: ['a'], rule: 'button-name' }];
  const results = [{ taskId: 'T1', outcome: 'queued' }];
  const queuedEdits = [{ taskId: 'T1', rule: 'button-name', file: 'src/partials/header.liquid', line: 3, files: ['src/partials/header.liquid'], routes: ['/'], review: { registered: false, reason: 'STALE_AFTER_ACCEPTED_TASK' } }];
  const base = { report, tasks, results, baselineFindings: [n('a', 'button-name')], finalFindings: [n('a', 'button-name')], finalScan: { proved: true }, scanDelta: { before: 1, after: 1 }, queuedEdits };
  const wt = buildRemainingReport({ ...base, workingTree: true });
  assert.equal(wt.perClass.awaiting_review, 1);
  assert.equal(wt.queuedEdits.length, 1);
  const md = renderRemainingMarkdown(wt);
  assert.match(md, /## Queued edits: all gates passed, a person decides \(1\)/);
  assert.match(md, /button-name src\/partials\/header\.liquid:3, task T1: the edit is in your working tree and stays there/);
  assert.match(md, /not registered for review: STALE_AFTER_ACCEPTED_TASK/);
  assert.match(md, /the edit is still in your working tree/);
  assert.match(renderRemainingMarkdown(buildRemainingReport(base)), /registered for the review workbench/);
  assert.equal(wt.zeroRemainingClaim, false);
  assert.doesNotMatch(renderRemainingMarkdown(buildRemainingReport({ ...base, queuedEdits: [] })), /Queued edits/);
});

// ---- retarget: one hunk, not the last
const L = ['<div>', '<p>x</p>', '<img class="logo" src="/a.png">', '<p>1</p>', '<p>2</p>', '<p>3</p>', '<button class="go" id="go-btn"><span></span></button>', '<p>4</p>', '<p>5</p>', '<p>6</p>', '<p>7</p>', '<p>8</p>', '</div>'];
function retargetLine(edits) {
  const dir = mkdtempSync(join(tmpdir(), 'm3-wt-'));
  try {
    mkdirSync(join(dir, 'src'));
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'src/a.liquid'), `${L.join('\n')}\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
    const ed = [...L];
    for (const [line, text] of Object.entries(edits)) ed[Number(line) - 1] = text;
    writeFileSync(join(dir, 'src/a.liquid'), `${ed.join('\n')}\n`);
    const raw = { id: 't1', rule: 'x', source: { file: 'src/a.liquid', line: 7 }, element: { html: '<button class="go" id="go-btn">', selector: '#go-btn' }, occurrences: [], pages: ['/'] };
    const fixer = createWorkingTreeFixer({ dir });
    fixer.setTasks([normalizeTask(raw)]);
    return fixer.retarget([raw])[0].source.line;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('retarget: a task that owns several hunks sits on the hunk that holds its element, else the first, never the last', () => {
  const btn = '<button class="go" id="go-btn" aria-label="Go"><span></span></button>';
  assert.equal(retargetLine({ 7: btn, 9: '<p class="q">5</p>' }), 7, 'element hunk first, a plain hunk after it: the old code moved the line to 9');
  assert.equal(retargetLine({ 4: '<p class="q">1</p>', 7: btn }), 7, 'the element is only in the later hunk: that one');
  assert.equal(retargetLine({ 4: '<p class="q">1</p>', 9: '<p class="q">5</p>' }), 4, 'no hunk names the element: the first');
  assert.equal(retargetLine({ 7: btn }), 7, 'one hunk: unchanged');
});

// ---- export: index.js and the capped, distance-ordered h1 candidates
const axe = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const row = (ruleId, selector, outerHTML) => ({ ruleId, layer: 'axe', impact: 'serious', verdict: 'confirmed', wcagRef: 'wcag2a', element: { selector, outerHTML }, fix: { hint: 'x' }, evidence: { failureSummary: 'm' } });
const reportFor = (pages) => buildScanReportV2(pages.map(([route, violations]) => ({ name: route, page: route, url: `https://e.test${route}`, scannerRuns: [axe], violations })), { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'local-only', url: 'http://localhost:1234/' } });
const put = (root, rel, text) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

test('export: scriptFiles lead with src/scripts/index.js (the module wiring), with or without a tabindex match in it', () => {
  const root = mkdtempSync(join(tmpdir(), 'm3-js-'));
  try {
    put(root, 'src/scripts/index.js', "import './header.js';\n");
    put(root, 'src/scripts/header.js', "el.setAttribute('tabindex', '-1');\n");
    put(root, 'src/scripts/other.js', 'export const x = 1;\n');
    const report = reportFor([['/', [row('menu-links-unreachable-by-keyboard', '.nav a', '<a href="/x">x</a>')]]]);
    const task = buildTaskSet(report, { sourceRoot: root }).tasks[0];
    assert.deepEqual(task.scriptFiles, ['src/scripts/index.js', 'src/scripts/header.js']);
    assert.ok(task.evidence.some((e) => /Candidates: src\/scripts\/index\.js, src\/scripts\/header\.js/.test(e)));
    assert.ok(normalizeTask(task).allowlist.some((e) => e.file === 'src/scripts/index.js'), 'the harness scopes it too');
    rmSync(join(root, 'src/scripts/index.js'));
    assert.deepEqual(buildTaskSet(report, { sourceRoot: root }).tasks[0].scriptFiles, ['src/scripts/header.js'], 'no index.js, nothing invented');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('export: the h1 candidate list is capped and ordered by dependency distance (page templates before the partials they render)', () => {
  const root = mkdtempSync(join(tmpdir(), 'm3-h1-'));
  try {
    const routes = Array.from({ length: 9 }, (_, i) => `/p${i}`);
    for (const [i, r] of routes.entries()) {
      put(root, `src/pages/p${i}.liquid`, `<main>{% render "p${i}/a" %}{% render "p${i}/b" %}</main>\n`);
      put(root, `src/partials/p${i}/a.liquid`, '<section></section>\n');
      put(root, `src/partials/p${i}/b.liquid`, '<section></section>\n');
    }
    const report = reportFor(routes.map((r) => [r, [row('page-has-heading-one', 'html', '<html>')]]));
    const h1 = buildTaskSet(report, { sourceRoot: root }).tasks.find((t) => t.rule === 'page-has-heading-one');
    const files = h1.locateManually.likely.map((l) => l.file);
    assert.equal(files.length, 12, 'capped');
    assert.deepEqual(files.slice(0, 9), routes.map((_, i) => `src/pages/p${i}.liquid`), 'every page template (distance 0) comes before any partial (distance 1)');
    assert.ok(files.slice(9).every((x) => x.startsWith('src/partials/p0/') || x.startsWith('src/partials/p1/') || x.startsWith('src/partials/p2/')), 'then the partials, in page order');
    assert.equal(h1.locateManually.likelyOmitted, 15, '9 templates + 18 partials = 27 candidates, 12 listed');
    assert.equal(normalizeTask(h1).locateFiles.length, 12, 'the harness scope is capped with it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- concurrency config: a bad value must not start zero workers (that would read as "nothing found")
test('a non-numeric or non-positive concurrency is refused by the config and falls back to 1 when a module is called directly', async (t) => {
  for (const key of ['scanConcurrency', 'snapshotConcurrency']) for (const bad of ['abc', 0, -1, 1.5, NaN]) {
    const dir = join(work, 'bad-conc');
    mkdirSync(dir, { recursive: true });
    await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { build: { command: 'node', args: ['-e', '0'] }, [key]: bad } }), (e) => e.code === 'CONFIG_INVALID' && e.message.includes(key));
  }
  if (!(await requireBrowser(t))) return;
  const src = join(work, 'bc-src'), dist = join(work, 'bc-dist');
  cpSync(HARNESS_SITE_SRC, src, { recursive: true });
  renderHarnessSite(src, dist);
  const site = await serveDir(dist);
  try {
    const snap = await captureSnapshot({ baseUrl: site.url, routes: ['/', '/about'], dir: join(work, 'bc-snap'), viewports: [VIEWPORTS[0]], perfRuns: 0, concurrency: 'abc' });
    assert.equal(Object.keys(snap.routes['/'] || {}).length, 1, 'cells were captured, not skipped');
    assert.equal(Object.keys(snap.routes['/about'] || {}).length, 1);
    const { createCliScanner } = await import('../../src/fix/harness/scanner-cli.js');
    const r = await createCliScanner({ concurrency: 'abc' })({ workspaceRoot: work, siteUrl: site.url, routes: ['/', '/about'] });
    assert.ok(r.findings.some((x) => x.route === '/about') && r.findings.some((x) => x.route === '/'), 'both routes were scanned');
  } finally { await site.close(); }
});
