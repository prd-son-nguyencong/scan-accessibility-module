// Harness runner (docs/fix-harness.md section 2 and 11): runs any Fixer through shadow workspace, baseline, gates G1..G8, the accept policy,
// bounded repair, atomic rollback and the reports. Fixer-agnostic: a fixer only proposes whole-file changes; this module decides.
//
//   fixer = { name, mechanicallySafe?: boolean, async propose(task, context) -> { files: [{ path, before, after }], rationale? } | { declined: reason } }
//   context = { workspace, iteration, previous, gateEvidence, read(path) }   (previous / gateEvidence are null on the first iteration)
import { familyOf } from '../../reporter/engine-agreement.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { closeBrowser } from '../../scanner/browser.js';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import { copyProjectTreeIntoShadow, runManagedCommand, startCandidateSite, stopCandidateSite } from '../verify/shadow.js';
import { createStaticSiteAdapter, createViteSiteAdapter, hasRegularViteConfig } from '../verify/site.js';
import { parseTrustedCommand } from '../verify/command.js';
import { persistVerificationArtifact } from '../verify/artifact.js';
import { applyBatchTransaction } from '../apply/transaction.js';
import { rollbackTransaction } from '../apply/rollback.js';
import { validateAndBuildCandidate, CANDIDATE_LIMITS } from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { resolveSecureSourceFile, validateRelativeCandidatePath } from '../candidate/path.js';
import { isDesignLocked } from '../export/recipes.js';
import { captureSnapshot, resolveKeys, VIEWPORTS } from './snapshot.js';
import { runGates, evaluateScope, GATE_IDS } from './gates.js';
import { baselineNoise } from './compare.js';
import { affectedRoutes, routeIndexFromReport } from './incremental.js';
import { readTree } from './tokens.js';
import { collectBuildFacts, countHtmlValidateErrors, checkExport, runBuild } from './build-checks.js';
import { decide, buildEvidence, queueForReview } from './policy.js';
import { buildRemainingReport, declineReasonClass, writeRemainingReport } from './remaining.js';
import { HARNESS_LAYERS } from './scanner-cli.js';
import { changedLineCount, fileToEdits, unifiedDiff } from './change.js';

export class HarnessError extends Error {
  constructor(code, message) { super(message); this.name = 'HarnessError'; this.code = code; }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const EXT = new Set(CANDIDATE_LIMITS.allowedExtensions);
const MAX_FILES = 8;

/** Reads .scan-config.json for the harness CLI. Fails closed: an explicit verifyBuildCommand or buildCommand is required. */
export function loadHarnessConfig(localRoot) {
  const file = join(localRoot, '.scan-config.json');
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new HarnessError('BUILD_CONFIG_MISSING', 'ada-scan fix --harness needs .scan-config.json with verifyBuildCommand (or buildCommand): there is no safe default build.'); }
  const spec = cfg.verifyBuildCommand ?? cfg.buildCommand;
  if (spec == null) throw new HarnessError('BUILD_CONFIG_MISSING', '.scan-config.json has no verifyBuildCommand or buildCommand: the harness needs a build to verify against.');
  const out = { build: parseTrustedCommand(spec, { field: 'build' }), outDir: typeof cfg.outDir === 'string' ? cfg.outDir : 'dist', ...(cfg.harness || {}) };
  if (cfg.verifyInstallCommand != null) out.prepare = parseTrustedCommand(cfg.verifyInstallCommand, { field: 'verifyInstallCommand' });
  if (cfg.verifyFormatCheckCommand != null) out.formatCheck = parseTrustedCommand(cfg.verifyFormatCheckCommand, { field: 'verifyFormatCheckCommand' });
  return out;
}

function resolveConfig(config) {
  if (!config.build) throw new HarnessError('BUILD_CONFIG_MISSING', 'config.build ({ command, args }) is required: the harness fails closed without a build.');
  const outDir = config.outDir || 'dist';
  if (isAbsolute(outDir) || outDir.includes('..')) throw new HarnessError('CONFIG_INVALID', 'outDir must be relative and contained.');
  for (const k of ['snapshotConcurrency', 'scanConcurrency']) if (config[k] != null && !(Number.isInteger(config[k]) && config[k] >= 1)) throw new HarnessError('CONFIG_INVALID', `harness.${k} must be a positive integer.`);
  return {
    maxRepairs: 2, dryRun: false, designLock: true, perfRuns: 3, allowRadius: 3, finalRescan: true, policy: {}, viewports: VIEWPORTS, snapshotBudgetMs: 180000, snapshotConcurrency: 3, scanConcurrency: 2, incrementalRoutes: true,
    ...config, outDir, build: parseTrustedCommand(config.build, { field: 'build' }), prepare: config.prepare ? parseTrustedCommand(config.prepare, { field: 'prepare' }) : null,
  };
}

/**
 * Site adapter of the run. An adapter object passes through. 'static' serves outDir; 'vite' runs the shadow's dev server (a Paradox build only
 * emits fragments, so a static server has no head, layout or scripts to scan). Default 'auto': vite when the project has a vite config.
 */
export function siteAdapterFor(cfg, projectRoot) {
  const site = cfg.site ?? 'auto';
  if (typeof site === 'object') return site;
  if (!['auto', 'static', 'vite'].includes(site)) throw new HarnessError('CONFIG_INVALID', 'harness.site must be auto, static or vite.');
  return site === 'vite' || (site === 'auto' && hasRegularViteConfig(projectRoot)) ? createViteSiteAdapter() : createStaticSiteAdapter({ outDir: cfg.outDir });
}

/**
 * The shadow's node_modules: a real directory whose entries link to the project's packages, so the packages are shared but the tools' own caches are not.
 * One link for the whole folder would let tools write their caches (node_modules/.vite, .vite-temp, .cache) into the ORIGINAL project; here every dot entry
 * except .bin and .pnpm is left out and each tool creates its own inside the shadow.
 */
