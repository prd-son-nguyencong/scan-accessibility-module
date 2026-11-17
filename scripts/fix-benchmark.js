#!/usr/bin/env node
// Fix benchmark: runs the fixers over the seeded-fault corpus through a harness runner, prints and writes the metrics, evaluates the
// release criteria. Reads and writes only temp copies; never touches a site tree. See docs/fix-benchmark.md.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createExternalFixer, createFixer, createRecipesFixer } from '../src/fix/harness/fixers/index.js';
import { evaluateRelease, oracleFixer, runBenchmark } from './lib/fix-benchmark.js';

const USAGE = `Usage: node scripts/fix-benchmark.js [options]
  --runner <foundation|path>   harness runner module exporting createRunner() or runTask (default: src/fix/harness/runner.js, else foundation)
  --fixers <list>              recipes,cis,external,oracle (default recipes; oracle applies the manifest fix: corpus self-check)
  --external-dir <dir>         diffs named <defect-id>.diff for the external fixer
  --site <id[,id]>             limit to corpus sites
  --max-repairs <n>            repair iterations per task (default 3)
  --perf                       measure perf on every task (default: only tasks flagged needsPerf)
  --repeat <n>                 repeat the whole run (2 checks determinism)
  --out <file>                 write the JSON report here (default: print only)
  --check                      exit 1 when a release criterion fails (open criteria do not fail)
  --real-sites <n> --broken-in-review <n> --perf-gain <yes|no>   manual real-site facts for the release evaluation
  --help`;

async function loadRunner(spec) {
  const def = path.resolve(new URL('../src/fix/harness/runner.js', import.meta.url).pathname);
  const target = spec || (existsSync(def) ? def : 'foundation');
  if (target === 'foundation') {
    const { createFoundationRunner } = await import('./lib/fix-foundation-runner.js');
    const r = createFoundationRunner();
    return { runner: r, scanner: false, name: 'foundation (G2..G7, no scanner)', close: r.close };
  }
  const mod = await import(pathToFileURL(path.resolve(target)).href);
  const r = typeof mod.createRunner === 'function' ? await mod.createRunner() : mod;
  if (typeof r.runTask !== 'function') throw new Error(`runner ${target} must export runTask or createRunner() returning it`);
  return { runner: r, scanner: r.scanner !== false, name: target, close: r.close?.bind(r) };
}

async function buildFixers(names, externalDir) {
  const out = [];
  for (const n of names) {
    if (n === 'recipes') out.push({ name: 'recipes', fixer: createRecipesFixer() });
    else if (n === 'oracle') out.push({ name: 'oracle', fixer: oracleFixer() });
    else if (n === 'external') {
      if (!externalDir) throw new Error('--external-dir is required for the external fixer');
      const have = new Set(readdirSync(externalDir).filter((f) => f.endsWith('.diff')).map((f) => f.slice(0, -5)));
      out.push({ name: 'external', fixer: { name: 'external', mechanicallySafe: false, propose: (task, ctx) => (have.has(task.id) ? createExternalFixer({ diffFile: path.join(externalDir, `${task.id}.diff`), name: 'external' }).propose(task, ctx) : { declined: 'NO_DIFF_FOR_TASK' }) } });
    } else if (n === 'cis') {
      // Live CIS: one construction path with `fix --harness` (config resolved from the environment, never printed; transport imported and awaited).
      out.push({ name: 'cis', fixer: await createFixer('cis', { env: process.env }) });
    } else throw new Error(`unknown fixer ${n}`);
  }
  return out;
}

