// End-to-end runner tests on the neutral harness-site fixture with a scripted fake fixer and a fake scanner (no CIS, no real-site scan).
import '../helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireBrowser } from '../helpers/require-browser.js';
import { HARNESS_SITE_SRC } from '../helpers/harness-site.mjs';
import { runHarness, readTree, VIEWPORTS } from '../../src/fix/harness/index.js';
import { closeBrowser } from '../../src/scanner/browser.js';

const work = mkdtempSync(join(tmpdir(), 'harness-runner-'));
after(async () => { await closeBrowser(); rmSync(work, { recursive: true, force: true }); });

const HEADER = 'src/partials/header.liquid', CSS = 'src/styles/site.css', INDEX = 'src/pages/index.liquid', ABOUT = 'src/pages/about.liquid';

function makeProject(name) {
  const dir = join(work, name, 'proj');
  mkdirSync(dir, { recursive: true });
  cpSync(HARNESS_SITE_SRC, join(dir, 'src'), { recursive: true });
  const helper = new URL('../helpers/harness-site.mjs', import.meta.url).href;
  writeFileSync(join(dir, 'build.mjs'), `import { renderHarnessSite } from ${JSON.stringify(helper)};\nrenderHarnessSite('src', 'dist');\n`);
  return dir;
}
const treeHash = (dir) => {
  const h = createHash('sha256');
  for (const [k, v] of [...readTree(dir)].sort(([a], [b]) => a.localeCompare(b))) h.update(k).update(v);
  return h.digest('hex');
};

// Fake scanner: reads the served pages and reports a nameless button and an img without alt (what the real scanner would flag).
async function fakeScanner({ siteUrl, routes }) {
  const findings = [];
  for (const route of routes) {
    const html = await (await fetch(new URL(route, siteUrl))).text();
    if (/<button\b(?![^>]*aria-label)[^>]*>\s*<span/.test(html)) findings.push({ findingId: `btn|${route}`, canonicalRuleId: 'button-name', route, selector: '#menu-btn' });
    if (/<img\b(?![^>]*\balt=)[^>]*>/.test(html)) findings.push({ findingId: `img|${route}`, canonicalRuleId: 'image-alt', route, selector: 'img' });
  }
  return { findings, executedLayers: ['fake'], sourceTraceResolved: true };
}

const BTN_TASK = { id: 'btn', rule: 'button-name', source: { file: HEADER, line: 3 }, pages: ['/'], occurrences: [{ route: '/', selector: '#menu-btn', stableId: 'sid-btn' }], ids: ['sid-btn'] };
const IMG_TASK = { id: 'img', rule: 'image-alt', source: { file: INDEX, line: 15 }, pages: ['/'], occurrences: [{ route: '/', selector: 'img', stableId: 'sid-img' }], ids: ['sid-img'] };

const cfgFor = (name, extra = {}) => ({
  build: { command: 'node', args: ['build.mjs'] }, routes: ['/'], viewports: [VIEWPORTS[0], VIEWPORTS[2]], perfRuns: 0, scanner: fakeScanner,
  runDir: join(work, name, 'run'), keepShadow: true, snapshotBudgetMs: 120000, ...extra,
});
const fixerOf = (fn, extra = {}) => ({ name: 'scripted', ...extra, async propose(task, ctx) { return fn(task, ctx); } });
const swap = (ctx, path, from, to) => { const before = ctx.read(path); assert.ok(before.includes(from), `fixture drift: ${from}`); return { path, before, after: before.replace(from, to) }; };
const goodBtn = (ctx) => swap(ctx, HEADER, '<button class="menu-btn"', '<button class="menu-btn" aria-label="Menu"');
const row = (res, id) => res.tasks.find((t) => t.taskId === id);