const SHARED_DOT_ENTRIES = new Set(['.bin', '.pnpm']);
function linkNodeModules(projectRoot, shadowRoot) {
  const from = join(projectRoot, 'node_modules'), to = join(shadowRoot, 'node_modules');
  mkdirSync(to);
  for (const name of readdirSync(from)) if (!name.startsWith('.') || SHARED_DOT_ENTRIES.has(name)) symlinkSync(join(from, name), join(to, name));
}

/** Extra line for a failed baseline build: the usual cause on a real site is a shadow copy without node_modules. */
function buildFailureHint(build, shadowRoot, projectRoot, cfg) {
  const text = `${build.stderrTail}\n${build.stdoutTail || ''}`;
  if (!/MODULE_NOT_FOUND|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/i.test(text) || existsSync(join(shadowRoot, 'node_modules'))) return '';
  return cfg.shareNodeModules === false
    ? ' Hint: the copy has no node_modules because harness.shareNodeModules is false; remove it, or set verifyInstallCommand in .scan-config.json.'
    : existsSync(join(projectRoot, 'node_modules'))
      ? ' Hint: node_modules could not be linked into the copy; set verifyInstallCommand in .scan-config.json.'
      : ' Hint: the project has no node_modules; install its dependencies first (the shadow copy excludes node_modules and links the project\'s own).';
}

/** Harness view of an export task (allowlist, routes, targets). Exported so the working-tree flow scopes its fixer with exactly what the runner uses. */
export function normalizeTask(t, cfg = {}) {
  const radius = cfg.allowRadius ?? 3;
  const file = t.source?.file ?? null, line = t.source?.line ?? null;
  const lines = line == null ? {} : { startLine: Math.max(1, line - radius), endLine: line + radius };
  const occurrences = t.occurrences || [];
  const pages = t.pages?.length ? t.pages : [...new Set(occurrences.map((o) => o.route).filter(Boolean))];
  return {
    id: String(t.id), layer: t.layer || null, ids: t.ids || occurrences.map((o) => o.stableId).filter(Boolean), rule: t.rule, severity: t.severity, verdict: t.verdict,
    routes: pages.length ? pages : ['/'],
    occurrences, source: file ? { file, line } : null, allowlist: t.allowlist || [...(file ? [{ file, ...lines }] : []), ...(t.scriptFiles || []).map((f) => ({ file: f }))],
    targetSelectors: t.targets || [], requiresDesignDecision: Boolean(t.requiresDesignDecision), documented: t.documented || [], proposedChange: t.proposedChange || null,
    fix: t.fix || null, element: t.element || null,
    // untraced (locate manually) tasks: the files they name, for the working-tree flow's whole-file scope
    locateFiles: file ? [] : [...new Set([...(t.locateManually?.likely || []), ...(t.locateManually?.candidates || [])].map((l) => l.file).filter(Boolean))],
  };
}

function normalizeFindings(raw) {
  const out = [];
  for (const f of raw || []) {
    const rule = f.canonicalRuleId || f.ruleId || f.nativeRuleId || f.rule || '';
    const selector = f.selector || f.element?.selector || '';
    const id = f.stableId || f.findingId || f.fingerprint || f.id || `${rule}|${f.route}|${selector}`;
    out.push({ id, route: f.route, rule, native: f.nativeRuleId || f.ruleId || rule, selector, tier: f.tier || f.verdict || 'confirmed', ...(f.untraced ? { untraced: true } : {}), rootCauseKey: f.rootCauseKey || `${rule}|${selector}`.toLowerCase() });
  }
  return out;
}

// Engines name one check differently (axe `label`, accessScan `FormFieldDiscernible`): compare by the report's own rule family.
const ruleFamily = (r) => familyOf({ nativeRuleId: String(r || '') }) ?? String(r || '').toLowerCase();

function mapTargets(task, findings) {
  const ids = new Set(task.ids);
  const sel = new Set(task.occurrences.map((o) => o.selector).filter(Boolean));
  const same = (r) => ruleFamily(r) === ruleFamily(task.rule);
  return [...new Set(findings.filter((f) => ids.has(f.id) || (task.routes.includes(f.route) && [f.rule, f.native].some(same) && (!sel.size || sel.has(f.selector)))).map((f) => f.id))];
}

const scanDeltaOf = (before, after) => {
  const b = new Set(before.map((f) => f.id)), a = new Set(after.map((f) => f.id));
  const bKeys = new Set(before.map((f) => f.rootCauseKey));
  const fixed = [...b].filter((id) => !a.has(id));
  const added = after.filter((f) => !b.has(f.id) && !bKeys.has(f.rootCauseKey)).map((f) => f.id);
  return { before: b.size, after: a.size, beforeRows: before.length, afterRows: after.length, fixed: fixed.length, added: added.length, fixedIds: fixed.slice(0, 50), addedIds: added.slice(0, 50) };
};

// Fixes that legitimately change what G3/G6 compare: a skip link is a new first Tab stop, a heading level change re-tags an element.
const RULE_COMPARE = {
  'skip-link-missing': { allowFirstTabStop: true }, 'skip-link-target-missing': { allowFirstTabStop: true }, bypass: { allowFirstTabStop: true },
  'heading-order': { allowHeadingRetag: true }, 'heading-level-skipped': { allowHeadingRetag: true }, 'empty-heading': { allowHeadingRetag: true },
};

const taskOrder = (a, b) => (a.source?.file || '').localeCompare(b.source?.file || '') || (b.source?.line ?? 0) - (a.source?.line ?? 0) || a.id.localeCompare(b.id);