export const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function formatReport(report, release) {
  const m = report.metrics;
  const L = [
    `corpus: ${report.corpus.sites} sites, ${report.corpus.defects} defects (${report.corpus.fixable} fixable), ${report.corpus.tempting} tempting wrong fixes`,
    `fix rate ${pct(m.fixRate)} | break rate ${pct(m.breakRate)} (${m.broken}/${m.acceptedTotal}) | false-accept ${pct(m.falseAcceptRate)} (${m.falseAccepted.length}/${m.temptingVerified}) | rollback ${pct(m.rollbackRate)} | mean repairs ${m.meanRepairs ?? 'n/a'}`,
    `perf delta (median of accepted): ${Object.entries(m.perfDelta).map(([k, v]) => `${k} ${v ?? 'n/a'}`).join(', ')}; regressed ${m.perfRegressed}`,
    `scanner gate (G1): ${report.scanner ? 'on' : 'off, so fix rate counts gate-passing candidates only'}; deterministic: ${report.deterministic ?? 'not checked'}`,
    '', 'per fixer:',
    ...Object.entries(report.perFixer).map(([n, f]) => `  ${n}: fixed ${f.fixed}/${f.fixable} (${pct(f.fixRate)}), candidates ${f.candidates}, declined ${f.declined}, accepted ${f.accepted} (auto ${f.autoAccepted}, review ${f.humanReview}), rollback ${pct(f.rollbackRate)}, repairs ${f.meanRepairs ?? 'n/a'}`),
    '', 'tempting wrong fixes:',
    ...report.tempting.map((t) => `  ${t.decision === 'rollback' || t.decision === 'declined' ? 'rejected' : t.decision === 'unverified' ? 'unverified' : 'ACCEPTED '} ${t.id} [${t.kind}] failed ${t.failedGates.join(',') || 'none'} expected ${t.expected.join('/')}${t.gateMatch ? '' : ' (different gate)'}`),
    '', `release criteria: ${release.pass ? 'PASS' : release.failed.length ? `FAIL (${release.failed.join(', ')})` : `OPEN (${release.open.join(', ')})`}`,
    ...release.criteria.map((c) => `  ${c.pass === true ? 'ok  ' : c.pass === false ? 'FAIL' : 'open'} ${c.id}: ${c.detail}`),
  ];
  return L.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { runner: { type: 'string' }, fixers: { type: 'string', default: 'recipes' }, 'external-dir': { type: 'string' }, site: { type: 'string' }, 'max-repairs': { type: 'string', default: '3' }, perf: { type: 'boolean' }, repeat: { type: 'string', default: '1' }, out: { type: 'string' }, check: { type: 'boolean' }, 'real-sites': { type: 'string', default: '0' }, 'broken-in-review': { type: 'string' }, 'perf-gain': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(USAGE); return 0; }
  const fixers = await buildFixers(String(values.fixers).split(',').filter(Boolean), values['external-dir']);
  const loaded = await loadRunner(values.runner);
  const work = mkdtempSync(path.join(tmpdir(), 'fix-benchmark-'));
  try {
    const report = await runBenchmark({ runner: loaded.runner, fixers, workRoot: work, siteFilter: values.site?.split(','), maxRepairs: Number(values['max-repairs']), perf: Boolean(values.perf), repeat: Number(values.repeat), scanner: loaded.scanner, log: (r) => process.stderr.write(`${r.kind === 'tempting' ? 'wrong ' : 'fix   '} ${r.fixer.padEnd(18)} ${r.id.padEnd(28)} ${r.decision}${r.failedGates.length ? ` ${r.failedGates.join(',')}` : ''}${r.reason ? ` (${String(r.reason).slice(0, 50)})` : ''}\n`) });
    const release = evaluateRelease(report, { realSiteCopies: Number(values['real-sites']), brokenInReview: values['broken-in-review'] == null ? null : Number(values['broken-in-review']), perfGainOnRealSite: values['perf-gain'] == null ? null : values['perf-gain'] === 'yes' });
    const full = { runner: loaded.name, generatedAt: new Date().toISOString(), ...report, release };
    if (values.out) { mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true }); writeFileSync(values.out, `${JSON.stringify(full, null, 2)}\n`); }
    console.log(formatReport(report, release));
    return values.check && release.failed.length ? 1 : 0;
  } finally {
    await loaded.close?.();
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => { process.exitCode = c; }, (e) => { console.error(String(e.message || e)); process.exitCode = 2; });