test('good fix is accepted, kept, applied to the project; perf runner is injected; remaining report does not claim zero while the rescan still finds something', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('good');
  let perfCalls = 0;
  const perfRunner = async () => { perfCalls++; return { score: 90, lcp: 1000, fcp: 800, cls: 0, tbt: 0, si: 1000, transfer: 5000 }; };
  const res = await runHarness({ projectDir: proj, tasks: [BTN_TASK], fixer: fixerOf((_, ctx) => ({ files: [goodBtn(ctx)], rationale: 'name the icon button' }), { mechanicallySafe: true }), config: cfgFor('good', { perfRuns: 3, perfRunner }) });
  assert.equal(row(res, 'btn').outcome, 'accepted', JSON.stringify(row(res, 'btn').evidence));
  assert.deepEqual(res.accepted, ['btn']);
  assert.equal(res.gatesSkipped.length, 0);
  assert.ok(perfCalls === 6, 'perfRunner ran for the baseline and the candidate snapshots');
  assert.match(res.diff, /^\+.*aria-label="Menu"/m);
  assert.equal(res.scanDelta.fixed, 1);
  assert.equal(res.scanDelta.added, 0);
  assert.equal(res.applied, true);
  assert.match(readFileSync(join(proj, HEADER), 'utf8'), /aria-label="Menu"/);
  assert.equal(readFileSync(join(proj, HEADER), 'utf8'), readFileSync(join(res.shadowRoot, HEADER), 'utf8'), 'shadow keeps the accepted change');
  assert.equal(res.status, 'complete');
  assert.equal(res.remaining.zeroRemainingClaim, false, 'the final rescan still finds the image without alt: never a zero claim');
  assert.equal(res.remaining.scanDelta.after, 1);
  assert.equal(res.remaining.totals.fixed, 1);
  assert.match(readFileSync(res.files.remainingMarkdown, 'utf8'), /Zero remaining claimed: no/);
});

test('padding change is rolled back by G3, G4, G5; the repair gets the failed-gate evidence; atomic rollback restores bytes', async (t) => {
  if (!(await requireBrowser(t))) return;
  const task = { ...BTN_TASK, allowlist: [{ file: HEADER, startLine: 1, endLine: 6 }, { file: CSS }] };
  const bad = (ctx) => ({ files: [goodBtn(ctx), swap(ctx, CSS, 'padding: 12px 24px', 'padding: 28px 24px')], rationale: 'also tweak padding' });

  // K = 1: first candidate fails, the fixer sees the evidence and sends a clean one.
  const proj = makeProject('pad');
  const seen = [];
  const res = await runHarness({ projectDir: proj, tasks: [task], fixer: fixerOf((_, ctx) => { seen.push(ctx.gateEvidence); return ctx.iteration === 1 ? bad(ctx) : { files: [goodBtn(ctx)] }; }), config: cfgFor('pad', { maxRepairs: 1, dryRun: true }) });
  const r = row(res, 'btn');
  assert.equal(r.iterations.length, 2);
  assert.deepEqual(r.iterations[0].failedGates, ['G3', 'G4', 'G5']);
  assert.equal(seen[0], null);
  assert.deepEqual(seen[1].map((g) => g.gate), ['G3', 'G4', 'G5']);
  assert.ok(seen[1][0].evidence.length > 0);
  assert.equal(r.outcome, 'accepted');

  // K = 0: closed as rolled back; every byte of the shadow equals the project again.
  const proj0 = makeProject('pad0');
  const before = treeHash(join(proj0, 'src'));
  const res0 = await runHarness({ projectDir: proj0, tasks: [task], fixer: fixerOf((_, ctx) => bad(ctx)), config: cfgFor('pad0', { maxRepairs: 0 }) });
  const r0 = row(res0, 'btn');
  assert.equal(r0.outcome, 'rolled_back');
  assert.deepEqual(r0.failedGates, ['G3', 'G4', 'G5']);
  assert.ok(r0.evidence.find((g) => g.gate === 'G3').evidence.length > 0);
  assert.equal(treeHash(join(res0.shadowRoot, 'src')), before, 'sha256 of the shadow tree equals the original after rollback');
  assert.equal(treeHash(join(proj0, 'src')), before, 'project untouched');
  assert.equal(res0.diff, '');
  assert.equal(res0.remaining.remaining[0].cls, 'gate_failed');
  assert.deepEqual(res0.remaining.remaining[0].gates, ['G3', 'G4', 'G5']);
});

test('design lock, backend tag and allowlist violations are rejected before anything is applied', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('lock');
  const wide = { allowlist: [{ file: HEADER, startLine: 1, endLine: 6 }, { file: CSS }] };
  const tasks = [{ ...BTN_TASK, id: 'colour', ...wide }, { ...BTN_TASK, id: 'pdk', ...wide }, { ...BTN_TASK, id: 'outside', ...wide }];
  const fixer = fixerOf((task, ctx) => ({
    colour: () => ({ files: [swap(ctx, CSS, 'margin: 0 0 8px; color: #222;', 'margin: 0 0 8px; color: #b00020;')] }),
    pdk: () => ({ files: [swap(ctx, HEADER, ' data-pdk-region="header"', '')] }),
    outside: () => ({ files: [swap(ctx, ABOUT, '<h1>', '<h1 id="x">')] }),
  })[task.id]());
  const res = await runHarness({ projectDir: proj, tasks, fixer, config: cfgFor('lock', { maxRepairs: 0 }) });
  assert.equal(res.builds, 1, 'no candidate was ever built: all rejected before apply');
  const kinds = (id) => row(res, id).evidence[0].evidence.map((e) => e.kind);
  for (const id of ['colour', 'pdk', 'outside']) { assert.equal(row(res, id).outcome, 'rejected'); assert.deepEqual(row(res, id).failedGates, ['G2']); assert.equal(row(res, id).iterations[0].stage, 'pre_apply'); }
  assert.ok(kinds('colour').includes('DESIGN_TOKEN_REMOVED_OR_EDITED'));
  assert.ok(kinds('pdk').includes('BACKEND_TOKEN_REMOVED_OR_EDITED'));
  assert.ok(kinds('outside').includes('FILE_NOT_ALLOWLISTED'));
  assert.equal(treeHash(join(res.shadowRoot, 'src')), treeHash(join(proj, 'src')));
});

