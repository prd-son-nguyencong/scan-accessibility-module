// Pure and filesystem tests for the harness modules around the runner: perf, build checks, remaining report, policy and review queue, edits, CLI wiring.
import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLighthousePerfRunner, perfFromLhr, medianPerf, checkExport, checkFormatter, countHtmlValidateErrors, collectBuildFacts, dirSize,
  buildRemainingReport, renderRemainingMarkdown, REASON_CLASSES, decide, queueForReview, fileToEdits, unifiedDiff, changedLineCount, loadHarnessConfig, runHarness,
} from '../../src/fix/harness/index.js';
import { runFixSubcommand } from '../../src/index.js';
import { loadReviewState } from '../../src/fix/review/state.js';

const tmp = (n) => mkdtempSync(join(tmpdir(), `harness-${n}-`));
const lhr = (score, lcp) => ({ categories: { performance: { score, auditRefs: [{ id: 'x' }] } }, audits: { x: { score: 1 }, 'largest-contentful-paint': { numericValue: lcp }, 'cumulative-layout-shift': { numericValue: 0.01 }, 'total-blocking-time': { numericValue: 20 }, 'first-contentful-paint': { numericValue: 500 }, 'speed-index': { numericValue: 900 }, 'total-byte-weight': { numericValue: 4000 } } });

test('perf: lhr -> run shape, median, injectable runner, failed runs are absent, all failed throws', async () => {
  assert.deepEqual(perfFromLhr(lhr(0.91, 1200)), { score: 91, lcp: 1200, cls: 0.01, tbt: 20, fcp: 500, si: 900, transfer: 4000, transferBytes: 4000 });
  assert.equal(medianPerf([{ lcp: 1 }, { lcp: 5 }, { lcp: 3 }]).lcp, 3);
  const seen = [];
  const lcps = [1000, 3000, 2000];
  const runner = createLighthousePerfRunner({ runs: 3, runner: async (url, device) => { seen.push([url, device]); return lhr(0.9, lcps[seen.length - 1]); } });
  const out = await runner(null, 'http://127.0.0.1:1/');
  assert.equal(out.lcp, 2000);
  assert.deepEqual(seen[0], ['http://127.0.0.1:1/', 'desktop']);
  let n = 0;
  assert.equal((await createLighthousePerfRunner({ runs: 2, runner: async () => { if (n++ === 0) throw new Error('x'); return lhr(0.8, 1); } })(null, 'u')).score, 80);
  await assert.rejects(() => createLighthousePerfRunner({ runner: async () => { throw new Error('boom'); } })(null, 'u'), /boom/);
  await assert.rejects(() => createLighthousePerfRunner({ runner: async () => ({ categories: {}, audits: {} }) })(null, 'u'), /could not score/);
});

