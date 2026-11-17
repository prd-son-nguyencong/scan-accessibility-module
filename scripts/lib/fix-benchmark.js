// Fix benchmark core: runs fixers over the seeded-fault corpus through a harness runner and computes the metrics and the release
// criteria of docs/fix-harness.md section 9. The runner is injected (src/fix/harness/runner.js from the controller work, or the built-in
// foundation runner, or a test stub), so this module has no browser or network dependency.
//
// Runner contract (docs/fix-benchmark.md):
//   runner.runTask({ siteId, siteRoot, siteLang, routes, task, fixer, maxRepairs, perf }) -> Promise<{
//     decision: 'auto_accept' | 'human_review' | 'rollback' | 'declined' | 'unverified',
//     iterations: number,            // fixer calls that produced a candidate (repairs = iterations - 1)
//     failedGates: string[],         // gate ids of the last candidate (empty when accepted)
//     reason?: string,               // decline reason or rollback summary
//     resolved: boolean | null,      // target findings gone after apply (null: no scanner available)
//     regressions: string[],         // anything the post-apply rescan or review found broken (empty when clean)
//     evidence?: [{ gate, evidence[] }],  // optional: first failed-gate evidence, kept in the JSON report for diagnosis
//     perfDelta?: { score?, lcp?, tbt?, cls?, transfer?, regressed?: boolean } | null,
//   }>
// `siteRoot` is a private copy of the site: the runner may let an accepted candidate be applied to it, never anywhere else.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR, loadManifest, taskFor } from './fix-corpus.js';

export const ACCEPTED = new Set(['auto_accept', 'human_review']);
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const rate = (n, d) => (d ? Math.round((n / d) * 10000) / 10000 : null);

/** Fixer that proposes the manifest's tempting wrong edit verbatim (so the harness, not the fixer, must reject it). */
export function scriptedWrongFixer(wrong) {
  return {
    name: `tempting:${wrong.id}`,
    mechanicallySafe: false,
    async propose(task, context = {}) {
      const files = new Map();
      for (const e of wrong.edits) {
        const before = context.files?.[e.path]?.text ?? context.files?.[e.path];
        if (typeof before !== 'string') return { declined: 'CONTEXT_MISSING', detail: e.path };
        const cur = files.get(e.path)?.after ?? before;
        if (cur.split(e.find).length !== 2) return { declined: 'ANCHOR_NOT_FOUND', detail: e.find.slice(0, 40) };
        files.set(e.path, { path: e.path, before, after: cur.replace(e.find, () => e.replace) });
      }
      return { files: [...files.values()], rationale: wrong.why, confidence: 0.9 };
    },
  };
}

/** Fixer that applies the manifest's expected good fix (corpus self-check and the upper bound for fix rate). */
export function oracleFixer(manifest = loadManifest()) {
  const defects = new Map(manifest.sites.flatMap((x) => x.defects.map((d) => [d.id, d])));
  return {
    name: 'oracle',
    mechanicallySafe: false,
    async propose(task, context = {}) {
      const d = defects.get(task.id);
      if (!d?.expectedFix) return { declined: 'NO_EXPECTED_FIX' };
      return scriptedWrongFixer({ id: d.id, why: 'manifest expected fix', edits: d.expectedFix.edits }).propose(task, context);
    },
  };
}

function summarize(runs) {
  const candidates = runs.filter((r) => r.decision !== 'declined' && r.decision !== 'unverified');
  const accepted = candidates.filter((r) => ACCEPTED.has(r.decision));
  return { candidates, accepted };
}

/**
 * @param {{ runner, fixers: Array<{ name: string, fixer: object }>, manifest?: object, workRoot: string, siteFilter?: string[], maxRepairs?: number, perf?: boolean, repeat?: number, scanner?: boolean, log?: Function }} o
 * `scanner`: whether the runner evaluates G1 (rescan). Without it nothing can be called "resolved" and fix rate is reported as pending.
 */