test('cumulative acceptance (second task verified on top of the first); dry run writes nothing to the project', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('cum');
  const before = treeHash(proj);
  let sawFirst = false;
  const fixer = fixerOf((task, ctx) => {
    if (task.id === 'img') return { files: [swap(ctx, INDEX, '<img src="/pic.svg"', '<img alt="" src="/pic.svg"')] };
    sawFirst = ctx.read(INDEX).includes('alt=""');
    return { files: [goodBtn(ctx)] };
  }, { mechanicallySafe: true });
  const res = await runHarness({ projectDir: proj, tasks: [BTN_TASK, IMG_TASK], fixer, config: cfgFor('cum', { dryRun: true }) });
  assert.deepEqual(res.accepted, ['img', 'btn'], 'files ascending');
  assert.ok(sawFirst, 'the second task saw the first accepted change in the shadow');
  assert.equal(res.scanDelta.fixed, 2);
  assert.equal(res.scanDelta.added, 0);
  assert.match(res.diff, /pages\/index\.liquid/);
  assert.match(res.diff, /partials\/header\.liquid/);
  assert.equal(res.applied, false);
  assert.equal(res.applyStatus, 'dry_run');
  assert.equal(treeHash(proj), before, 'dry run: project bytes identical');
});

test('a clean but large, not mechanically safe change is queued for review with evidence and kept out of the shadow', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('queue');
  const fixer = fixerOf((_, ctx) => {
    const f = goodBtn(ctx);
    const lines = f.after.split('\n');
    lines.splice(3, 0, ...Array.from({ length: 11 }, (_, i) => `<!-- note ${i} -->`));
    return { files: [{ ...f, after: lines.join('\n') }] };
  });
  const res = await runHarness({ projectDir: proj, tasks: [BTN_TASK], fixer, config: cfgFor('queue') });
  const r = row(res, 'btn');
  assert.equal(r.outcome, 'queued', JSON.stringify(r.iterations.map((i) => [i.stage, i.failedGates, i.reason])));
  assert.equal(r.decision, 'human_review');
  assert.equal(r.review.registered, true, r.review.reason);
  assert.ok(r.evidencePack.gateTable.every((g) => g.pass));
  assert.ok(r.evidencePack.screenshots.after.length >= 2);
  assert.equal(res.remaining.remaining[0].cls, 'awaiting_review');
  assert.equal(res.applied, false);
  assert.doesNotMatch(readFileSync(join(res.shadowRoot, HEADER), 'utf8'), /aria-label/);
  assert.doesNotMatch(readFileSync(join(proj, HEADER), 'utf8'), /aria-label/);
});

test('fails closed without a build; unknown fixer shape; declines and errors are closed without a loop', async (t) => {
  await assert.rejects(() => runHarness({ projectDir: work, tasks: [], fixer: fixerOf(() => null), config: {} }), { code: 'BUILD_CONFIG_MISSING' });
  await assert.rejects(() => runHarness({ projectDir: work, tasks: [], fixer: {}, config: cfgFor('x') }), { code: 'FIXER_INVALID' });
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('decline');
  const res = await runHarness({ projectDir: proj, tasks: [BTN_TASK, IMG_TASK], fixer: fixerOf((task) => { if (task.id === 'btn') return { declined: 'needs a human label' }; throw new Error('boom'); }), config: cfgFor('decline', { dryRun: true }) });
  assert.equal(row(res, 'btn').outcome, 'declined');
  assert.equal(row(res, 'img').outcome, 'declined');
  assert.equal(row(res, 'btn').iterations.length, 1);
  const rem = Object.fromEntries(res.remaining.remaining.map((x) => [x.rule, x.cls]));
  assert.equal(rem['button-name'], 'needs_human_content');
  assert.equal(rem['image-alt'], 'needs_human_content');
});

