// Benchmark runner on the real harness (src/fix/harness/runner.js): runs ONE task per call with the production scanner (G1), all gates G2..G8
// and Lighthouse perf, in dry-run so the benchmark's site copy is never written. Slow (one site build, baseline and rescan per task).
import { fileURLToPath } from 'node:url';
import { runHarness } from '../../src/fix/harness/index.js';
import { contextFor } from './fix-corpus.js';

const BUILD = { command: process.execPath, args: [fileURLToPath(new URL('./render-corpus-build.mjs', import.meta.url))] };
const DECISION = { accepted: 'auto_accept', queued: 'human_review', rolled_back: 'rollback', rejected: 'rollback', declined: 'declined', skipped: 'unverified' };

export function createRunner({ perfRuns = 0 } = {}) {
  return {
    scanner: true,
    async runTask({ siteRoot, siteLang, routes, task, fixer, maxRepairs = 2, perf = false }) {
      const site = { routes, siteLang };
      const wrapped = {
        name: fixer.name, mechanicallySafe: fixer.mechanicallySafe,
        propose: (t, ctx) => fixer.propose(t, { ...contextFor(ctx.workspace, site, t), ...ctx }),
      };
      const run = await runHarness({
        projectDir: siteRoot, fixer: wrapped, tasks: [{ ...task, pages: routes }],
        config: { build: BUILD, outDir: 'dist', routes, maxRepairs, dryRun: true, perfRuns: perf ? Math.max(perfRuns, 3) : perfRuns, cleanup: true },
      });
      const r = run.tasks[0];
      const last = run.table.find((t) => t.taskId === task.id) || {};
      // A design-locked task is refused before any fixer runs: the colour fix is never applied, which is a rejection, not an unknown.
      const decision = r.reasonClass === 'needs_design_decision' ? 'declined' : (DECISION[r.outcome] || 'unverified');
      const delta = r.scanDelta || run.scanDelta;
      return {
        decision, iterations: r.iterations.length, failedGates: r.failedGates || [], reason: r.detail || r.reasonClass || null,
        evidence: r.evidence?.length ? r.evidence : null, resolved: r.outcome === 'accepted' ? Boolean(delta && delta.fixed > 0) : false,
        regressions: r.outcome === 'accepted' && delta?.added ? delta.addedIds : [], perfDelta: null, status: run.status, lastDecision: last.decision ?? null,
      };
    },
    async close() {},
  };
}