export async function runBenchmark({ runner, fixers, manifest = loadManifest(), workRoot, siteFilter, maxRepairs = 3, perf = false, repeat = 1, scanner = true, log = () => {} }) {
  const sites = manifest.sites.filter((s) => !siteFilter?.length || siteFilter.includes(s.id));
  let n = 0;
  const once = async (pass) => {
    const records = [];
    for (const site of sites) {
      const exec = async (kind, fixerName, fixer, task, extra = {}) => {
        const siteRoot = join(workRoot, `p${pass}`, `${site.id}-${(n += 1)}`);
        mkdirSync(siteRoot, { recursive: true });
        cpSync(join(CORPUS_DIR, site.dir), siteRoot, { recursive: true });
        let res;
        try {
          res = await runner.runTask({ siteId: site.id, siteRoot, siteLang: site.siteLang, routes: site.routes, task, fixer, maxRepairs: kind === 'tempting' ? 0 : maxRepairs, perf: perf || Boolean(extra.needsPerf) });
        } catch (error) {
          res = { decision: 'rollback', iterations: 1, failedGates: ['RUNNER_ERROR'], reason: String(error.message || error).slice(0, 200), resolved: false, regressions: [] };
        } finally { rmSync(siteRoot, { recursive: true, force: true }); }
        const rec = { kind, fixer: fixerName, site: site.id, id: task.id, rule: task.rule, ...extra, decision: res.decision, iterations: res.iterations ?? 0, failedGates: res.failedGates || [], reason: res.reason ?? null, resolved: res.resolved ?? null, regressions: res.regressions || [], perfDelta: res.perfDelta ?? null, evidence: res.evidence ?? null };
        log(rec);
        records.push(rec);
      };
      for (const d of site.defects) {
        const task = taskFor(site, d);
        for (const { name, fixer } of fixers) await exec('defect', name, fixer, task, { fixable: d.class === 'fixable', defectClass: d.class });
      }
      for (const w of site.wrongFixes) {
        const d = site.defects.find((x) => x.id === w.defect);
        await exec('tempting', 'scripted-wrong-fix', scriptedWrongFixer(w), taskFor(site, d), { id: w.id, wrongKind: w.kind, expectGates: w.expect, needsScanner: Boolean(w.needsScanner), needsPerf: Boolean(w.needsPerf) });
      }
    }
    return records;
  };
  const first = await once(1);
  let deterministic = null;
  if (repeat > 1) {
    deterministic = true;
    for (let i = 2; i <= repeat; i += 1) {
      const again = await once(i);
      const sig = (rs) => rs.map((r) => `${r.kind}|${r.fixer}|${r.id}|${r.decision}|${r.failedGates.join(',')}`).join('\n');
      if (sig(again) !== sig(first)) deterministic = false;
    }
  }
  return buildReport({ records: first, fixers: fixers.map((f) => f.name), manifest: { sites }, scanner, deterministic, maxRepairs, repeat });
}

/** Pure: metrics from run records. */
export function buildReport({ records, fixers, manifest, scanner = true, deterministic = null, maxRepairs = 3, repeat = 1 }) {
  const defects = records.filter((r) => r.kind === 'defect');
  const fixable = [...new Set(defects.filter((r) => r.fixable).map((r) => `${r.site}/${r.id}`))];
  const tempting = records.filter((r) => r.kind === 'tempting');
  const verifiable = tempting.filter((r) => r.decision !== 'unverified' && !(r.needsScanner && !scanner));
  const falseAccepted = verifiable.filter((r) => ACCEPTED.has(r.decision));
  const per = {};
  const isFixed = (r) => r.decision === 'auto_accept' && (scanner ? r.resolved === true : true) && r.regressions.length === 0;
  const fixedBy = new Map();
  for (const name of fixers) {
    const runs = defects.filter((r) => r.fixer === name);
    const fixableRuns = runs.filter((r) => r.fixable);
    const { candidates, accepted } = summarize(runs);
    const fixed = fixableRuns.filter(isFixed);
    for (const r of fixed) fixedBy.set(`${r.site}/${r.id}`, name);
    const declines = {};
    for (const r of runs.filter((x) => x.decision === 'declined')) declines[r.reason || 'unknown'] = (declines[r.reason || 'unknown'] || 0) + 1;
    const pd = accepted.map((r) => r.perfDelta).filter(Boolean);
    per[name] = {
      defects: runs.length, fixable: fixableRuns.length, declined: runs.length - candidates.length, candidates: candidates.length, accepted: accepted.length, autoAccepted: accepted.filter((r) => r.decision === 'auto_accept').length, humanReview: accepted.filter((r) => r.decision === 'human_review').length,
      fixed: fixed.length, fixRate: rate(fixed.length, fixableRuns.length), brokenAccepted: accepted.filter((r) => r.regressions.length).length,
      rollbackRate: rate(candidates.filter((r) => r.decision === 'rollback').length, candidates.length),
      meanRepairs: candidates.length ? Math.round((candidates.reduce((s, r) => s + Math.max(0, r.iterations - 1), 0) / candidates.length) * 100) / 100 : null,
      perfDelta: Object.fromEntries(['score', 'lcp', 'tbt', 'cls', 'transfer'].map((k) => [k, median(pd.map((p) => p[k]))])),
      perfRegressed: pd.filter((p) => p.regressed).length, declines,
    };
  }
  const acceptedAll = [...defects.filter((r) => ACCEPTED.has(r.decision)), ...falseAccepted];
  const broken = [...defects.filter((r) => ACCEPTED.has(r.decision) && r.regressions.length), ...falseAccepted];
  const unfixed = fixable.filter((k) => !fixedBy.has(k));
  const unexplained = unfixed.filter((k) => !defects.some((r) => `${r.site}/${r.id}` === k && (r.reason || r.failedGates.length)));
  const combinedFixed = fixable.length - unfixed.length;
  const allPd = defects.filter((r) => ACCEPTED.has(r.decision)).map((r) => r.perfDelta).filter(Boolean);
  return {
    version: 1, scanner, repeat, maxRepairs, deterministic, fixers,
    corpus: { sites: manifest.sites.length, defects: manifest.sites.reduce((n, s) => n + s.defects.length, 0), fixable: fixable.length, tempting: tempting.length, temptingKinds: [...new Set(tempting.map((r) => r.wrongKind))].sort() },
    metrics: {
      fixRate: rate(combinedFixed, fixable.length),
      breakRate: acceptedAll.length ? rate(broken.length, acceptedAll.length) : 0,
      falseAcceptRate: verifiable.length ? rate(falseAccepted.length, verifiable.length) : null,
      rollbackRate: rate(records.filter((r) => r.decision === 'rollback').length, records.filter((r) => r.decision !== 'declined' && r.decision !== 'unverified').length),
      meanRepairs: (() => { const c = records.filter((r) => r.kind === 'defect' && r.decision !== 'declined'); return c.length ? Math.round((c.reduce((s, r) => s + Math.max(0, r.iterations - 1), 0) / c.length) * 100) / 100 : null; })(),
      perfDelta: Object.fromEntries(['score', 'lcp', 'tbt', 'cls', 'transfer'].map((k) => [k, median(allPd.map((p) => p[k]))])),
      perfRegressed: allPd.filter((p) => p.regressed).length,
      unexplained: unexplained.length, unfixed,
      temptingVerified: verifiable.length, temptingUnverified: tempting.length - verifiable.length, falseAccepted: falseAccepted.map((r) => r.id),
      acceptedTotal: acceptedAll.length, broken: broken.length,
    },
    perFixer: per,
    tempting: tempting.map((r) => ({ id: r.id, kind: r.wrongKind, site: r.site, decision: r.decision, failedGates: r.failedGates, expected: r.expectGates, gateMatch: r.failedGates.some((g) => r.expectGates.includes(g)) })),
    records,
  };
}