function readCurrent(root, path) {
  const r = resolveSecureSourceFile(root, path, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
  return r.bytes.toString('utf8');
}

/** Pre-apply validation of a proposal against the shadow. Nothing is written. */
function prepareCandidate({ task, proposal, shadowRoot, tree, cfg }) {
  const fail = (kind, extra = {}, gate = null) => ({ ok: false, stage: 'pre_apply', gate, evidence: [{ kind, ...extra }] });
  const files = proposal?.files;
  if (!Array.isArray(files) || !files.length) return fail('NO_FILES');
  if (files.length > MAX_FILES) return fail('TOO_MANY_FILES', { max: MAX_FILES });
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.before !== 'string' || typeof f.after !== 'string') return fail('INVALID_FILE_ENTRY');
    let path;
    try { path = validateRelativeCandidatePath(f.path); } catch (e) { return fail('INVALID_PATH', { path: f.path, code: e.code }); }
    if (seen.has(path)) return fail('DUPLICATE_PATH', { path });
    seen.add(path);
    if (!EXT.has(path.slice(path.lastIndexOf('.')))) return fail('UNSUPPORTED_EXTENSION', { path });
    let now;
    try { now = readCurrent(shadowRoot, path); } catch (e) { return fail('FILE_UNREADABLE', { path, code: e.code || 'READ_FAILED', note: 'new files and files over 64 KB are not supported' }); }
    if (now !== f.before) return fail('STALE_BEFORE', { path, note: 'before does not match the current shadow file; the fixer must start from context.read(path)' });
    if (f.after === f.before) return fail('NO_CHANGE', { path });
    out.push({ path, before: f.before, after: f.after });
  }
  const afterTree = new Map(tree);
  for (const f of out) afterTree.set(f.path, Buffer.from(f.after, 'utf8'));
  const g2 = evaluateScope({ beforeTree: tree, afterTree, allowlist: task.allowlist, designLock: cfg.designLock });
  if (!g2.pass) return { ok: false, stage: 'pre_apply', gate: 'G2', evidence: g2.evidence };
  try { for (const f of out) fileToEdits(f.path, f.before, f.after); } catch (e) { return fail('CANDIDATE_INVALID', { code: e.code, message: String(e.message).slice(0, 200) }); }
  return { ok: true, files: out, afterTree };
}

async function applyChange({ root, sessionDir, files, fixUnitId, reportId }) {
  const edits = files.flatMap((f) => fileToEdits(f.path, f.before, f.after));
  const candidate = attachDiffToCandidate(validateAndBuildCandidate({ localRoot: root, reportId, policyVersion: 'harness-1', edits }));
  // Staging binding required by the transaction API; it is not an acceptance proof (the gates decide, after this).
  const { artifactId } = persistVerificationArtifact(sessionDir, {
    status: 'passed', candidateHash: candidate.candidateHash, diffHash: candidate.diffHash, targetFindingIds: [], removedTargets: [], newCriticalSerious: [],
    build: { exitCode: 0 }, sourceTraceResolved: true, environment: { shadow: true, localLighthouse: false, psiParity: false, provenance: 'local-shadow' },
  });
  const tx = await applyBatchTransaction({ localRoot: root, sessionDir, entries: [{ fixUnitId, candidate, candidateHash: candidate.candidateHash, diffHash: candidate.diffHash, verificationArtifactId: artifactId }] });
  return { tx, candidate };
}

async function rollbackAndVerify({ root, tx, files }) {
  const r = await rollbackTransaction({ localRoot: root, transactionDir: tx.transactionDir });
  const bad = files.filter((f) => sha(readFileSync(join(root, f.path))) !== sha(Buffer.from(f.before, 'utf8')));
  if (r.conflicts.length || bad.length) throw new HarnessError('ROLLBACK_FAILED', `rollback left ${r.conflicts.length} conflict(s) and ${bad.length} changed file(s)`);
  return r;
}

const SPARSE_PIXELS = 1000;
/** True when the only failures are small pixel diffs (G4) and flipped interaction smokes (G6): the two gates a single noisy capture can trip. */
export const sparseOnly = (r) => !r.pass && r.gates.filter((g) => !g.pass).every((g) => (g.gate === 'G4' && g.evidence.every((e) => e.kind === 'PIXEL_DIFF' && e.diffPixels <= SPARSE_PIXELS)) || (g.gate === 'G6' && g.evidence.every((e) => e.kind === 'INTERACTION_CHANGED')));
const trimGateEvidence = (gateResult) => gateResult.gates.filter((g) => !g.pass).map((g) => ({ gate: g.gate, evidence: g.evidence.slice(0, 12) }));

/**
 * Runs the harness. tasks: buildTaskSet(...).tasks (or objects with { id, rule, source:{file,line}, pages, occurrences, ids, allowlist? }).
 * config: see resolveConfig and docs/fix-harness.md section 11 (build, outDir, routes, viewports, perfRuns, perfRunner, scanner, site, maxRepairs, dryRun, ...).
 */
