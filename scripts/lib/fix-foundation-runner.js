// Built-in benchmark runner on the harness foundation (src/fix/harness): snapshots plus gates G2..G7. It has NO scanner, so G1 (target
// findings gone) and G8 (build validity) are not evaluated: `resolved` is null and tempting fixes that only G1 can catch come back
// `unverified`. Use it to check the corpus and the pixel/style/behaviour/perf/scope gates; the controller runner replaces it for release.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSnapshot, resolveKeys, runGates, VIEWPORTS } from '../../src/fix/harness/index.js';
import { readTree } from '../../src/fix/harness/tokens.js';
import { decideAcceptance, diffLines } from '../../src/fix/harness/gates.js';
import { closeBrowser } from '../../src/scanner/browser.js';
import { renderCorpusSite, contextFor } from './fix-corpus.js';
import { serveDir } from '../../test/helpers/harness-site.mjs';

const VPS = [VIEWPORTS[0], VIEWPORTS[2]];

export function createFoundationRunner({ viewports = VPS, perfRuns = 3 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'fix-bench-'));
  const baselines = new Map();
  let seq = 0;

  async function snap(srcRoot, routes, perf) {
    const out = join(tmp, `o${(seq += 1)}`);
    renderCorpusSite(join(srcRoot, 'src'), out);
    const server = await serveDir(out);
    try {
      const snapshot = await captureSnapshot({ baseUrl: server.url, routes, viewports, dir: join(tmp, `s${seq}`), perfRuns: perf ? perfRuns : 0, perfRoutes: routes, timeBudgetMs: 150000 });
      return { snapshot, close: server.close, keys: (selectors) => resolveKeys({ baseUrl: server.url, route: routes[0], viewport: viewports[viewports.length - 1], selectors }) };
    } catch (error) { await server.close(); throw error; }
  }

  return {
    async runTask({ siteId, siteRoot, siteLang, routes, task, fixer, maxRepairs = 3, perf = false }) {
      const key = `${siteId}|${perf}`;
      if (!baselines.has(key)) {
        const root = join(tmp, `base-${seq += 1}`); cpSync(siteRoot, root, { recursive: true }); // pristine copy: the caller removes siteRoot
        baselines.set(key, { ...(await snap(root, routes, perf)), tree: readTree(root), root });
      }
      const base = baselines.get(key);
      const site = { routes, siteLang };
      let previous = null; let gateEvidence = null; let last = null;
      for (let it = 1; it <= maxRepairs + 1; it += 1) {
        const ctx = { ...contextFor(base.root, site, task), ...(previous ? { previous, gateEvidence } : {}) };
        const r = await fixer.propose(task, ctx);
        if (r.declined || !r.files?.length) return { decision: 'declined', iterations: it - 1, failedGates: [], reason: r.declined || 'NO_FILES', resolved: null, regressions: [] };
        const work = join(tmp, `w${(seq += 1)}`);
        cpSync(base.root, work, { recursive: true });
        for (const f of r.files) { mkdirSync(join(work, f.path, '..'), { recursive: true }); if (f.after == null) rmSync(join(work, f.path)); else writeFileSync(join(work, f.path), f.after); }
        const after = await snap(work, routes, perf);
        try {
          const sel = task.documented || [];
          const documented = sel.length ? [...(await base.keys(sel)), ...(await after.keys(sel))] : [];
          const tg = task.targets || [];
          const targets = tg.length ? [...(await base.keys(tg)), ...(await after.keys(tg))] : [];
          const gates = runGates({ before: base.snapshot, after: after.snapshot, beforeTree: base.tree, afterTree: readTree(work), allowlist: task.allowlist, designLock: task.designLock !== false, targets, documented, only: ['G2', 'G3', 'G4', 'G5', 'G6', ...(perf ? ['G7'] : [])] });
          last = gates;
          if (gates.pass) {
            const changedLines = r.files.reduce((n, f) => n + diffLines(f.before ?? '', f.after ?? '').reduce((m, h) => m + (h.aEnd - h.aStart + 1) + (h.bEnd - h.bStart + 1), 0), 0);
            const d = decideAcceptance({ gateResult: gates, mechanicallySafe: Boolean(fixer.mechanicallySafe), changedLines, files: r.files.map((f) => f.path), iteration: it, maxIterations: maxRepairs + 1 });
            return { decision: d.decision, iterations: it, failedGates: [], resolved: null, regressions: [], perfDelta: null };
          }
          previous = r.files; gateEvidence = gates.gates;
        } finally { await after.close(); rmSync(work, { recursive: true, force: true }); }
      }
      return { decision: 'rollback', iterations: maxRepairs + 1, failedGates: last.failed, evidence: last.gates.filter((g) => !g.pass).map((g) => ({ gate: g.gate, evidence: g.evidence.slice(0, 3) })), reason: `gates failed: ${last.failed.join(',')}`, resolved: false, regressions: [] };
    },
    async close() { for (const b of baselines.values()) await b.close(); await closeBrowser(); rmSync(tmp, { recursive: true, force: true }); },
  };
}