/** Release criteria of docs/fix-harness.md section 9. `pass: null` means a manual or scanner-dependent criterion is still open. */
export function evaluateRelease(report, { realSiteCopies = 0, brokenInReview = null, perfGainOnRealSite = null } = {}) {
  const m = report.metrics;
  const c = [];
  const add = (id, pass, detail) => c.push({ id, pass, detail });
  add('break-rate-zero', m.acceptedTotal === 0 ? null : m.breakRate === 0, `break rate ${m.breakRate} (${m.broken}/${m.acceptedTotal} accepted)`);
  add('false-accept-zero', m.falseAcceptRate === null ? null : m.falseAcceptRate === 0, m.falseAcceptRate === null ? 'no verifiable tempting wrong fix ran' : `false-accept rate ${m.falseAcceptRate} (${m.falseAccepted.length}/${m.temptingVerified}), ${m.temptingUnverified} need a scanner`);
  add('all-tempting-verified', m.temptingUnverified === 0 ? true : null, `${m.temptingUnverified} tempting fixes need the scanner gate (G1) and were not evaluated`);
  add('fix-rate-90', report.scanner ? m.fixRate >= 0.9 : null, report.scanner ? `fix rate ${m.fixRate}` : 'needs a runner with the scanner gate (G1) to call a defect resolved');
  add('no-unexplained-leftovers', report.scanner ? m.unexplained === 0 : null, `${m.unexplained} unfixed fixable defects without a reason or failed gate`);
  add('no-perf-regression', m.perfRegressed === 0, `${m.perfRegressed} accepted candidates regressed beyond margin`);
  add('deterministic-twice', report.deterministic, report.deterministic === null ? 'run with --repeat 2' : `decisions identical across ${report.repeat} runs: ${report.deterministic}`);
  add('real-site-copies-3', realSiteCopies >= 3 ? true : null, `${realSiteCopies} real-site copies reported (manual, docs/fix-benchmark.md)`);
  add('review-no-broken-auto-accepts', brokenInReview == null ? null : brokenInReview === 0, brokenInReview == null ? 'pending independent review of auto-accepted real-site diffs' : `${brokenInReview} broken`);
  add('perf-gain-on-real-site', perfGainOnRealSite == null ? null : perfGainOnRealSite === true, 'performance track shows a measured gain on one real-site copy (manual)');
  const hard = c.filter((x) => x.pass === false);
  return { pass: hard.length === 0 && c.every((x) => x.pass === true), failed: hard.map((x) => x.id), open: c.filter((x) => x.pass === null).map((x) => x.id), criteria: c };
}