test('build checks: export validity, formatter skip notes, html-validate counts, output size', async () => {
  const root = tmp('bc');
  mkdirSync(join(root, 'dist'));
  assert.deepEqual(checkExport({ root }), { applicable: false, valid: true, file: 'dist/paradox-export.json', reason: 'no export plugin or export file in the project' });
  writeFileSync(join(root, 'dist/paradox-export.json'), '{"pages":[1],"layouts":[]}');
  assert.equal(checkExport({ root }).valid, true);
  assert.equal(checkExport({ root, baselineKeys: ['pages', 'scripts'] }).reason, 'EXPORT_KEYS_LOST');
  writeFileSync(join(root, 'dist/paradox-export.json'), '{oops');
  assert.equal(checkExport({ root }).reason, 'EXPORT_INVALID_JSON');
  writeFileSync(join(root, 'dist/paradox-export.json'), '{}');
  assert.equal(checkExport({ root }).reason, 'EXPORT_EMPTY');
  assert.ok(dirSize(join(root, 'dist')) > 0);
  assert.equal(dirSize(join(root, 'nope')), 0);

  writeFileSync(join(root, 'a.liquid'), 'x');
  assert.match((await checkFormatter({ root, files: ['a.liquid'] })).note, /no prettier config/);
  writeFileSync(join(root, '.prettierrc.json'), '{}');
  assert.match((await checkFormatter({ root, files: ['a.liquid'] })).note, /not installed/);
  writeFileSync(join(root, 'fail.mjs'), 'process.exit(1);');
  assert.equal((await checkFormatter({ root, files: ['a.liquid'], formatCheck: { command: 'node', args: ['fail.mjs'] } })).clean, false);
  writeFileSync(join(root, 'ok.mjs'), 'process.exit(0);');
  assert.equal((await checkFormatter({ root, files: ['a.liquid'], formatCheck: { command: 'node', args: ['ok.mjs'] } })).clean, true);

  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => `<p>${url}</p>` });
  const validate = async () => [{ type: 'error' }, { type: 'warning' }, { type: 'error' }];
  const counted = await countHtmlValidateErrors({ baseUrl: 'http://127.0.0.1:1', routes: ['/', '/a'], validate, fetchImpl });
  const { hashes, ...rest } = counted;
  assert.deepEqual(rest, { total: 4, byRoute: { '/': 2, '/a': 2 }, skipped: [] });
  assert.deepEqual(Object.keys(hashes), ['/', '/a']);
  assert.notEqual(hashes['/'], hashes['/a'], 'a hash per served document: the incremental rescan tells changed routes apart by it');

  const facts = await collectBuildFacts({ root, buildResult: { ok: true, exitCode: 0, outputBytes: 5 }, outDir: 'dist', baseUrl: 'http://127.0.0.1:1', routes: ['/'], touchedFiles: [], baseline: { htmlErrors: { total: 2, byRoute: { '/': 2 } }, exportKeys: null }, config: { validateHtml: validate, fetchImpl } });
  assert.deepEqual(facts.facts.htmlValidate, { before: 2, after: 2 });

  // A route that answers 404 or makes html-validate throw is skipped and noted; it never aborts and cannot fake a regression.
  const flaky = async (url) => (url.endsWith('/404') ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => (url.endsWith('/boom') ? 'boom' : '<p>x</p>') });
  const picky = async (html) => { if (html === 'boom') throw new Error('Fatal error: parse'); return [{ type: 'error' }]; };
  const partial = await countHtmlValidateErrors({ baseUrl: 'http://127.0.0.1:1', routes: ['/', '/404', '/boom'], validate: picky, fetchImpl: flaky });
  assert.deepEqual([partial.total, partial.skipped.map((k) => k.route)], [1, ['/404', '/boom']]);
  assert.match(partial.skipped[0].reason, /answered 404/);
  const noisy = await collectBuildFacts({ root, buildResult: { ok: true, exitCode: 0, outputBytes: 5 }, outDir: 'dist', baseUrl: 'http://127.0.0.1:1', routes: ['/', '/404'], touchedFiles: [], baseline: { htmlErrors: { total: 1, byRoute: { '/': 1 } }, exportKeys: null }, config: { validateHtml: picky, fetchImpl: flaky } });
  assert.deepEqual(noisy.facts.htmlValidate, { before: 1, after: 1 });
  assert.ok(noisy.notes.some((n) => /html-validate skipped \/404: answered 404/.test(n)));
  const failed = await collectBuildFacts({ root, buildResult: { ok: false, exitCode: 1 }, outDir: 'dist', baseUrl: 'x', routes: [], touchedFiles: [], baseline: null });
  assert.equal(failed.facts.exportValid, null, 'unmeasured facts stay null so G8 fails closed');
});