test('a project file edited by the user during the run is never overwritten by the final apply', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('drift');
  const res = await runHarness({ projectDir: proj, tasks: [BTN_TASK], fixer: fixerOf((_, ctx) => { writeFileSync(join(proj, HEADER), `${readFileSync(join(proj, HEADER), 'utf8')}<!-- user edit -->\n`); return { files: [goodBtn(ctx)] }; }, { mechanicallySafe: true }), config: cfgFor('drift') });
  assert.match(res.applyStatus, /^project_changed:/);
  assert.equal(res.applied, false);
  assert.equal(res.status, 'incomplete');
  assert.match(readFileSync(join(proj, HEADER), 'utf8'), /user edit/);
});

test('rescans are kept in the run dir, remaining is counted from the final rescan, an editor fixer is not asked to repair, a declined task carries a reasonClass', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('h5');
  const task = { ...BTN_TASK, allowlist: [{ file: HEADER, startLine: 1, endLine: 6 }, { file: CSS }] };
  let asked = 0;
  const bad = (ctx) => ({ files: [goodBtn(ctx), swap(ctx, CSS, 'padding: 12px 24px', 'padding: 28px 24px')] });
  const res = await runHarness({ projectDir: proj, tasks: [task, IMG_TASK], fixer: fixerOf((tk, ctx) => { if (tk.id === 'img') return { declined: 'no hunk' }; asked++; return bad(ctx); }, { noRepair: true }), config: cfgFor('h5', { maxRepairs: 2, dryRun: true }) });
  assert.equal(asked, 1, 'a rolled-back editor edit is not replayed');
  assert.equal(row(res, 'btn').iterations.length, 1);
  assert.equal(row(res, 'img').reasonClass, 'needs_human_content');
  const rep = JSON.parse(readFileSync(res.files.report, 'utf8'));
  assert.equal(rep.tasks.find((x) => x.taskId === 'img').reasonClass, 'needs_human_content');
  assert.ok(rep.scans.baseline && readFileSync(join(res.runDir, rep.scans.baseline), 'utf8').includes('"findings"'));
  assert.ok(rep.scans['t1-1'] || Object.keys(rep.scans).length >= 2, 'a candidate rescan is kept too');
  assert.equal(res.remaining.source, 'final-rescan');
  assert.equal(res.remaining.totals.remaining, res.remaining.totals.finalRescan);
  assert.equal(res.remaining.totals.finalRescan, res.scanDelta.after);
});

test('a truncated baseline stops the run as baseline-incomplete: no task is tried or rolled back, nothing is gate_failed, the message names snapshotBudgetMs', async (t) => {
  if (!(await requireBrowser(t))) return;
  const proj = makeProject('trunc');
  let proposed = 0;
  const res = await runHarness({ projectDir: proj, tasks: [BTN_TASK, IMG_TASK], fixer: fixerOf((_, ctx) => { proposed++; return { files: [goodBtn(ctx)] }; }), config: cfgFor('trunc', { snapshotBudgetMs: -1 }) });
  assert.equal(proposed, 0, 'the fixer is never asked');
  assert.equal(res.status, 'incomplete');
  assert.deepEqual(res.tasks.map((r) => [r.outcome, r.reasonClass]), [['skipped', 'baseline_incomplete'], ['skipped', 'baseline_incomplete']]);
  assert.ok(res.tasks.every((r) => !r.failedGates.length));
  assert.equal(res.environment.class, 'baseline-incomplete');
  assert.match(res.incomplete.join('\n'), /baseline snapshot truncated.*snapshotBudgetMs = -1 ms/);
  assert.equal(res.remaining.remaining.filter((r) => r.cls === 'gate_failed').length, 0);
  assert.ok(res.remaining.remaining.some((r) => r.cls === 'baseline_incomplete'));
  assert.equal(res.remaining.zeroRemainingClaim, false);
  assert.equal(readFileSync(join(proj, HEADER), 'utf8').includes('aria-label="Menu"'), false, 'the project is untouched');
  // healthy baseline, same tasks: the run proceeds as before (the true path is not lost)
  const ok = await runHarness({ projectDir: makeProject('trunc-ok'), tasks: [BTN_TASK], fixer: fixerOf((_, ctx) => ({ files: [goodBtn(ctx)] }), { mechanicallySafe: true }), config: cfgFor('trunc-ok') });
  assert.equal(ok.environment, undefined);
  assert.equal(row(ok, 'btn').outcome, 'accepted');
});