export async function runHarness({ projectDir, tasks = [], fixer, config = {} }) {
  const cfg = resolveConfig(config);
  if (!fixer || typeof fixer.propose !== 'function') throw new HarnessError('FIXER_INVALID', 'fixer.propose(task, context) is required.');
  const rootCheck = resolveTrustedRoot(projectDir);
  if (!rootCheck.ok) throw new HarnessError('PROJECT_MISSING', 'projectDir is not a readable directory.');
  const projectRoot = rootCheck.localRoot;
  const ownRunDir = !cfg.runDir;
  const runDir = resolve(cfg.runDir || mkdtempSync(join(tmpdir(), 'ada-harness-')));
  const relRun = relative(projectRoot, runDir);
  if (!relRun.startsWith('..') && !isAbsolute(relRun) && !/^(?:\.ada-scan|scan-reports)(?:[\\/]|$)/.test(relRun)) throw new HarnessError('CONFIG_INVALID', 'runDir inside the project must be under .ada-scan/ or scan-reports/.');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const shadowRoot = join(runDir, 'shadow'), sessionDir = join(runDir, 'session');
  const log = cfg.log || (() => {});
  const reportId = `sha256:${sha(Buffer.from(`${projectRoot}|${Date.now()}`))}`;
  const signal = cfg.signal;
  const runStarted = Date.now();

  copyProjectTreeIntoShadow({ localRoot: projectRoot, shadowRoot });
  // A build needs the project's dependencies, and the copy excludes node_modules: link them unless the config says shareNodeModules: false.
  // With an install command the install must run in the shadow, not write through the link into the project: link only when asked explicitly.
  if ((cfg.shareNodeModules ?? !cfg.prepare) && existsSync(join(projectRoot, 'node_modules')) && !existsSync(join(shadowRoot, 'node_modules'))) linkNodeModules(projectRoot, shadowRoot);
  // Pre-edit state for the working-tree flow: the shadow is the project as it was (HEAD text, edits removed), the tasks bring the edits back.
  for (const [rel, text] of cfg.baselineOverride || []) {
    const target = join(shadowRoot, validateRelativeCandidatePath(rel));
    if (text == null) rmSync(target, { force: true }); else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }
  }
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  const norm = tasks.map((t) => normalizeTask(t, cfg));
  const routes = cfg.routes || [...new Set(norm.flatMap((t) => t.routes))].sort();
  if (!routes.length) routes.push('/');
  const incomplete = [];
  const results = [];
  const accepted = [];       // { task, files, decisionInfo }
  const queuedItems = [];
  const original = new Map(); // path -> project text at first touch
  const cumulative = new Map(); // path -> shadow text after accepted tasks
  let siteHandle = null;
  let siteDirty = false;
  let siteBuilds = 0;
  // Where the run's time goes (ms per phase) and how much work the incremental rescan avoided: written to the summary and harness-report.json.
  const timings = {}, counts = { snapshotCells: 0, snapshotCellsReused: 0, scanRoutes: 0, scanRoutesReused: 0, perfRoutes: 0, candidates: 0, candidatesAllRoutes: 0 };
  const timed = async (key, fn) => { const t = Date.now(); try { return await fn(); } finally { timings[key] = (timings[key] || 0) + Date.now() - t; } };
  const routeIndex = routeIndexFromReport(cfg.report);

  try {
    if (cfg.prepare) {
      const p = await runManagedCommand(cfg.prepare.command, cfg.prepare.args, shadowRoot, { signal });
      if (p.code !== 0) throw new HarnessError('PREPARE_FAILED', `prepare command exited ${p.code}`);
    }
    const rebuild = async () => { siteBuilds++; return timed('buildMs', () => runBuild({ root: shadowRoot, build: cfg.build, outDir: cfg.outDir, signal, timeoutMs: cfg.buildTimeoutMs })); };
    const firstBuild = await rebuild();
    if (!firstBuild.ok) throw new HarnessError('BASELINE_BUILD_FAILED', `the project build failed on the untouched copy (exit ${firstBuild.exitCode}): ${firstBuild.stderrTail.slice(-300)}${buildFailureHint(firstBuild, shadowRoot, projectRoot, cfg)}`);
    const adapter = siteAdapterFor(cfg, projectRoot);
    // The dev server reads the shadow's sources on every request: a rolled-back edit needs no rebuild to be served again. A static site serves dist, which does.
    const servedFromSource = adapter.kind === 'vite';
    siteHandle = await timed('siteStartMs', () => startCandidateSite(adapter, shadowRoot, { signal }));
    const baseUrl = siteHandle.url;

    let scanner = cfg.scanner;
    if (!scanner) { const { createCliScanner } = await import('./scanner-cli.js'); scanner = createCliScanner({ concurrency: cfg.scanConcurrency }); }
    // Every rescan is kept in the run dir (scans/<label>.json, the scanner's own rows) so the counts of the reports can be audited.
    const scanFiles = {};
    // scanRoutes: the routes to scan; the rows of every other route come from `keep` (the accepted state's rows), which is how an unchanged route is not rescanned.
    const scan = async (bindings = [], targetFindingIds = [], label = null, { routes: scanRoutes = routes, keep = [] } = {}) => {
      counts.scanRoutes += scanRoutes.length; counts.scanRoutesReused += routes.length - scanRoutes.length;
      const raw = (await timed('scanMs', () => scanner({ workspaceRoot: shadowRoot, siteUrl: baseUrl, routes: scanRoutes, layers: ['accessibility'], signal, candidateBindings: bindings, targetFindingIds }))).findings;
      if (label) {
        try { mkdirSync(join(runDir, 'scans'), { recursive: true }); const f = `scans/${label}.json`; writeFileSync(join(runDir, f), `${JSON.stringify({ label, routes: scanRoutes, reusedRoutes: routes.filter((r) => !scanRoutes.includes(r)), layers: HARNESS_LAYERS, count: (raw || []).length, findings: raw || [] }, null, 2)}\n`); scanFiles[label] = f; } catch { /* best effort: the report still carries the counts */ }
      }
      const own = new Set(scanRoutes);
      return [...keep.filter((f) => !own.has(f.route)), ...normalizeFindings(raw)];
    };
    // only/reuse: capture just `only` and take the other routes from the earlier snapshot `reuse` (see captureSnapshot).
    const capture = async (name, perfRuns = cfg.perfRuns, { only = null, reuse = null } = {}) => {
      const snap = await captureSnapshot({ baseUrl, routes, dir: join(runDir, 'snapshots', name), viewports: cfg.viewports, perfRuns, perfRoutes: cfg.perfRoutes || routes, perfRunner: cfg.perfRunner, timeBudgetMs: cfg.snapshotBudgetMs, concurrency: cfg.snapshotConcurrency, ...(reuse ? { reuse: { snapshot: reuse, routes: only } } : {}) });
      timings.snapshotCellsMs = (timings.snapshotCellsMs || 0) + snap.timings.cellsMs; timings.perfMs = (timings.perfMs || 0) + snap.timings.perfMs;
      counts.snapshotCells += Object.values(snap.routes).reduce((n, c) => n + Object.keys(c).length, 0) - snap.reused.cells; counts.snapshotCellsReused += snap.reused.cells;
      counts.perfRoutes += Object.keys(snap.perf).length - snap.reused.perf;
      return snap;
    };
    const snapshotIssues = (snap, name) => {
      if (snap.truncated) incomplete.push(`${name} snapshot truncated (the capture ended early: time budget snapshotBudgetMs = ${cfg.snapshotBudgetMs} ms, set under "harness" in .scan-config.json, or fewer perf runs than perfRuns)${name === 'baseline' ? '; baseline-incomplete, so no task was tried' : ''}`);
      for (const [route, cells] of Object.entries(snap.routes)) for (const [vp, c] of Object.entries(cells)) if (c?.error) incomplete.push(`${name} snapshot ${route} ${vp}: ${c.error}`);
    };
    const writeSnapshotJson = (snap) => { try { writeFileSync(join(snap.screenshotDir, 'snapshot.json'), JSON.stringify(snap)); } catch { /* best effort: the in-memory snapshot is what the gates used */ } };
    const gateSet = cfg.perfRuns > 0 ? GATE_IDS : GATE_IDS.filter((g) => g !== 'G7');

    // ---- baseline on the untouched shadow ----
    const baseSnap = await capture('baseline');
    snapshotIssues(baseSnap, 'baseline');
    // A truncated baseline is an environment problem (a loaded machine, too small a budget), not a candidate failure: every gate would fail closed on it
    // (SNAPSHOT_TRUNCATED before:true), so no task is tried, none is rolled back and none is classed gate_failed.
    const baselineIncomplete = Boolean(baseSnap.truncated);
    if (baselineIncomplete) log(`baseline snapshot truncated: stopping before any task (raise snapshotBudgetMs, now ${cfg.snapshotBudgetMs} ms)`);
    // Two captures of the untouched site: whatever differs between them (counters, animation frames, antialiasing) is noise, stored on the baseline
    // snapshot (snapshot.json) so the run directory reproduces its own verdicts. baselineRuns: 1 turns this off.
    if (!baselineIncomplete && (cfg.baselineRuns ?? 2) > 1) {
      const again = await capture('baseline-2', 0);
      baseSnap.noise = baselineNoise(baseSnap, again, cfg.compare);
      writeSnapshotJson(baseSnap);
      const n = Object.values(baseSnap.noise).reduce((c, v) => c + Object.keys(v).length, 0);
      if (n) log(`baseline noise: ${n} route/viewport cell(s) differ between two baseline captures and are ignored by the gates`);
    }
    const baseHtml = await timed('htmlMs', () => countHtmlValidateErrors({ baseUrl, routes, validate: cfg.validateHtml, fetchImpl: cfg.fetchImpl }));
    for (const k of baseHtml.skipped) incomplete.push(`baseline html-validate skipped ${k.route}: ${k.reason}`);
    const baseExport = checkExport({ root: shadowRoot, outDir: cfg.outDir, exportFile: cfg.exportFile });
    const baseFindings = await scan([], [], 'baseline');
    const tree0 = readTree(shadowRoot);
    for (const k of [...tree0.keys()]) if (k === cfg.outDir || k.startsWith(`${cfg.outDir}/`)) tree0.delete(k);
    let cur = { snapshot: baseSnap, findings: baseFindings, tree: tree0, htmlErrors: baseHtml, exportKeys: baseExport.keys || null, label: 'baseline' };
    log(`baseline: ${routes.length} route(s), ${baseFindings.length} finding(s)`);

    const ensureBuilt = async () => {
      if (!siteDirty) return;
      if (servedFromSource) { siteDirty = false; return; }
      const b = await rebuild();
      if (!b.ok) throw new HarnessError('REBUILD_FAILED', 'the untouched-state rebuild after a rollback failed');
      siteDirty = false;
    };

    // ---- per task ----
    for (const task of [...norm].sort(taskOrder)) {
      const res = { taskId: task.id, rule: task.rule, file: task.source?.file || null, line: task.source?.line ?? null, outcome: null, reasonClass: null, detail: null, iterations: [], failedGates: [], evidence: [], decision: null };
      results.push(res);
      if (task.requiresDesignDecision || isDesignLocked(task.rule)) { Object.assign(res, { outcome: 'skipped', reasonClass: 'needs_design_decision', detail: 'design lock' }); continue; }
      if (!task.allowlist.length) { Object.assign(res, { outcome: 'skipped', reasonClass: 'not_traced', detail: 'no traced source file, so no allowlist can be built' }); continue; }
      if (baselineIncomplete) { Object.assign(res, { outcome: 'skipped', reasonClass: 'baseline_incomplete', detail: `the baseline snapshot is truncated, so no gate could judge a candidate: raise snapshotBudgetMs (now ${cfg.snapshotBudgetMs} ms) and run again` }); continue; }
      const targetIds = mapTargets(task, cur.findings);
      if (!targetIds.length) {
        const detail = task.layer === 'lighthouse'
          ? `layer not run in the harness: this is a lighthouse finding and the rescan runs ${HARNESS_LAYERS}, so its fix cannot be verified here (check it with a normal scan)`
          : 'the finding is not reproduced by the local scan of the shadow build';
        Object.assign(res, { outcome: 'skipped', reasonClass: 'not_reproduced_locally', detail }); continue;
      }
      await ensureBuilt();
      const selectors = [...task.occurrences.map((o) => o.selector), ...task.targetSelectors].filter(Boolean);
      let targets = [];
      if (selectors.length) for (const route of task.routes) targets.push(...await resolveKeys({ baseUrl, route, selectors }));
      targets = [...new Set(targets)];
      let documented = [];
      if (task.documented.length) for (const route of task.routes) documented.push(...await resolveKeys({ baseUrl, route, selectors: task.documented }));
      documented = [...new Set(documented)];

      let previous = null, gateEvidence = null;
      const maxIter = 1 + cfg.maxRepairs;
      for (let iteration = 1; iteration <= maxIter; iteration++) {
        // An editor owns the edit (working-tree flow): replaying the same hunk again cannot repair anything.
        if (fixer.noRepair && iteration > 1) break;
        const it = { iteration };
        res.iterations.push(it);
        let proposal;
        try {
          proposal = await fixer.propose(task, { workspace: shadowRoot, iteration, previous, gateEvidence, read: (p) => readCurrent(shadowRoot, p) });
        } catch (err) { Object.assign(res, { outcome: 'declined', detail: `fixer error: ${String(err.message).slice(0, 200)}` }); it.stage = 'fixer_error'; break; }
        if (!proposal || proposal.declined || (Array.isArray(proposal.files) && !proposal.files.length)) {
          Object.assign(res, { outcome: 'declined', reasonClass: declineReasonClass(task.rule), editorFlow: Boolean(fixer.noRepair), detail: String(proposal?.declined || 'no change proposed').slice(0, 200) }); it.stage = 'declined'; break;
        }
        previous = { files: proposal.files, rationale: proposal.rationale || null };
        res.rationale = proposal.rationale || null;
        const prep = prepareCandidate({ task, proposal, shadowRoot, tree: cur.tree, cfg });
        if (!prep.ok) {
          Object.assign(it, { stage: prep.stage, failedGates: prep.gate ? [prep.gate] : [], evidence: prep.evidence });
          Object.assign(res, { outcome: 'rejected', failedGates: prep.gate ? [prep.gate] : [], evidence: [{ gate: prep.gate || 'CANDIDATE', evidence: prep.evidence }], detail: prep.evidence[0]?.kind });
          gateEvidence = [{ gate: prep.gate || 'CANDIDATE', evidence: prep.evidence }];
          continue;
        }
        // apply in the shadow (atomic transaction), rebuild, snapshot, scan, gates
        let tx;
        try { ({ tx } = await applyChange({ root: shadowRoot, sessionDir, files: prep.files, fixUnitId: `${task.id}-${iteration}`.slice(0, 100), reportId })); } catch (err) {
          Object.assign(it, { stage: 'pre_apply', evidence: [{ kind: 'CANDIDATE_INVALID', code: err.code, message: String(err.message).slice(0, 200) }] });
          Object.assign(res, { outcome: 'rejected', failedGates: [], evidence: [{ gate: 'CANDIDATE', evidence: it.evidence }], detail: 'CANDIDATE_INVALID' });
          gateEvidence = [{ gate: 'CANDIDATE', evidence: it.evidence }];
          continue;
        }
        if (tx.status !== 'committed') throw new HarnessError('SHADOW_APPLY_FAILED', `shadow apply ended ${tx.status}`);
        siteDirty = true;
        const wrote = prep.files.filter((f) => sha(readFileSync(join(shadowRoot, f.path))) !== sha(Buffer.from(f.after, 'utf8')));
        if (wrote.length) { await rollbackAndVerify({ root: shadowRoot, tx, files: prep.files }); Object.assign(it, { stage: 'pre_apply', evidence: [{ kind: 'WRITTEN_BYTES_DIFFER', files: wrote.map((f) => f.path) }] }); Object.assign(res, { outcome: 'rejected', failedGates: [], evidence: [{ gate: 'CANDIDATE', evidence: it.evidence }], detail: 'WRITTEN_BYTES_DIFFER' }); gateEvidence = [{ gate: 'CANDIDATE', evidence: it.evidence }]; continue; }
        const name = `t${results.length}-${iteration}`;
        const build = await rebuild();
        let gateResult, snap = null, findings = null, facts = null, reach = null;
        const inputs = { beforeTree: cur.tree, afterTree: prep.afterTree, allowlist: task.allowlist, designLock: cfg.designLock, targets, documented, compare: { ...cfg.compare, ...RULE_COMPARE[String(task.rule || '').toLowerCase()] } };
        if (!build.ok) {
          gateResult = runGates({ ...inputs, only: ['G2', 'G8'], build: { build: { ok: false, exitCode: build.exitCode } } });
        } else {
          // Served documents first: which routes an edit changed decides what is captured and scanned below.
          const afterHtml = await timed('htmlMs', () => countHtmlValidateErrors({ baseUrl, routes, validate: cfg.validateHtml, fetchImpl: cfg.fetchImpl }));
          reach = affectedRoutes({ routes, touched: prep.files.map((f) => f.path), taskRoutes: task.routes, before: cur.htmlErrors?.hashes, after: afterHtml.hashes, routeIndex, enabled: cfg.incrementalRoutes });
          counts.candidates += 1; if (reach.all) counts.candidatesAllRoutes += 1;
          const part = reach.all ? {} : { only: reach.routes, reuse: cur.snapshot };
          it.routesChecked = reach.routes; if (!reach.all) it.routesReused = routes.filter((r) => !reach.routes.includes(r));
          snap = await capture(name, undefined, part);
          snapshotIssues(snap, name);
          findings = await scan(prep.files.map((f) => ({ file: f.path })), targetIds, name, reach.all ? {} : { routes: reach.routes, keep: cur.findings });
          facts = await timed('factsMs', () => collectBuildFacts({ root: shadowRoot, buildResult: build, outDir: cfg.outDir, baseUrl, routes, touchedFiles: prep.files.map((f) => f.path), baseline: cur, config: cfg, signal, htmlErrors: afterHtml }));
          const gate = (after) => runGates({
            ...inputs, before: cur.snapshot, after, only: gateSet, perf: cfg.perf,
            findings: { targetFindingIds: targetIds, affectedRoutes: task.routes, before: cur.findings, after: findings }, build: facts.facts,
          });
          gateResult = gate(snap);
          // A small sparse pixel diff or a flipped interaction smoke is usually capture noise: one recapture decides, the second capture is the one stored.
          if (sparseOnly(gateResult)) {
            const again = await capture(`${name}-r`, 0, part);
            again.perf = snap.perf; // the recapture is for the pixel and interaction noise; the perf runs of the first capture stand (a capture without perf would fail G7 as PERF_MISSING)
            snapshotIssues(again, `${name}-r`);
            const second = gate(again);
            if (second.pass) { snap = again; gateResult = second; }
          }
        }
        const files = prep.files.map((f) => f.path);
        const changedLines = prep.files.reduce((n, f) => n + changedLineCount(f.before, f.after), 0);
        const decision = decide({ gateResult, mechanicallySafe: Boolean(fixer.mechanicallySafe), changedLines, files, iteration, maxIterations: maxIter, policy: cfg.policy });
        const diff = unifiedDiff(prep.files);
        const delta = findings ? scanDeltaOf(cur.findings, findings) : null;
        const evidence = buildEvidence({ gateResult, before: cur.snapshot, after: snap, diff, scanDelta: delta, risk: decision.risk, decision: decision.decision, runDir });
        Object.assign(it, { stage: 'post_apply', decision: decision.decision, reason: decision.reason, failedGates: gateResult.failed, gateTable: gateResult.table, changedLines, files, snapshot: snap ? `snapshots/${name}` : null, buildNotes: facts?.notes || [] });
        for (const g of gateResult.gates) if (g.evidence.some((e) => e.kind === 'NOT_PROVIDED')) incomplete.push(`${task.id}: ${g.gate} input missing`);
        res.warnings = gateResult.gates.flatMap((g) => g.warnings || []);
        Object.assign(res, { decision: decision.decision, risk: decision.risk, failedGates: gateResult.failed, evidence: trimGateEvidence(gateResult), files, diff, scanDelta: delta, evidencePack: evidence });

        if (decision.decision === 'auto_accept') {
          Object.assign(res, { outcome: 'accepted', detail: decision.reason, reasonClass: null });
          for (const f of prep.files) { if (!original.has(f.path)) original.set(f.path, f.before); cumulative.set(f.path, f.after); }
          accepted.push({ task, files: prep.files, reach });
          if (cur.snapshot.noise && !snap.noise) { snap.noise = cur.snapshot.noise; writeSnapshotJson(snap); }
          cur = { snapshot: snap, findings, tree: prep.afterTree, htmlErrors: facts.measured.htmlErrors, exportKeys: facts.measured.exportKeys, label: task.id };
          siteDirty = false; // the shadow now equals the accepted state and the site serves it
          break;
        }
        await rollbackAndVerify({ root: shadowRoot, tx, files: prep.files });
        siteDirty = true;
        if (decision.decision === 'human_review') {
          Object.assign(res, { outcome: 'queued', detail: decision.reason });
          queuedItems.push({ taskId: task.id, rule: task.rule, file: task.source?.file || prep.files[0].path, line: task.source?.line ?? null, routes: task.routes, findingIds: targetIds, files: prep.files, rationale: proposal.rationale, evidence });
          break;
        }
        Object.assign(res, { outcome: 'rolled_back', detail: decision.reason });
        gateEvidence = trimGateEvidence(gateResult);
        if (!decision.retry) break;
      }
      if (res.outcome == null) res.outcome = 'rejected';
      log(`${task.id}: ${res.outcome}${res.failedGates?.length ? ` (${res.failedGates.join(',')})` : ''}`);
    }

    // ---- final state: rescan with the real scanner, delta, diff, apply ----
    let finalFindings = cur.findings;
    let finalProved = !accepted.length; // nothing accepted: the baseline scan already is a scan of the final state
    // The routes any accepted candidate changed (every route when one of them could not be narrowed): the rest still has its baseline rows.
    const finalReach = accepted.some((a) => !a.reach || a.reach.all) ? { all: true } : { all: false, routes: [...new Set(accepted.flatMap((a) => a.reach.routes))].sort() };
    if (accepted.length && cfg.finalRescan) {
      try { await ensureBuilt(); finalFindings = await scan([], [], 'final', finalReach.all ? {} : { routes: finalReach.routes, keep: baseFindings }); finalProved = true; } catch (err) { incomplete.push(`final rescan failed: ${String(err.message).slice(0, 160)}`); }
    }
    const scanDelta = scanDeltaOf(baseFindings, finalFindings);
    const finalFiles = [...cumulative].map(([path, after]) => ({ path, before: original.get(path), after })).filter((f) => f.before !== f.after);
    const diff = unifiedDiff(finalFiles);

    const queue = queueForReview({ items: queuedItems, sessionDir: join(runDir, 'review'), localRoot: projectRoot, reportId });
    const touched = new Set(finalFiles.map((f) => f.path));
    for (const q of queue.queued) {
      const r = results.find((x) => x.taskId === q.taskId);
      const stale = q.registered && queuedItems.find((i) => i.taskId === q.taskId).files.some((f) => touched.has(f.path));
      if (r) r.review = { fixUnitId: q.fixUnitId, registered: q.registered && !stale, reason: stale ? 'STALE_AFTER_ACCEPTED_TASK' : (q.reason || null) };
    }

    let applied = false, applyStatus = cfg.dryRun ? 'dry_run' : (finalFiles.length ? 'pending' : 'nothing_to_apply');
    if (!cfg.dryRun && finalFiles.length) {
      const drift = finalFiles.find((f) => { try { return readCurrent(projectRoot, f.path) !== f.before; } catch { return true; } });
      if (drift) { applyStatus = `project_changed:${drift.path}`; incomplete.push(applyStatus); }
      else {
        const pSession = join(runDir, 'session-project');
        mkdirSync(pSession, { recursive: true, mode: 0o700 });
        const { tx } = await applyChange({ root: projectRoot, sessionDir: pSession, files: finalFiles, fixUnitId: 'harness-final', reportId });
        applied = tx.status === 'committed';
        applyStatus = tx.status;
        if (!applied) incomplete.push(`final apply ended ${tx.status}`);
      }
    }

    // The rescan names findings its own way (ids can differ from the report's): tie each to its task by id, route, rule family and selector, as the gates do.
    const rescanned = [...baseFindings, ...finalFindings];
    const remainingTasks = norm.map((t) => ({ ...t, ids: [...new Set([...t.ids, ...mapTargets(t, rescanned)])] }));
    const remaining = buildRemainingReport({ report: cfg.report || null, tasks: remainingTasks, results, notActionable: cfg.notActionable || [], incomplete: [...new Set(incomplete)], scanDelta, finalScan: { proved: finalProved }, baselineFindings: baseFindings, finalFindings,
      queuedEdits: queuedItems.map((i) => ({ ...i, files: i.files.map((f) => f.path), review: results.find((x) => x.taskId === i.taskId)?.review })), workingTree: Boolean(cfg.workingTree) });
    const reportDir = join(runDir, 'report');
    const remainingFiles = writeRemainingReport(remaining, reportDir);
    const summary = {
      status: remaining.status, ...(baselineIncomplete ? { environment: { class: 'baseline-incomplete', snapshotBudgetMs: cfg.snapshotBudgetMs } } : {}), runDir, dryRun: cfg.dryRun, applied, applyStatus, routes, viewports: cfg.viewports.map((v) => `${v.width}x${v.height}`), fixer: fixer.name || null,
      gatesSkipped: gateSet.length === GATE_IDS.length ? [] : ['G7'], builds: siteBuilds, timings: { ...timings, totalMs: Date.now() - runStarted }, counts,
      table: results.map((r) => ({ taskId: r.taskId, rule: r.rule, file: r.file, line: r.line, outcome: r.outcome, reasonClass: r.reasonClass, failedGates: r.failedGates, iterations: r.iterations.length, decision: r.decision, detail: r.detail, warnings: r.warnings || [] })),
      scans: scanFiles,
      ...(cfg.workingTree ? { workingTree: { unassigned: cfg.workingTree.unassigned().map((u) => { const o = u.ownedBy != null ? results.find((r) => r.taskId === u.ownedBy) : null; return o ? { ...u, reason: `edit owned by task ${o.taskId}, which was ${o.outcome}${o.reasonClass ? ` (${o.reasonClass})` : ''}: not verified` } : u; }), gates: gateSet } } : {}),
      accepted: accepted.map((a) => a.task.id), queued: queuedItems.map((q) => q.taskId), scanDelta, diff, incomplete: remaining.incompleteReasons,
    };
    writeFileSync(join(reportDir, 'harness-report.json'), `${JSON.stringify({ ...summary, tasks: results.map(({ evidencePack, ...r }) => ({ ...r, evidencePack })) }, null, 2)}\n`);
    writeFileSync(join(reportDir, 'harness-report.md'), renderRunMarkdown(summary));
    if (cfg.keepShadow) summary.shadowRoot = shadowRoot;
    return { ...summary, tasks: results, remaining, files: { remainingJson: remainingFiles.json, remainingMarkdown: remainingFiles.markdown, report: join(reportDir, 'harness-report.json'), reportMarkdown: join(reportDir, 'harness-report.md') }, review: queue };
  } finally {
    await stopCandidateSite(siteHandle);
    await closeBrowser().catch(() => {});
    if (!cfg.keepShadow) { try { rmSync(shadowRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (ownRunDir && cfg.cleanup) { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/** file:line, or `file (untraced)` when the task has no real source line (line 0 or none reads as a real location). */
const locOf = (file, line) => (line > 0 ? `${file}:${line}` : `${file} (untraced)`);

export function renderRunMarkdown(s) {
  const L = [`# Harness run`, '', `Status: ${s.status}${s.dryRun ? (s.workingTree ? ' (dry run: the edits stay in your working tree, nothing was written back)' : ' (dry run: nothing written to the project)') : ''}; apply: ${s.applyStatus}; fixer: ${s.fixer || 'unknown'}.`, ''];
  L.push('| Task | Rule | File | Outcome | Failed gates | Iterations |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of s.table) L.push(`| ${r.taskId} | ${r.rule} | ${r.file ? locOf(r.file, r.line) : ''} | ${r.outcome}${r.reasonClass ? ` (${r.reasonClass})` : ''} | ${(r.failedGates || []).join(', ')} | ${r.iterations} |`);
  const warned = s.table.filter((r) => r.warnings?.length);
  if (warned.length) L.push('', '## Warnings: new findings an edit introduced (not gated)', '', ...warned.flatMap((r) => r.warnings.map((w) => `- ${r.taskId}: ${w.rule} (${w.tier}) on ${w.route} \`${w.selector || ''}\` is new after the edit; a person should check it`)));
  if (s.workingTree) {
    const u = s.workingTree.unassigned;
    L.push('', `Verified: each task's own hunks, replayed on a shadow copy of HEAD, through gates ${s.workingTree.gates.join(', ')}. Hunks no task claims, and hunks of skipped tasks, were not verified.`);
    L.push('', `## Changed hunks not verified: no scanned task claims them, or their task was skipped (${u.length})`, '', ...(u.length ? u.map((x) => `- ${x.path ? `${x.path}:${x.line ?? ''}` : 'whole diff'}${x.reason ? ` (${x.reason})` : ''}`) : ['None.']));
  }
  L.push('', `Scan delta (real scanner on the shadow): ${s.scanDelta.before} before${s.scanDelta.beforeRows !== s.scanDelta.before ? ` (${s.scanDelta.beforeRows} rows)` : ''}, ${s.scanDelta.after} after, ${s.scanDelta.fixed} fixed, ${s.scanDelta.added} new (rescan ids; ${s.accepted.length} task(s) accepted, and remaining.md splits the fixed defects into those in an accepted task's scope and side effects).`);
  if (s.timings) {
    const sec = (ms) => `${Math.round((ms || 0) / 1000)} s`, t = s.timings, c = s.counts || {};
    L.push(`Time: ${sec(t.totalMs)} in all (builds ${sec(t.buildMs)}, snapshot cells ${sec(t.snapshotCellsMs)}, perf runs ${sec(t.perfMs)}, scans ${sec(t.scanMs)}, html ${sec(t.htmlMs)}); ${c.scanRoutesReused ?? 0} route scan(s) and ${c.snapshotCellsReused ?? 0} snapshot cell(s) reused from the accepted state (${c.candidatesAllRoutes ?? 0} of ${c.candidates ?? 0} candidate(s) touched every route).`);
  }
  if (Object.keys(s.scans || {}).length) L.push(`Rescan rows kept in the run dir: ${Object.values(s.scans).join(', ')}.`);
  if (s.gatesSkipped.length) L.push(`Gates skipped: ${s.gatesSkipped.join(', ')} (no perf runs configured).`);
  if (s.incomplete.length) L.push('', `Incomplete: ${s.incomplete.join('; ')}`);
  L.push('', '## Diff of all accepted changes', '', '```diff', s.diff.trimEnd() || '(none)', '```', '');
  return L.join('\n');
}
