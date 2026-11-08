// Benchmark metrics and release criteria with an injected runner stub (no browser, no real harness runner).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, evaluateRelease, oracleFixer, runBenchmark } from '../../scripts/lib/fix-benchmark.js';
import { loadManifest, contextFor } from '../../scripts/lib/fix-corpus.js';
import { formatReport } from '../../scripts/fix-benchmark.js';
import { createRecipesFixer } from '../../src/fix/harness/fixers/index.js';

const work = mkdtempSync(join(tmpdir(), 'fix-bench-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
const manifest = loadManifest();

/** Stub runner: calls the fixer with the real context; a candidate is accepted unless the task is a tempting one (rolled back on G3) or listed in `leak`. */
const stub = ({ leak = [], scanner = true, regress = [] } = {}) => ({
  calls: 0,
  async runTask({ siteRoot, siteLang, routes, task, fixer }) {
    this.calls += 1;
    const r = await fixer.propose(task, contextFor(siteRoot, { routes, siteLang }, task));
    if (r.declined) return { decision: 'declined', iterations: 0, failedGates: [], reason: r.declined, resolved: null, regressions: [] };
    if (fixer.name.startsWith('tempting:')) return leak.includes(fixer.name.slice(9)) ? { decision: 'auto_accept', iterations: 1, failedGates: [], resolved: true, regressions: [] } : { decision: 'rollback', iterations: 1, failedGates: ['G3'], reason: 'layout', resolved: false, regressions: [] };
    return { decision: 'auto_accept', iterations: task.id === 'orchard-disclosure' ? 2 : 1, failedGates: [], resolved: scanner ? true : null, regressions: regress.includes(task.id) ? ['new finding'] : [], perfDelta: { lcp: -10, tbt: 0, regressed: false } };
  },
});
const go = (runner, o = {}) => runBenchmark({ runner, fixers: [{ name: 'recipes', fixer: createRecipesFixer() }, { name: 'oracle', fixer: oracleFixer(manifest) }], manifest, workRoot: work, ...o });

test('metrics: clean run has zero break and false-accept, mean repairs and perf delta are computed', async () => {
  const report = await go(stub());
  const m = report.metrics;
  assert.equal(m.breakRate, 0); assert.equal(m.falseAcceptRate, 0); assert.equal(m.temptingVerified, report.corpus.tempting);
  assert.equal(report.perFixer.oracle.fixed, report.corpus.fixable); // oracle applies every expected fix
  assert.ok(report.perFixer.recipes.fixRate > 0.5 && report.perFixer.recipes.fixRate < 1);
  assert.equal(m.fixRate, 1);
  assert.ok(m.meanRepairs > 0);
  assert.equal(m.perfDelta.lcp, -10);
  assert.ok(report.perFixer.recipes.declines.NO_RECIPE >= 1);
  const rel = evaluateRelease(report, { realSiteCopies: 3, brokenInReview: 0, perfGainOnRealSite: true });
  assert.deepEqual(rel.failed, []);
  assert.deepEqual(rel.open, ['deterministic-twice']);
  assert.match(formatReport(report, rel), /release criteria: OPEN/);
});

test('a tempting fix that is accepted raises false-accept and break rate and fails the release criteria', async () => {
  const report = await go(stub({ leak: ['willow-colour-change'] }));
  assert.equal(report.metrics.falseAccepted[0], 'willow-colour-change');
  assert.ok(report.metrics.falseAcceptRate > 0 && report.metrics.breakRate > 0);
  const rel = evaluateRelease(report);
  assert.equal(rel.pass, false);
  assert.ok(rel.failed.includes('false-accept-zero') && rel.failed.includes('break-rate-zero'));
});

test('an accepted candidate with a regression counts as a break; zero accepted means n/a, not a pass', async () => {
  const report = await go(stub({ regress: ['harbor-lang'] }));
  assert.ok(report.metrics.breakRate > 0 && report.metrics.broken >= 1);
  assert.ok(evaluateRelease(report).failed.includes('break-rate-zero'));
  const none = buildReport({ records: [], fixers: [], manifest: { sites: [] } });
  assert.equal(evaluateRelease(none).criteria.find((c) => c.id === 'break-rate-zero').pass, null);
});

test('without a scanner nothing is called resolved and the scanner-only criteria stay open', async () => {
  const report = await go(stub({ scanner: false }), { scanner: false });
  assert.equal(report.scanner, false);
  const rel = evaluateRelease(report);
  assert.ok(rel.open.includes('fix-rate-90') && rel.open.includes('all-tempting-verified'));
  assert.equal(report.metrics.temptingVerified, report.corpus.tempting - report.metrics.temptingUnverified);
  assert.ok(report.metrics.temptingUnverified >= 2);
});

test('repeat runs compare decisions: deterministic runner passes, a flaky one fails', async () => {
  const same = await go(stub(), { repeat: 2, siteFilter: ['harbor-doc', 'meadow-loops'] });
  assert.equal(same.deterministic, true);
  assert.equal(evaluateRelease(same).criteria.find((c) => c.id === 'deterministic-twice').pass, true);
  const flaky = stub(); const base = flaky.runTask.bind(flaky);
  flaky.runTask = async (a) => { const r = await base(a); return flaky.calls > 12 && a.task.id === 'harbor-lang' ? { ...r, decision: 'rollback', failedGates: ['G5'] } : r; };
  assert.equal((await go(flaky, { repeat: 2, siteFilter: ['harbor-doc'] })).deterministic, false);
});

test('a runner that throws is recorded as a rollback, never as an accept', async () => {
  const report = await go({ runTask: async () => { throw new Error('boom'); } }, { siteFilter: ['harbor-doc'] });
  assert.ok(report.records.every((r) => r.decision === 'rollback' && r.failedGates[0] === 'RUNNER_ERROR'));
  assert.equal(report.metrics.acceptedTotal, 0);
});