test('edits: hunks become anchored edit intents; insertion, deletion, merge; CRLF refused; diff is stable', () => {
  const before = 'a\nb\nc\nd\ne\n';
  assert.equal(fileToEdits('x.liquid', before, before).length, 0);
  const ins = fileToEdits('x.liquid', before, 'a\nb\nNEW\nc\nd\ne\n');
  assert.equal(ins.length, 1);
  assert.deepEqual([ins[0].oldText, ins[0].newText, ins[0].blockRange], ['b', 'b\nNEW', { startLine: 2, endLine: 2 }]);
  const del = fileToEdits('x.liquid', before, 'a\nb\nd\ne\n');
  assert.deepEqual([del[0].oldText, del[0].newText], ['b\nc', 'b']);
  const two = fileToEdits('x.liquid', before, 'a\nB\nC\nd\ne\n');
  assert.deepEqual([two.length, two[0].oldText, two[0].newText], [1, 'a\nb\nc', 'a\nB\nC']);
  const apart = fileToEdits('x.liquid', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nB\nc\nd\ne\nF\ng\n');
  assert.equal(apart.length, 2);
  const touching = fileToEdits('x.liquid', 'a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n');
  assert.deepEqual(touching.map((e) => e.blockRange), [{ startLine: 1, endLine: 2 }, { startLine: 3, endLine: 4 }], 'adjacent ranges stay separate and do not overlap');
  const top = fileToEdits('x.liquid', before, 'TOP\na\nb\nc\nd\ne\n');
  assert.deepEqual([top[0].oldText, top[0].newText], ['a', 'TOP\na']);
  assert.throws(() => fileToEdits('x.liquid', 'a\r\nb', 'a\r\nc'), { code: 'CRLF_UNSUPPORTED' });
  assert.equal(changedLineCount(before, 'a\nB\nC\nd\ne\n'), 2);
  const d = unifiedDiff([{ path: 'x.liquid', before, after: 'a\nb\nNEW\nc\nd\ne\n' }]);
  assert.match(d, /^--- a\/x\.liquid\n\+\+\+ b\/x\.liquid\n@@ -1,\d \+1,\d @@\n a\n b\n\+NEW\n c\n d\n$/);
});

test('policy: auto-accept rules and the review override', () => {
  const pass = { pass: true, failed: [], gates: [], table: [] };
  assert.equal(decide({ gateResult: pass, mechanicallySafe: true, changedLines: 80 }).decision, 'auto_accept');
  assert.equal(decide({ gateResult: pass, changedLines: 3, files: ['a.liquid'] }).decision, 'auto_accept');
  assert.equal(decide({ gateResult: pass, changedLines: 30, files: ['a.liquid'] }).decision, 'human_review');
  assert.equal(decide({ gateResult: pass, changedLines: 3, files: ['a.js'] }).decision, 'human_review', 'a script file raises risk above the limit');
  assert.equal(decide({ gateResult: pass, mechanicallySafe: true, policy: { autoAccept: false } }).decision, 'human_review');
  const failed = decide({ gateResult: { pass: false, failed: ['G3'] }, iteration: 1, maxIterations: 3 });
  assert.deepEqual([failed.decision, failed.retry], ['rollback', true]);
  assert.equal(decide({ gateResult: { pass: false, failed: ['G3'] }, iteration: 3, maxIterations: 3 }).retry, false);
});

test('review queue: a queued candidate appears in the workbench state with its evidence; unregisterable items are reported', () => {
  const root = tmp('rq');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.liquid'), '<p>a</p>\n<button id="b"></button>\n<p>c</p>\n');
  const sessionDir = join(tmp('rqs'), 'review');
  const before = readFileSync(join(root, 'src/a.liquid'), 'utf8');
  const evidence = { decision: 'human_review', risk: 0.4, gateTable: [{ gate: 'G1', pass: true, issues: 0 }], screenshots: { before: [{ route: '/', viewport: '375x812', path: 'snapshots/baseline/root__375x812.png' }], after: [] }, scanDelta: { fixed: 1, added: 0 }, diff: '+x' };
  const out = queueForReview({
    sessionDir, localRoot: root,
    items: [
      { taskId: 'ok', rule: 'button-name', file: 'src/a.liquid', line: 2, routes: ['/'], findingIds: ['f1'], files: [{ path: 'src/a.liquid', before, after: before.replace('<button id="b">', '<button id="b" aria-label="B">') }], rationale: 'name it', evidence },
      { taskId: 'stale', rule: 'button-name', file: 'src/a.liquid', line: 2, routes: ['/'], findingIds: ['f2'], files: [{ path: 'src/a.liquid', before: 'something else\n', after: 'other\n' }], evidence },
    ],
  });
  assert.deepEqual(out.queued.map((q) => q.registered), [true, false]);
  assert.equal(out.queued[1].reason, 'STALE_PREIMAGE');
  const unit = { fixUnitId: 'harness-ok', kind: 'accessibility', title: 'x', canonicalRuleId: 'button-name', findingIds: ['f1'], status: 'ready', sourceOwner: { file: 'src/a.liquid', line: 2 }, evidence: [], affectedRoutes: ['/'], findings: [] };
  const state = loadReviewState({ sessionDir, reportId: 'sha256:harness-run', sessionId: 'harness', fixUnits: [unit, { ...unit, fixUnitId: 'harness-stale', findingIds: ['f2'] }], localRoot: root });
  const row = state.getSnapshot().units.find((u) => u.fixUnitId === 'harness-ok');
  assert.equal(row.candidate.harness.gateTable[0].gate, 'G1');
  assert.equal(row.candidate.harness.screenshots.before[0].path, 'snapshots/baseline/root__375x812.png');
  assert.equal(row.verified, true);
});

test('remaining report: every reason class, tiers, honest zero-remaining claim, incomplete runs claim nothing', () => {
  const f = (id, rule, extra = {}) => ({ stableId: id, nativeRuleId: rule, impact: 'serious', verdict: 'confirmed', ownership: 'source', element: { selector: `#${id}` }, ...extra });
  const report = { pages: [{ route: '/', findings: [
    f('fixed', 'button-name'), f('design', 'color-contrast'), f('vendor', 'region', { ownership: 'third-party', origin: { owner: 'third-party', vendor: 'consent' } }),
    f('unbound', 'document-title', { origin: { kind: 'unbound-data' } }), f('human', 'image-alt'), f('hard', 'heading-order'), f('gate', 'list'),
    f('queued', 'label'), f('review', 'target-size', { verdict: 'needs-review' }), f('untraced', 'landmark-one-main'), f('info', 'x', { impact: 'info' }),
    f('repro', 'link-in-text-block'),
  ] }] };
  const tasks = ['fixed', 'human', 'hard', 'gate', 'queued', 'repro'].map((id) => ({ id: `t-${id}`, ids: [id], rule: report.pages[0].findings.find((x) => x.stableId === id).nativeRuleId }));
  tasks.push({ id: 't-design', ids: ['design'], rule: 'color-contrast', requiresDesignDecision: true });
  const results = [
    { taskId: 't-fixed', outcome: 'accepted' }, { taskId: 't-human', outcome: 'declined', detail: 'needs text' }, { taskId: 't-hard', outcome: 'declined', detail: 'no safe edit' },
    { taskId: 't-gate', outcome: 'rolled_back', failedGates: ['G3', 'G5'], evidence: [] }, { taskId: 't-queued', outcome: 'queued' },
    { taskId: 't-repro', outcome: 'skipped', reasonClass: 'not_reproduced_locally', detail: 'x' }, { taskId: 't-design', outcome: 'skipped', reasonClass: 'needs_design_decision' },
  ];
  const r = buildRemainingReport({ report, tasks, results });
  const cls = Object.fromEntries(r.remaining.map((x) => [x.id, x.cls]));
  assert.deepEqual(cls, { design: 'needs_design_decision', vendor: 'platform_or_third_party', unbound: 'data_not_bound_locally', human: 'needs_human_content', hard: 'fixer_could_not_produce_safe_change', gate: 'gate_failed', queued: 'awaiting_review', review: 'needs_review_finding', untraced: 'not_traced', repro: 'not_reproduced_locally' });
  assert.equal(r.totals.fixed, 1);
  assert.equal(r.totals.unexplained, 0);
  assert.equal(r.perTier['needs-review'], 1);
  assert.equal(r.needsReviewOpen, 1);
  assert.deepEqual(r.remaining.find((x) => x.id === 'gate').gates, ['G3', 'G5']);
  assert.ok(Object.keys(r.perClass).every((c) => REASON_CLASSES.includes(c)));
  assert.equal(r.zeroRemainingClaim, false, 'explained findings still remain: never a zero claim');
  assert.equal(r.status, 'complete');
  const proof = { finalScan: { proved: true }, scanDelta: { before: 11, after: 10, fixed: 1, added: 0 } };
  assert.equal(buildRemainingReport({ report, tasks, results, ...proof }).zeroRemainingClaim, false, 'a final scan that still finds things proves nothing');
  const md = renderRemainingMarkdown(r);
  assert.match(md, /Zero remaining claimed: no/);
  assert.match(md, /Zero remaining is claimed only when no finding remains and the final scan of the final state found none/);
  assert.match(md, /## not_traced/);
  assert.match(md, /## needs_review_finding/);
  assert.match(md, /## gate_failed/);
  assert.doesNotMatch(md, new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
});

test('remaining report: zero is claimed only with nothing left and a final scan of the final state that found nothing; untraced tasks get not_traced', () => {
  const f = (id, rule, extra = {}) => ({ stableId: id, nativeRuleId: rule, impact: 'serious', verdict: 'confirmed', ownership: 'source', element: { selector: `#${id}` }, ...extra });
  const one = { pages: [{ route: '/', findings: [f('a', 'button-name')] }] };
  const tasks = [{ id: 't-a', ids: ['a'], rule: 'button-name' }];
  const fixed = [{ taskId: 't-a', outcome: 'accepted' }];
  const clean = { finalScan: { proved: true }, scanDelta: { before: 1, after: 0, fixed: 1, added: 0 } };
  assert.equal(buildRemainingReport({ report: one, tasks, results: fixed, ...clean }).zeroRemainingClaim, true);
  assert.equal(buildRemainingReport({ report: one, tasks, results: fixed, scanDelta: clean.scanDelta }).zeroRemainingClaim, false, 'no proof that the final scan ran');
  assert.equal(buildRemainingReport({ report: one, tasks, results: fixed, finalScan: { proved: true } }).zeroRemainingClaim, false, 'no scan delta');
  assert.equal(buildRemainingReport({ report: one, tasks, results: fixed, ...clean, incomplete: ['x'] }).zeroRemainingClaim, false);
  // Nothing fixed, findings remain: never a claim, even with a proved scan.
  const none = buildRemainingReport({ report: one, tasks: [], results: [], finalScan: { proved: true }, scanDelta: { before: 1, after: 1, fixed: 0, added: 0 } });
  assert.equal(none.zeroRemainingClaim, false);
  assert.equal(none.remaining[0].cls, 'not_traced');
  // A task the runner skipped as untraced keeps the same class instead of the fixer bucket.
  const skipped = buildRemainingReport({ report: one, tasks, results: [{ taskId: 't-a', outcome: 'skipped', reasonClass: 'not_traced', detail: 'no traced source file' }] });
  assert.equal(skipped.remaining[0].cls, 'not_traced');
  assert.equal(skipped.perClass.fixer_could_not_produce_safe_change, 0);
  assert.ok(REASON_CLASSES.includes('not_traced') && REASON_CLASSES.includes('needs_review_finding'));
});

test('CLI: fix --harness fails closed without a build config and stays scan-only for url-only reports; flags parse', async () => {
  const { buildScanReportV2 } = await import('../../src/reporter/report-v2.js');
  const dir = tmp('cli');
  const run = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
  const mk = (target) => buildScanReportV2([{ name: '/', page: '/', url: 'https://example.test/', scannerRuns: [run], violations: [] }], { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target });
  const reportPath = join(dir, 'latest.json');
  const base = ['--report', reportPath, '--source', dir, '--out-dir', join(dir, 'out'), '--harness'];
  writeFileSync(reportPath, JSON.stringify(mk({ mode: 'local-only', url: 'http://localhost:1234/' })));
  await assert.rejects(() => runFixSubcommand(base), { code: 'BUILD_CONFIG_MISSING' });
  await assert.rejects(() => runFixSubcommand([...base, '--fix-mode', 'cis']), /--harness cannot be combined/);
  await assert.rejects(() => runFixSubcommand([...base, '--max-repairs', 'x']), /--max-repairs must be a whole number/);
  await assert.rejects(() => runFixSubcommand([...base, '--fixer', 'nope']), /--fixer must be one of/);
  writeFileSync(reportPath, JSON.stringify(mk({ mode: 'url-only', url: 'https://example.test/' })));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let result;
  try { result = await runFixSubcommand(base); } finally { console.log = orig; }
  assert.equal(result.status, 'scan-only');
  assert.match(logs.join('\n'), /scan-only/);
  writeFileSync(join(dir, '.scan-config.json'), JSON.stringify({ verifyBuildCommand: 'node build.mjs', outDir: 'out' }));
  assert.deepEqual(loadHarnessConfig(dir).build, { command: 'node', args: ['build.mjs'] });
  await assert.rejects(() => runHarness({ projectDir: dir, tasks: [], fixer: { propose() {} }, config: { build: 'bash -c x' } }), /interpreter/);
});

test('edits: a blank line above (or at the top of) the changed line is a valid anchor', async () => {
  const { applyEditsToBytes } = await import('../../src/fix/candidate/bytes.js');
  const { validateAndBuildCandidate } = await import('../../src/fix/candidate/intent.js');
  const dir = tmp('blank-ctx');
  for (const before of ['<a>\n\n<nav class="x" aria-hidden="true">\n</a>\n', '\n<nav class="x" aria-hidden="true">\n</a>\n', '<a>\n\n<nav class="x" aria-hidden="true">\n']) {
    const after = before.replace(' aria-hidden="true"', '');
    writeFileSync(join(dir, 't.liquid'), before);
    const c = validateAndBuildCandidate({ localRoot: dir, reportId: 'r', policyVersion: 'p', edits: fileToEdits('t.liquid', before, after) });
    assert.equal(applyEditsToBytes(Buffer.from(before), c.edits).toString(), after, JSON.stringify(before));
  }
});

test('edits: whitespace-only or trailing-space context lines never corrupt the file (applied bytes equal the verified text, or the change is refused)', async () => {
  const { applyEditsToBytes } = await import('../../src/fix/candidate/bytes.js');
  const { validateAndBuildCandidate } = await import('../../src/fix/candidate/intent.js');
  const dir = tmp('ws-ctx');
  const shapes = ['<a>\n    \n<nav class="x" aria-hidden="true">\n</a>\n', '<a>  \n<nav class="x" aria-hidden="true">\n</a>\n', '<a>\n\t\n    <nav class="x" aria-hidden="true">\n</a>\n', '    \n<nav class="x" aria-hidden="true">\n'];
  for (const before of shapes) {
    const after = before.replace(' aria-hidden="true"', '');
    writeFileSync(join(dir, 't.liquid'), before);
    const c = validateAndBuildCandidate({ localRoot: dir, reportId: 'r', policyVersion: 'p', edits: fileToEdits('t.liquid', before, after) });
    assert.equal(applyEditsToBytes(Buffer.from(before), c.edits).toString(), after, JSON.stringify(before));
  }
  // a pure insertion under an indented blank line stays valid, and a real defect fix (a deleted whitespace-only line) is not swallowed
  const ins = '<a>\n    \n<b>\n';
  writeFileSync(join(dir, 't.liquid'), ins);
  const e = fileToEdits('t.liquid', ins, '<a>\n    \n<i></i>\n<b>\n');
  assert.equal(applyEditsToBytes(Buffer.from(ins), validateAndBuildCandidate({ localRoot: dir, reportId: 'r', policyVersion: 'p', edits: e }).edits).toString(), '<a>\n    \n<i></i>\n<b>\n');
});
