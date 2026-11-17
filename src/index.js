import { loadConfig, DEFAULT_CONFIG, KNOWN_LAYERS, derivePageName, DEFAULT_AXE_VIEWPORTS } from './utils/config.js';
import { buildTaskSet, writeTaskSet } from './fix/export/tasks.js';
import { TARGETS, exportRules } from './fix/export/rules.js';
import { excludeAdvice, installSkill, writtenNotice } from './fix/export/skill/install.js';
import { readExportedTasks, renderVerifyTable, verifyDiff } from './fix/export/skill/diff-check.js';
import { parseCliArgs, FIX_OPTIONS, CliError, USAGE } from './utils/cli-args.js';
import { resolveProject } from './utils/project.js';
import { ensureServer } from './utils/server.js';
import { killGroup } from './utils/process-group.js';
import { buildInstrumented, tryBuildInstrumented, loadScanAttestation, loadScanManifest } from './tracer/build-instrumented.js';
import { extractPageAttestationFromPage } from './tracer/page-attestation.js';
import { deriveScanTargetAndTrace } from './tracer/scan-target.js';
import { resolveTrustedRoot } from './fix/controller/local-attestation.js';
import { clearPartialCache, mapViolationToSource } from './tracer/partial-map.js';
import { disableBuiltOutput } from './tracer/resolve-source.js';
import { computeSourcePreimage } from './tracer/preimage.js';
import { clearTagIndexCache, collectRenderTree, isPageStructureRule } from './tracer/liquid-tag-index.js';
import { traceElement, traceToSourceFields } from './tracer/trace-element.js';
import { findBehaviorScript } from './tracer/behavior-script.js';
import { findAttributeWriter, VALUE_ATTRS as VALUE_WRITES } from './tracer/script-writes.js';
import { inHtmlComment, colorDeclarations, contrastColors, contrastTokens, dropContradicted, findScriptSetter, findTagsContaining, markupWrites, narrowByAncestry, narrowBySelectorChain, narrowByOwnText, renderTreeFiles, stackingDeclaration, widgetSnapshotAt } from './tracer/structural-source.js';
import { findDataSource, findAllDataSources } from './tracer/data-sidecar.js';
import { attachDuplicateIdSources } from './tracer/duplicate-id-lines.js';
import { applyColorOrigin, collectColorChains, groupByColorOrigin } from './tracer/color-origin.js';
import { applyCssOrigins, collectCssRules, ensureSourceLine, isSizeRule } from './tracer/css-origin.js';
import { resolveAdapter } from './tracer/adapters/index.js';
import { buildAxeEvidence, buildAxePageMetadata, scanPageWithAxe } from './scanner/axe.js';
import { scanWithAccessScan } from './scanner/access-scan/index.js';
import { resolveScanProfile } from './scanner/access-scan/engine/profiles.js';
import { buildAccessScanExecutionTotals } from './scanner/access-scan/engine/execution-totals.js';
import { CORPUS_COMPARATOR_VERSION } from './scanner/access-scan/corpus/constants.js';
import {
  installNoHydrateJobsRoutes,
  prepareNoHydrateJobsPage,
} from './scanner/access-scan/runtime/no-hydrate.js';
import { scanKeyboardNavigation } from './scanner/keyboard.js';
import { scanFocusTraps } from './scanner/focus-trap.js';
import { isScriptDependentRule } from './scanner/blocked-scripts.js';
import { scanAriaLiveRegions } from './scanner/aria-live.js';
import { scanDynamicContent } from './scanner/dynamic-content.js';
import { scanScreenReaderAccessibility } from './scanner/screen-reader.js';
import { scanW3cValidation } from './scanner/w3c.js';
import { scanHtmlValidate, htmlValidateKind, dropW3cDuplicates, HTML_VALIDATE_ENGINE, HTML_VALIDATE_VERSION, HTML_SOURCE_LIVE_DOM } from './scanner/html-validate.js';
import { isLoopbackUrl } from './utils/host-classify.js';
import { annotateOrigins, downgradeErrorPage, dropStaleEvidence, isEmptyPageTemplate, liveShellProbe } from './scanner/origin.js';
import { classifyOrigin, loadVendors, unboundFromSource, widgetSnapshotOrigin } from './tracer/ownership.js';
import { attachSiteFix } from './tracer/site-fix.js';
import { scanDeadLinks, createLinkChecker, loadProjectRoutes, routeNotServedLocally } from './scanner/links.js';
import { scanWithLighthouse, summarizeLighthouseRuns } from './scanner/lighthouse.js';
import { getBrowser, closeBrowser } from './scanner/browser.js';
import { runBounded, runInScope } from './utils/scan-scope.js';
import { openScanPage } from './scanner/session.js';
import { formatPhases, timed } from './utils/phases.js';
import { attachEvidence, reconcileEvidence } from './scanner/evidence.js';
import { applyMeasuredChecks } from './scanner/measured-checks.js';
import { applySvgChildOfNamedControl } from './scanner/svg-child-name.js';
import { printTraceRoot } from './scanner/scan-hygiene.js';
import { applyEnvironmentArtefacts, applyRenderArtefacts, applyUnresolvedText, leakNearSelectors, probeLiquidLeak } from './scanner/unresolved-text.js';
import { DEFAULT_VERIFY, reverifyFindings, summarizeReverify, needsReverify } from './scanner/reverify.js';
import { DEV_OVERLAY_REASON, EMPTY_PAGE_NOTE, UNRENDERABLE_NOTE, dropDevOverlayFindings, hasDevOverlay, isDevErrorOverlay, isUnrenderableLocally, derivePageStatus, isEmptyPage, isTimeoutError, isTransientFailure, isTransientLayerError, runLayerWithRetry } from './scanner/page-health.js';
import { IMPACT_ORDER, createViolation, impactToPriority, normalizeLighthouseViolation } from './schema.js';
import { buildReportBundle, writeReport, writeBaseline, printConsoleSummary, projectReportForLegacy, readReportFile, loadComparisonBase, buildComparison, writeSarif, writeQaReport } from './reporter/scan-report.js';
import { writeHtmlReport } from './reporter/html.js';
import { stableHtml, stableSelector } from './reporter/fingerprint.js';
import { fixModeError } from './fixer/fix-mode.js';
import { pageContentHash } from './reporter/manual-checks.js';
import { loadScanLabelContext } from './reporter/labels.js';
import { planCisFixRoute } from './fix/controller/cli-routing.js';
import { loadTrustedLocalAttestation } from './fix/controller/local-attestation.js';
import { FixControllerError } from './fix/controller/session.js';
import { requiresHybridAttestation } from './fix/controller/mode-gate.js';
import { discoverScanPages } from './discovery/pages.js';
import { generateExecSummary } from './reporter/exec-summary.js';
import { gitChangedSinceLastCommit } from './utils/git.js';
import { evaluateGate, formatGate, isDevServerHtml, isNoindex } from './utils/thresholds.js';
import { resolveIncludeThirdParty, setThirdPartyConfigRoot } from './utils/third-party.js';
import { capImpact, verdictFor } from './utils/verdict.js';
import path from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { getProjectRoot, urlToPageFile, setReportsDir, getReportsDir, resolveReportFile } from './utils/paths.js';

const PAGE_TIMEOUT_MS = 30000;
const REMOTE_PAGE_TIMEOUT_MS = 60000;
const LAYER_DEADLINE_MS = 180_000; // hard bound per layer attempt (a hung layer is retried once, then reported) (a layer takes seconds; page.evaluate-style calls have no timeout on a hung renderer)
const NAV_RETRIES = 1;
const PROJECT_ROOT = getProjectRoot();
let discoveryWarnings = [];
let discoveryTemplates = null;
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

// ─── Source tracing helpers ───────────────────────────────────────────────────

function findInLiquidSource(srcDir, searchHint, localRoot, allowed = null) {
  let commented = null; // a hit inside a comment is only a fallback: the rendered element comes from live markup
  try {
    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = walk(full);
          if (result) return result;
        } else if (entry.name.endsWith('.liquid')) {
          if (allowed && !allowed.has(path.relative(localRoot, full).split(path.sep).join('/'))) continue;
          const lines = readFileSync(full, 'utf-8').split('\n');
          let open = false; // inside <!-- --> or {% comment %} at the start of the line
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const inComment = open || /^\s*(<!--|\{%-?\s*comment)/.test(line);
            if (line.includes(searchHint)) {
              const hit = { file: path.relative(localRoot, full).split(path.sep).join('/'), line: i + 1 };
              if (!inComment) return hit;
              commented = commented || hit;
            }
            const opens = Math.max(line.lastIndexOf('<!--'), line.search(/\{%-?\s*comment\s*-?%\}/));
            const closes = Math.max(line.lastIndexOf('-->'), line.search(/\{%-?\s*endcomment/));
            if (opens > -1 && opens >= closes) open = true;
            else if (closes > -1) open = false;
          }
        }
      }
      return null;
    };
    return walk(srcDir) || commented;
  } catch {
    return commented;
  }
}

/** Every line of the .liquid files under srcDir (limited to `allowed`) that contains `hint` and passes `accept`, in directory order; comments are skipped. */
function findAllInLiquidSource(srcDir, hint, localRoot, allowed = null, accept = () => true) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = path.relative(localRoot, full).split(path.sep).join('/');
      if (!entry.name.endsWith('.liquid') || (allowed && !allowed.has(rel))) continue;
      readFileSync(full, 'utf-8').split('\n').forEach((line, i) => {
        if (line.includes(hint) && accept(line) && !/^\s*(<!--|\{%-?\s*comment)/.test(line)) out.push({ file: rel, line: i + 1 });
      });
    }
  };
  try { walk(srcDir); } catch { /* unreadable dir: what was found stands */ }
  return out;
}

/** The `>`-marked excerpt of `file` around `line` (what a finding's source.snippet shows), or null when the file cannot be read. */
function snippetAround(file, line, localRoot) {
  try {
    const filePath = path.isAbsolute(file) ? file : path.join(localRoot, file);
    if (!existsSync(filePath)) return null;
    const lines = readFileSync(filePath, 'utf8').split('\n');
    const start = Math.max(0, line - 5);
    const end = Math.min(lines.length, line + 5);
    return lines.slice(start, end).map((l, i) => {
      const num = start + i + 1;
      return `${num === line ? '>' : ' '} ${String(num).padStart(4)} | ${l}`;
    }).join('\n');
  } catch { return null; /* skip if file read fails */ }
}

function enrichLocalSnippets(violations, localRoot = PROJECT_ROOT) {
  for (const v of violations) {
    if (v.source?.snippet || !v.source?.file || !v.source?.line) continue;
    const snippet = snippetAround(v.source.file, v.source.line, localRoot);
    if (snippet) v.source.snippet = snippet;
  }
}

/**
 * Fingerprint-based deduplication of violations.
 *
 * Within-rule dedup: violations with identical (ruleId + normalized-outerHTML-prefix)
 * are collapsed into one, incrementing the `count` field. Axe findings include
 * the target selector because viewport duplicates are already merged upstream.
 *
 * Cross-scanner related: violations from different rules but targeting the same
 * element get `related[]` populated with the other rule IDs.
 */
export function countViolationOccurrences(violations = []) {
  return violations.reduce(
    (total, violation) => total + (
      Number.isInteger(violation.count) && violation.count > 0 ? violation.count : 1
    ),
    0
  );
}

export function buildAxeScannerRuns(axeResult = {}) {
  return (axeResult.summary?.viewports || []).map((viewport) => ({
    layer: 'axe',
    engine: {
      name: axeResult.testEngine?.name || 'axe-core',
      version: axeResult.testEngine?.version || 'unknown',
    },
    viewport: {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
    },
    pageState: 'initial',
    status: 'complete',
    htmlSource: HTML_SOURCE_LIVE_DOM, // axe runs inside the live page
    evidence: {
      issueGroups: viewport.issueGroups || 0,
      affectedNodes: viewport.affectedNodes || 0,
      incomplete: viewport.incomplete || 0,
      tags: [...(axeResult.tags || [])],
    },
  }));
}

export function buildAccessScanRun(violations = [], {
  includeThirdParty = false,
  engineVersion = null,
  profile = resolveScanProfile({ includeThirdParty }),
  execution = null,
  executionTotals = null,
  sessionMetrics = null,
} = {}) {
  const resolvedProfile = profile || resolveScanProfile({ includeThirdParty });
  const evidence = {
    ruleGroups: new Set(violations.map((violation) => violation.ruleId)).size,
    findingOccurrences: countViolationOccurrences(violations),
    fixUnits: violations.length,
    includeThirdParty,
    profile: resolvedProfile,
    comparatorVersion: CORPUS_COMPARATOR_VERSION,
  };

  if (executionTotals) {
    evidence.execution = executionTotals;
  } else if (execution) {
    evidence.engine = {
      profile: execution.profile || resolvedProfile,
      rules: {
        complete: execution.complete ?? 0,
        inapplicable: execution.inapplicable ?? 0,
        error: execution.error ?? 0,
        timeout: execution.timeout ?? 0,
      },
      candidates: execution.candidates ?? 0,
      findings: execution.findings ?? violations.length,
    };
    if (sessionMetrics) {
      evidence.engine.session = { ...sessionMetrics };
    }
  }

  return {
    layer: 'accessScan',
    engine: { name: 'ada-scan accessScan', version: engineVersion },
    viewport: { name: 'desktop', width: 1280, height: 900 },
    pageState: 'initial',
    status: 'complete',
    evidence,
  };
}

export function buildInternalScannerRun(layer, violations = [], {
  engineVersion = null,
  status = 'complete',
  errorCode = null,
  blockedScripts = [],
} = {}) {
  return {
    layer,
    engine: { name: `ada-scan ${layer}`, version: engineVersion },
    viewport: { name: 'desktop', width: 1280, height: 900 },
    pageState: 'initial',
    status,
    evidence: {
      ruleGroups: new Set(
        violations.map((violation) =>
          violation.ruleId || violation.rule || violation.id
        ).filter(Boolean)
      ).size,
      findingOccurrences: countViolationOccurrences(violations),
      fixUnits: violations.length,
      errorCode,
      ...(blockedScripts.length ? { blockedScripts } : {}), // scripts that did not load: behaviour they add was not present when this layer measured
    },
  };
}

/**
 * Carries what a behavioural layer measured onto its violation (proof, a verdict it already downgraded, a lower impact). A rule whose
 * result depends on a page script is needs-review when a script of the page did not load during the scan (blocked CDN, 4xx/5xx).
 */
// Keyboard rows whose own check measured the instance but record no evidence.proof (keyboard.js): focus-not-visible (confirmed only with the focused-vs-blurred
// pixel comparison), focus-invisible-stop (focus measured landing on it), skip-link-* (first stops listed, fragment id looked up in the DOM). The check's
// instance description is that measurement; a row the check left needs-review, and every other keyboard rule, gets no proof and cannot confirm.
const KEYBOARD_MEASURED_RULES = new Set(['focus-not-visible', 'focus-invisible-stop', 'skip-link-missing', 'skip-link-target-missing']);
export function keyboardEvidence(v) {
  const evidence = { ...(v.evidence || {}) };
  if (v.element?.obscuredBy) evidence.obscuringChain = [{ tag: v.element.obscuredBy.tag, attrs: { id: v.element.obscuredBy.id, class: v.element.obscuredBy.className } }];
  const ruleId = v.rule || v.id;
  if (!evidence.proof && KEYBOARD_MEASURED_RULES.has(ruleId) && v.verdict !== 'needs-review' && typeof v.description === 'string' && v.description.trim()) {
    evidence.proof = { type: 'measured-fact', fact: v.description };
  }
  return Object.keys(evidence).length ? evidence : undefined;
}

export function carryMeasurement(violation, raw, blocked = []) {
  if (raw.evidence) violation.evidence = { ...(violation.evidence || {}), ...raw.evidence };
  if (raw.verdict) violation.verdict = raw.verdict;
  if (raw.verdict && raw.impact && IMPACT_ORDER.includes(raw.impact)) violation.impact = raw.impact;
  if (blocked.length && isScriptDependentRule(violation.ruleId) && !raw.verdict) {
    violation.verdict = 'needs-review';
    violation.evidence = { ...(violation.evidence || {}), blockedScripts: blocked, reason: `behaviour script not loaded during the scan (${blocked.length}: ${blocked.slice(0, 3).map((b) => b.url).join(', ')})` };
  }
  return violation;
}

/** Scanner run for a layer that threw: `timeout` when the engine timed out, else `error`. */
export function buildFailedLayerRun(layer, err, { errorCode = 'scan-failed' } = {}) {
  const run = buildInternalScannerRun(layer, [], {
    engineVersion: PACKAGE_VERSION,
    status: isTimeoutError(err) ? 'timeout' : 'error',
    errorCode,
  });
  run.evidence.errorMessage = (err?.message || '').split('\n')[0];
  run.evidence.transient = isTransientLayerError(err);
  return run;
}

/** A page that could not be scanned at all: navigation failed, HTTP error or challenge page. */
function buildFailedPageResult(pageConfig, failure) {
  return {
    name: pageConfig.name,
    url: pageConfig.url,
    violations: [],
    lighthouseScores: {},
    axeSummary: null,
    scannerRuns: [buildFailedLayerRun('orchestrator', { message: failure.message }, { errorCode: failure.reason })],
    pageAttestation: { ok: false, reason: 'PAGE_ATTESTATION_UNAVAILABLE' },
    scanFailed: true,
    status: 'failed',
    failure,
  };
}

/** A navigated page with no content (empty template): no layer runs; neither failed nor incomplete. */
function buildEmptyPageResult(pageConfig, attempts, skipped = { reason: 'empty-page', note: EMPTY_PAGE_NOTE }) {
  return {
    name: pageConfig.name,
    url: pageConfig.url,
    violations: [],
    lighthouseScores: {},
    axeSummary: null,
    scannerRuns: [],
    pageAttestation: null,
    scanFailed: false,
    status: 'skipped-empty',
    failure: null,
    skipped,
    attempts,
  };
}

/** A page never started because the --max-time budget ran out: failed, so the scan is incomplete (exit 2). */
function buildSkippedPageResult(pageConfig) {
  const failure = { reason: 'skipped', httpStatus: null, message: '--max-time budget exhausted before this page started' };
  return {
    ...buildFailedPageResult(pageConfig, failure),
    scannerRuns: [buildInternalScannerRun('orchestrator', [], { engineVersion: PACKAGE_VERSION, status: 'skipped', errorCode: 'skipped' })],
    attempts: 0,
  };
}

/**
 * 0 clean; 1 violations at --fail-on-violations or a failed threshold gate at --gate; 2 incomplete scan (wins over 1).
 * --no-fail only silences 1; only --allow-incomplete silences 2.
 */
export function computeExitCode(summary = {}, { noFail = false, failOnViolations = false, allowIncomplete = false, gate = false, gateResult = null, countThirdParty = false, countPlatform = false } = {}) {
  // A partial page counts only for its gating layers (pagesPartialGating; every layer with scan.strict); absent: all partial pages count.
  const incomplete = (summary.pagesFailed || 0) > 0 || (summary.pagesPartialGating ?? summary.pagesPartial ?? 0) > 0;
  if (incomplete && !allowIncomplete) return 2;
  const foreign = (countThirdParty ? 0 : (summary.verdictCounts ? summary.thirdPartyConfirmed : summary.ownershipCounts?.thirdParty) || 0)
    + (countPlatform ? 0 : (summary.verdictCounts ? summary.platformConfirmed : summary.ownershipCounts?.platform) || 0);
  if (failOnViolations && !noFail && (summary.verdictCounts?.confirmed ?? summary.occurrenceCount ?? summary.totalViolations ?? 0) - foreign > 0) return 1;
  if (gate && !noFail && gateResult?.failed) return 1;
  return 0;
}

export function buildLighthouseScannerRuns(result = {}) {
  const errors = result.errors || {};
  const errorStatus = (e) => (e?.code === 'timeout' ? 'timeout' : 'error');
  const status = result.source === 'local-fallback'
    ? 'fallback'
    : result.source === 'error'
      ? errorStatus(Object.values(errors)[0])
      : 'complete';
  const devices = result.lighthouse
    ? Object.entries(result.lighthouse).filter(([, device]) => device)
    : [];
  if (devices.length === 0) {
    return [{
      layer: 'lighthouse',
      engine: { name: 'Lighthouse', version: 'unknown' },
      viewport: null,
      pageState: 'initial',
      status,
      source: result.source || 'error',
      provenance: result.provenance || null,
      evidence: { scores: result.scores || {}, fetchTime: null },
    }];
  }
  const failed = Object.entries(errors).filter(([name]) => !result.lighthouse?.[name]).map(([name, e]) => ({
    layer: 'lighthouse',
    engine: { name: 'Lighthouse', version: 'unknown' },
    viewport: { name, width: null, height: null },
    pageState: 'initial',
    status: errorStatus(e),
    source: result.source,
    provenance: result.provenance || null,
    evidence: { scores: {}, fetchTime: null, errorCode: e.code },
  }));
  return [...devices.map(([deviceName, device]) => ({
    layer: 'lighthouse',
    engine: { name: 'Lighthouse', version: device.engineVersion || 'unknown' },
    viewport: {
      name: device.device || deviceName,
      width: device.viewport?.width || null,
      height: device.viewport?.height || null,
    },
    pageState: 'initial',
    status: device.unscorable ? 'skipped' : status,
    source: result.source,
    provenance: result.provenance || null,
    evidence: {
      ...(device.unscorable ? { errorCode: 'unscorable' } : {}),
      scores: device.scores || {},
      fetchTime: device.fetchTime || null,
      accessibility: device.accessibility?.summary || null,
      deviceProvenance: device.provenance || null,
    },
  })), ...failed];
}

export function buildLighthouseScoreEntry(result = {}) {
  return {
    scores: result.scores || {},
    lighthouse: result.lighthouse || null,
    runSummary: summarizeLighthouseRuns(result.lighthouse),
    source: result.source || 'error',
    provenance: result.provenance || null,
  };
}

export function formatLighthouseSource(result = {}) {
  if (result.source === 'psi-api') return 'PSI API';
  const fallbackCode = result.provenance?.fallbackReason?.code || 'unavailable';
  if (result.source === 'local-fallback') {
    return `local fallback; not PSI-comparable (${fallbackCode})`;
  }
  if (
    result.source === 'error' &&
    result.provenance?.requestedSource === 'psi-api'
  ) {
    return `PSI unavailable; not PSI-comparable (${fallbackCode})`;
  }
  return result.source === 'error' ? 'unavailable' : 'local';
}

/** Identity of a finding for merging duplicates and for matching it across two runs of a layer. */
export function violationFingerprint(v) {
  const html = (v.element?.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const selector = (v.element?.selector || '').replace(/\s+/g, ' ').trim();
  if (v.layer === 'axe' && selector) {
    return `${v.ruleId}|${selector}|${html}`;
  }
  if (html.length >= 10) return `${v.ruleId}|${html}`;
  return `${v.ruleId}|${(v.fix?.hint || '').replace(/\s+/g, ' ').slice(0, 120)}`;
}

/** violationFingerprint with generated ids and hashed classes removed, to match a finding across two loads (el-popover-3850 vs el-popover-5016). */
export function reverifyKey(v) {
  const { element } = v;
  return violationFingerprint(element ? { ...v, element: { ...element, outerHTML: stableHtml(element.outerHTML || ''), selector: stableSelector(element.selector || '').selector } } : v);
}

export function deduplicateViolations(violations) {
  // Lighthouse accessibility findings duplicate axe's when rule and selector match: keep axe's.
  const norm = (v) => `${v.ruleId}|${(v.element?.selector || '').replace(/\s+/g, ' ').trim()}`;
  const axeKeys = new Set(violations.filter((v) => v.layer === 'axe' && v.element?.selector).map(norm));
  violations = violations.filter((v) => !(v.layer === 'lighthouse' && v.category === 'accessibility' && v.element?.selector && axeKeys.has(norm(v))));

  // Phase 1: Collapse identical violations (same rule + same HTML content).
  // Selector is excluded so mobile/desktop duplicates of the same element merge.
  const seen = new Map();
  const deduped = [];

  for (const v of violations) {
    const fp = violationFingerprint(v);
    if (seen.has(fp)) {
      seen.get(fp).count = (seen.get(fp).count || 1) + 1;
    } else {
      seen.set(fp, v);
      deduped.push(v);
    }
  }

  // Phase 2: Cross-scanner related — violations from different rules targeting the same element
  const elementKey = (v) => {
    const html = (v.element?.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return html.length >= 10 ? html : null;
  };

  const byElement = new Map();
  for (const v of deduped) {
    const ek = elementKey(v);
    if (!ek) continue;
    if (!byElement.has(ek)) byElement.set(ek, []);
    byElement.get(ek).push(v);
  }
  for (const group of byElement.values()) {
    if (group.length < 2) continue;
    for (const v of group) {
      v.related = group.filter((o) => o.ruleId !== v.ruleId).map((o) => o.ruleId);
    }
  }

  return deduped;
}

/**
 * Enriches violations with partial-level source tracing.
 *
 * Uses two strategies (in order):
 *  1. partial-file-search — substring match of outerHTML in dist/partials/*.html
 *  2. page-html-comment — scan:begin/end markers in the assembled dist page HTML
 *
 * Sets source.partial and source.page so the report can show
 * "src/pages/index.liquid -> src/partials/layout/header" breadcrumb.
 */
export async function traceToPartials(violations, pageUrl, localRoot = PROJECT_ROOT) {
  const project = resolveProject(loadConfig(), localRoot);
  if (!existsSync(project.manifestPath) && !existsSync(project.pagesDir)) return; // a plain (non-instrumented) build still has templates to trace

  let pageFile;
  try {
    const urlPath = new URL(pageUrl).pathname;
    pageFile = urlToPageFile(urlPath, { ...project, root: localRoot });
  } catch { return; }

  // A finding can only come from a template this page renders; look-alike markup in another page's partial is not a candidate.
  const universe = new Set(collectRenderTree(pageFile, undefined, localRoot));
  const scoped = universe.has(pageFile);
  const inUniverse = (file) => !scoped || !file || !/\.liquid$/.test(file) || universe.has(file);
  // A manifest owner is only a content match over every emitted partial, so a partial no page renders can win it. It is trusted outside the static tree only when a dynamic render name could hide it.
  const dynamicRender = scoped && [...universe].some((f) => { try { return /\{%-?\s*(?:render|include)\s+[^'"\s]/.test(readFileSync(path.join(localRoot, f), 'utf8')); } catch { return false; } });

  for (const v of violations) {
    const html = v.element?.outerHTML || '';
    // Third-party and platform markup has no site source to blame: it is never attributed to a template.
    if (v.origin && v.origin.owner !== 'site') continue;
    // A source the build itself proved (manifest/marker) stays even when a dynamic render name hides it from the static tree.
    if ((!OWNER_PROVEN_METHODS.has(v.source?.method) || (v.source.method === 'instrumentation-manifest' && !dynamicRender)) && !inUniverse(v.source?.file)) {
      v.source = { ...v.source, file: 'unknown', line: null, confidence: 'none', method: 'unresolved', partial: undefined, preimageSha256: null, preimageRange: null };
    }
    if (html.length < 10) {
      if (!v.source.file || v.source.file === 'unknown') {
        v.source.file = pageFile;
        v.source.page = pageFile;
        v.source.confidence = v.source.confidence || 'low';
        v.source.method = v.source.method || 'url-fallback';
      }
      continue;
    }

    const currentFile = v.source?.file;
    if (currentFile?.startsWith('src/partials/')) {
      v.source.partial = currentFile;
      v.source.page = pageFile;
      if (!v.source.preimageSha256) {
        const preimage = computeSourcePreimage(currentFile, v.source.line, localRoot);
        if (preimage) {
          v.source.preimageSha256 = preimage.preimageSha256;
          v.source.preimageRange = preimage.range;
        }
      }
      continue;
    }

    try {
      const traced = await mapViolationToSource({ html }, pageUrl);
      if (traced?.file?.startsWith('src/partials/') && inUniverse(traced.file)) {
        v.source.partial = traced.file;
        v.source.page = pageFile;
        v.source.file = traced.file;
        if (traced.line) v.source.line = traced.line;
        v.source.confidence = traced.confidence;
        v.source.method = traced.method;
        v.source.preimageSha256 = traced.preimageSha256 || null;
        v.source.preimageRange = traced.preimageRange || null;
      } else {
        // Head-level elements (<meta>, <link>, <script>) live in head.liquid or scripts.liquid
        const isHeadTag = /^<(meta|link)\b/i.test(html);
        const isScriptTag = /^<script\b/i.test(html);
        if (isHeadTag || isScriptTag) {
          const headPartials = isScriptTag
            ? ['src/partials/layout/scripts.liquid', 'src/partials/layout/head.liquid']
            : ['src/partials/layout/head.liquid'];
          for (const partial of headPartials) {
            const fullPath = path.join(localRoot, partial);
            if (!existsSync(fullPath) || !inUniverse(partial)) continue;
            const content = readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            const attrMatch = html.match(/(?:name|property|content|rel|href|src)="([^"]+)"/);
            const searchStr = attrMatch?.[1];
            if (searchStr && searchStr.length >= 3) {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(searchStr)) {
                  v.source.partial = partial;
                  v.source.page = pageFile;
                  v.source.file = partial;
                  v.source.line = i + 1;
                  v.source.confidence = 'medium';
                  v.source.method = 'source-attribute-search';
                  const preimage = computeSourcePreimage(partial, i + 1, localRoot);
                  if (preimage) {
                    v.source.preimageSha256 = preimage.preimageSha256;
                    v.source.preimageRange = preimage.range;
                  }
                  break;
                }
              }
            }
            if (v.source.partial) break;
          }
          if (v.source.partial) {
            v.source.page = pageFile;
            if (!v.source.file || v.source.file === 'unknown') v.source.file = pageFile;
            continue;
          }
        }

        // The structural tracer first: it needs the tag, its attributes and the page's render set to agree, which a bare
        // class/text hint does not (look-alike markup in another partial). Several survivors are listed, never picked.
        if (pageFile && adoptStructuralTrace(v, pageFile, localRoot, hostOf(pageUrl))) continue;

        const idMatch = html.match(/id="([^"]+)"/);
        const classStr = (html.match(/class="([^"]+)"/) || [])[1] || '';
        const uniqueClasses = classStr.split(/\s+/).filter(c =>
          c.length > 4 && !c.startsWith('text-') && !c.startsWith('p-') && !c.includes(':')
        );
        const ariaLabel = (html.match(/aria-label="([^"]+)"/) || [])[1];
        const href = (html.match(/href="([^"]{5,})"/) || [])[1];
        const hints = [
          idMatch ? `id="${idMatch[1]}"` : null, // the line that defines the id, not the first line that merely references it
          idMatch?.[1],
          ariaLabel,
          uniqueClasses.length >= 2 ? uniqueClasses.slice(0, 2).join(' ') : null,
          ...uniqueClasses,
          href && !href.startsWith('#') && !href.startsWith('http') ? href : null,
        ].filter(Boolean);
        const searchDirs = [
          path.join(localRoot, 'src', 'partials'),
          path.join(localRoot, 'src', 'pages'),
          path.join(localRoot, 'src', 'components'),
        ];
        let found = false;
        for (const hint of hints) {
          for (const srcDir of searchDirs) {
            if (!existsSync(srcDir)) continue;
            const matched = findInLiquidSource(srcDir, hint, localRoot, scoped ? universe : null);
            if (matched) {
              v.source.partial = matched.file;
              v.source.page = pageFile;
              v.source.file = matched.file;
              if (matched.line) v.source.line = matched.line;
              v.source.confidence = 'medium';
              v.source.method = 'source-hint-search';
              const preimage = computeSourcePreimage(matched.file, matched.line, localRoot);
              if (preimage) {
                v.source.preimageSha256 = preimage.preimageSha256;
                v.source.preimageRange = preimage.range;
              }
              found = true;
              break;
            }
          }
          if (found) break;
        }
        // Translated text (`_translate("...")` in the template, another language live) matches no hint above: the element's tag and its
        // absolute href are authored in the template whatever language it renders in, so locale routes resolve like the root route.
        if (!found && href && /^https?:/i.test(href)) {
          const tag = html.match(/^\s*<([a-z][\w-]*)/i)?.[1];
          const hits = tag ? searchDirs.flatMap((dir) => (existsSync(dir) ? findAllInLiquidSource(dir, href, localRoot, scoped ? universe : null, (line) => new RegExp(`<${tag}\\b`, 'i').test(line)) : [])) : [];
          if (hits.length) {
            const hit = hits[0];
            v.source.partial = hit.file;
            v.source.page = pageFile;
            v.source.file = hit.file;
            // Several lines carry the same href: the file is right, the line is not decided.
            v.source.line = hits.length === 1 ? hit.line : null;
            v.source.confidence = hits.length === 1 ? 'medium' : 'low';
            v.source.method = 'source-href-search';
            const preimage = hits.length === 1 ? computeSourcePreimage(hit.file, hit.line, localRoot) : null;
            v.source.preimageSha256 = preimage?.preimageSha256 || null;
            v.source.preimageRange = preimage?.range || null;
          }
        }
        if (!v.source.file || v.source.file === 'unknown') {
          v.source.file = pageFile;
          v.source.confidence = v.source.confidence || 'low';
          v.source.method = v.source.method || 'url-fallback';
        }
        v.source.page = pageFile;
      }
    } catch { /* tracing is best-effort */ }
  }

  resolveMissingLines(violations, pageFile, localRoot);
  attachDataSources(violations, scoped ? [...universe] : [pageFile], localRoot);
  attachDuplicateIdSources(violations, localRoot);
  attachCauses(violations, pageFile, localRoot);
  attachBehaviorScripts(violations, pageFile, localRoot);
  unboundFromSource(violations, localRoot);
  attachSiteFix(violations, localRoot);
  markWidgetSnapshots(violations, localRoot);
  attachStackingSources(violations, localRoot);
}

const OBSCURED_RULE = /FocusNotObscured|StickyHeaderObscuresFocus|focus-obscured/i;
/** A focused control covered by a sticky bar although its own rule sets a z-index: the stacking rule is the fix, the markup stays as `markupFile`. */
function attachStackingSources(violations, root) {
  for (const v of violations) {
    if (!OBSCURED_RULE.test(v.ruleId || v.rule || v.nativeRuleId || '') || (v.origin && v.origin.owner !== 'site') || !v.source?.file) continue;
    const rule = stackingDeclaration(v.element?.outerHTML, root);
    if (!rule) continue;
    const pre = computeSourcePreimage(rule.file, rule.line, root);
    v.source = {
      ...v.source,
      markupFile: v.source.file !== 'unknown' ? v.source.file : undefined,
      markupLine: v.source.line || undefined,
      file: rule.file, line: rule.line, confidence: 'medium', method: 'css-rule', cssSelector: rule.selector,
      partial: undefined, preimageSha256: pre?.preimageSha256 || null, preimageRange: pre?.range || null,
    };
  }
}

/** A site-owned finding whose traced line holds a widget's rendered snapshot is the platform's markup: never confirmed, no template source. */
function markWidgetSnapshots(violations, root) {
  for (const v of violations) {
    if (v.origin?.owner !== 'site' || v.origin.kind !== 'site-source' || !v.source?.line || !v.source.file?.endsWith('.liquid')) continue;
    const widget = widgetSnapshotAt(v.source.file, v.source.line, v.element?.outerHTML, root);
    if (widget !== null) v.origin = widgetSnapshotOrigin(widget);
  }
}

const textOf = (v) => `${JSON.stringify(v.evidence || {})} ${v.fix?.hint || ''} ${v.message || ''}`;

/**
 * Source of an element via traceElement, narrowed by what the live element and the finding prove. Returns true when the
 * finding was settled (a located source, or a candidate list that must not be overwritten by a guess).
 */
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return undefined; } };
function adoptStructuralTrace(v, pageFile, root, devHost) {
  const html = v.element?.outerHTML || '';
  const result = traceElement({ outerHTML: html, selector: v.element?.selector, mode: 'local', pageFile, ruleId: v.rule || v.ruleId, root, devHost });
  // Markup that exists only inside an HTML comment is not the live element: the hint search decides those.
  const live = result.candidates.filter((c) => !inHtmlComment(c.file, c.line, root));
  if (!live.length) return false;
  result.candidates = live;
  if (live.length === 1 && result.confidence === 'ambiguous') result.confidence = 'medium';
  let { candidates } = result;
  if (result.confidence === 'high' || result.confidence === 'medium') {
    const fields = traceToSourceFields(result, root);
    v.source = { ...v.source, ...fields.source, partial: fields.source.file?.startsWith('src/partials/') ? fields.source.file : undefined, page: pageFile };
    if (fields.sourceCandidates.length) v.sourceCandidates = fields.sourceCandidates;
    return true;
  }
  if (result.confidence !== 'ambiguous') return false;
  const top = Math.max(...candidates.map((c) => c.score ?? 0));
  candidates = candidates.filter((c) => (c.score ?? 0) === top);
  candidates = dropContradicted(candidates, html, root, v.rule || v.ruleId);
  candidates = narrowByOwnText(candidates, html, root);
  const { bg } = contrastTokens(html, textOf(v), root);
  // The level-aware chain first (it sees every class of every level); the looser any-ancestor token score only breaks what is left.
  candidates = narrowBySelectorChain(candidates, v.element?.selector, root, html);
  candidates = narrowByAncestry(candidates, v.element?.selector, root, bg.map((t) => `bg-${t.token}`));
  if (candidates.length === 1) {
    const fields = traceToSourceFields({ confidence: 'medium', candidates, reason: null }, root);
    v.source = { ...v.source, ...fields.source, method: 'liquid-tag-index+ancestry', partial: fields.source.file?.startsWith('src/partials/') ? fields.source.file : undefined, page: pageFile };
    return true;
  }
  const fields = traceToSourceFields({ confidence: 'ambiguous', candidates, reason: 'multiple-candidates' }, root);
  v.sourceCandidates = fields.sourceCandidates;
  // Every candidate in one file: that file is certain, its first line is the lead (low), never an empty line.
  const sameFile = candidates.every((c) => c.file === candidates[0].file);
  v.source = { ...v.source, file: sameFile ? candidates[0].file : pageFile, line: sameFile ? candidates[0].line : null, confidence: 'low', method: sameFile ? 'liquid-tag-index' : 'url-fallback', traceConfidence: 'ambiguous', traceReason: 'multiple-candidates', page: pageFile };
  return true;
}

/**
 * Causes outside the markup. A role/aria attribute the page's templates never write but a project script sets is fixed in that
 * script (the markup stays as `templateSource`); a colour that comes from a CSS token names the line declaring it.
 */
function attachCauses(violations, pageFile, root) {
  const files = renderTreeFiles(pageFile, root);
  for (const v of violations) {
    const html = v.element?.outerHTML || '';
    if (!v.source || !html || (v.origin && v.origin.owner !== 'site')) continue;
    const tagName = /^\s*<([a-z][\w-]*)/i.exec(html)?.[1]?.toLowerCase();
    const setter = tagName && findScriptSetter(v.ruleId || v.rule, html, v.element?.selector, (n, val) => markupWrites(files, tagName, n, val, root), root);
    let written = setter ? null : findAttributeWriter({ html, selector: v.element?.selector, ruleId: v.ruleId || v.rule, layer: v.layer }, files, root);
    // An attribute value the page's own templates already write is fixed in the template, whatever a script also does.
    if (written && tagName && markupWrites(files, tagName, written.attr, written.value, root)) written = null;
    if (setter || written) {
      const w = setter || written;
      const prefix = /class="([^"\s]+)/.exec(html)?.[1]?.replace(/\.\.\.$/, '');
      const markup = written ? [] : prefix ? findTagsContaining(pageFile, tagName, prefix, root) : [];
      v.source = {
        ...v.source,
        templateSource: written ? written.templateSource || (VALUE_WRITES.has(written.attr) && v.source.file && v.source.line ? { file: v.source.file, line: v.source.line } : null) : markup.length === 1 ? markup[0] : null,
        file: w.file,
        line: w.line,
        confidence: w.ambiguous ? 'low' : 'medium',
        method: 'script-sets-attribute',
        scriptAttribute: `${w.attr}="${w.value}"`,
        partial: undefined,
        preimageSha256: null,
        preimageRange: null,
      };
      const pre = computeSourcePreimage(w.file, w.line, root);
      if (pre) { v.source.preimageSha256 = pre.preimageSha256; v.source.preimageRange = pre.range; }
      if (w.candidates.length) v.sourceCandidates = w.candidates.map((c) => ({ ...c, confidence: 'low', method: 'script-sets-attribute' }));
      continue;
    }
    if (/color-contrast/i.test(v.ruleId || v.rule || '')) {
      if (applyColorOrigin(v, root)) continue;
      const text = textOf(v);
      const { fg, bg } = contrastTokens(html, text, root);
      const found = [];
      if (fg) found.push({ file: fg.file, line: fg.line, token: `--color-${fg.token}` });
      const fgHex = contrastColors(text).fg;
      if (!fg && fgHex) found.push(...colorDeclarations(html, fgHex, root).slice(0, 2).map((d) => ({ file: d.file, line: d.line, token: d.selector })));
      // The background token counts when the template that authors the element names it (`bg-blue-300`).
      let own = '';
      try { own = v.source.file ? readFileSync(path.join(root, v.source.file), 'utf8') : ''; } catch { /* unreadable */ }
      for (const t of bg) if (own.includes(`bg-${t.token}`)) found.push({ file: t.file, line: t.line, token: `--color-${t.token}` });
      // The colour is declared by one authored rule that names the element's own class (`.c-language a.selected`) and no utility or token on the element carries it: that rule is where the fix goes.
      const rules = !fg && fgHex ? colorDeclarations(html, fgHex, root).filter((d) => !/:(?:hover|focus|active|visited)|::/.test(d.selector)) : [];
      if (rules.length === 1) {
        const pre = computeSourcePreimage(rules[0].file, rules[0].line, root);
        v.source = {
          ...v.source,
          markupFile: v.source.file && v.source.file !== 'unknown' ? v.source.file : undefined,
          markupLine: v.source.line || undefined,
          file: rules[0].file, line: rules[0].line, confidence: 'medium', method: 'css-rule', cssSelector: rules[0].selector,
          partial: undefined, preimageSha256: pre?.preimageSha256 || null, preimageRange: pre?.range || null,
        };
        continue;
      }
      if (!found.length) continue;
      v.source = { ...v.source, tokenSource: found[0] };
      v.sourceCandidates = [...(v.sourceCandidates || []), ...found.map((f) => ({ file: f.file, line: f.line, confidence: 'low', method: 'css-token' }))];
    }
  }
}

/**
 * A behaviour finding (Escape does not dismiss, focus lost, tabindex -1 never restored, no focus trap, role=button without a key handler) is
 * fixed in the script that opens / traps / mutates the element. The template line that renders the trigger moves to `alsoLikelyIn`.
 */
export function attachBehaviorScripts(violations, pageFile, root) {
  let files = null;
  for (const v of violations) {
    const html = v.element?.outerHTML || '';
    // A finding known only by its selector reads its identifying ids from the traced template excerpt (the snippet is stored later in the pipeline).
    const snippet = v.source?.snippet || (!html && v.source?.file && v.source?.line ? snippetAround(v.source.file, v.source.line, root) : null);
    if (!v.source || (!html && !snippet) || v.source.method === 'script-sets-attribute' || v.source.method === 'script-behavior' || v.source.method === 'component-markup' || (v.origin && v.origin.owner !== 'site')) continue;
    files = files || renderTreeFiles(pageFile, root);
    const b = findBehaviorScript({ ruleId: v.ruleId || v.rule, html, selector: v.element?.selector, snippet }, files, root);
    if (!b) continue;
    const prior = v.source.file && v.source.file !== 'unknown' ? { file: v.source.file, line: v.source.line ?? null } : null;
    const dedupe = (list) => (list.length ? [...new Map(list.map((x) => [`${x.file}:${x.line}`, x])).values()] : undefined);
    const script = { file: b.file, line: b.line };
    // A script that only ties to the element across function scopes, or ties to it as often as another handler, is a lead, not the cause:
    // the template line stays the source and the script is listed low.
    if ((b.weak || b.ambiguous) && prior) {
      const also = [...(v.source.alsoLikelyIn || []), { ...script, confidence: 'low', method: 'script-behavior' }].filter((x) => !(x.file === prior.file && x.line === prior.line));
      v.source = { ...v.source, alsoLikelyIn: dedupe(also) };
      continue;
    }
    // The markup behind a role is authored in a shared component the template only calls: the component line is the fix, the script a workaround.
    // Only the component the traced template line renders: a look-alike component elsewhere in the render tree is not the element's markup.
    const rendersComponent = (m) => {
      if (!prior?.line) return false;
      if (prior.file === m.file) return true; // the element was traced into the component itself
      let line = '';
      try { line = readFileSync(path.join(root, prior.file), 'utf8').split('\n')[prior.line - 1] || ''; } catch { return false; }
      const name = m.file.replace(/^src\/components\//, '').replace(/\.liquid$/, '');
      return new RegExp(`\\brender\\s+["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(line);
    };
    const owner = b.markup?.file.startsWith('src/components/') && rendersComponent(b.markup) ? b.markup : null;
    const primary = owner || script;
    const also = [owner ? { ...script, confidence: 'low', method: 'script-behavior' } : b.markup, prior].filter((x) => x && !(x.file === primary.file && x.line === primary.line));
    v.source = {
      ...v.source,
      file: primary.file,
      line: primary.line,
      confidence: b.weak || b.ambiguous ? 'low' : 'medium',
      method: owner ? 'component-markup' : 'script-behavior',
      alsoLikelyIn: dedupe(also),
      templateSource: prior || undefined,
      partial: undefined,
      preimageSha256: null,
      preimageRange: null,
    };
    const pre = computeSourcePreimage(primary.file, primary.line, root);
    if (pre) { v.source.preimageSha256 = pre.preimageSha256; v.source.preimageRange = pre.range; }
    if (!owner && b.candidates.length) v.sourceCandidates = b.candidates.map((c) => ({ ...c, confidence: 'low', method: 'script-behavior' }));
  }
}

/** Where the data behind a link / text / image is authored (`source.dataFile` / `dataLine`): the traced template's sidecar first, then the rest of the page's render. */
function attachDataSources(violations, files, localRoot) {
  for (const v of violations) {
    const html = v.element?.outerHTML;
    if (!html || !v.source) continue;
    const own = v.source.file && files.includes(v.source.file) ? [v.source.file] : [];
    const isLink = v.layer === 'links' || Boolean(v.linkTarget);
    if (isLink && v.source.templateSource) continue; // already re-pointed
    const rest = files.filter((f) => !own.includes(f));
    const found = findDataSource(own, html, localRoot) || (isLink ? null : findDataSource(rest, html, localRoot));
    if (found) { Object.assign(v.source, found); if (isLink) repointToData(v, found, localRoot); continue; }
    if (!isLink) continue;
    // The traced template has no sidecar hit: the page's other sidecars decide, but only a unique hit is trusted.
    const all = findAllDataSources(rest, html, localRoot);
    if (all.length === 1) { Object.assign(v.source, all[0]); repointToData(v, all[0], localRoot); }
    else if (all.length > 1) v.source.dataAmbiguous = all.map((a) => `${a.dataFile}:${a.dataLine}`);
  }
}

/** A link's href is authored in the sidecar: that line is the primary source; the template line stays as `templateSource`. */
function repointToData(v, { dataFile, dataLine }, localRoot) {
  const s = v.source;
  if (s.file) s.templateSource = { file: s.file, line: s.line ?? null };
  s.file = dataFile;
  s.line = dataLine;
  s.method = 'data-sidecar';
  const preimage = computeSourcePreimage(dataFile, dataLine, localRoot);
  s.preimageSha256 = preimage?.preimageSha256 || null;
  s.preimageRange = preimage?.range || null;
}

const OWNER_PROVEN_METHODS = new Set(['instrumentation-manifest', 'page-html-comment', 'pdk-partial-boundary', 'pdk-render-boundary']);

/**
 * Fill in `source.line` for anything the HTML-search strategies left without
 * one. Those strategies compare rendered output against source text, which
 * fails on the three shapes this codebase is full of: a component invoked
 * through `{% render %}` (the markup is in another file), a document-level
 * element that lives in the layout rather than the page, and a finding that
 * reports something missing and so has no element at all.
 */
export function resolveMissingLines(violations, pageFile, localRoot = PROJECT_ROOT) {
  for (const v of violations) {
    if (!v.source) continue;
    // A line with no method behind it came from the bare substring search, so
    // it lands on whichever attribute line happened to match rather than on the
    // tag itself — the reporter labels these 'legacy-source-attribution'. Re-run
    // the structural resolver over those too and keep its answer when it hits.
    const legacy = !v.source.method || v.source.method === 'legacy-source-attribution';
    const hadLine = Boolean(v.source.line);
    // A structural finding belongs to the page file even when a legacy line pointed into the layout.
    const structural = isPageStructureRule(v.rule || v.ruleId || v.nativeRuleId || v.id) && v.source.file !== pageFile && pageFile;
    if (hadLine && !legacy && !structural) continue;
    // Candidates already narrowed by ancestry / attributes stay: a re-trace would list the unnarrowed set again.
    if (!hadLine && v.source.traceReason === 'multiple-candidates' && v.sourceCandidates?.length) continue;
    const currentFile = v.source.file && v.source.file !== 'unknown' ? v.source.file : pageFile;
    const result = traceElement({
      outerHTML: v.element?.outerHTML || '',
      selector: v.element?.selector,
      mode: 'local',
      pageFile,
      // Only an owner proven by the build (manifest / marker) counts as marker evidence.
      ownerFile: OWNER_PROVEN_METHODS.has(v.source.method) ? currentFile : null,
      ruleId: v.rule || v.ruleId || v.nativeRuleId || v.id,
      root: localRoot,
    });
    const traced = traceToSourceFields(result, localRoot);
    if (result.confidence === 'ambiguous') {
      // Several equally good places: list them, never pick one.
      v.sourceCandidates = traced.sourceCandidates;
      v.source.traceConfidence = result.confidence;
      v.source.traceReason = result.reason;
      continue;
    }
    if (result.confidence === 'untraceable' || (result.confidence === 'low' && hadLine && !structural)) {
      // A page-level anchor is weaker than a legacy line, so it only fills findings that have no line at all.
      if (!hadLine) { v.source.traceConfidence = result.confidence; v.source.traceReason = result.reason; }
      continue;
    }

    const file = traced.source.file;
    v.source.file = file;
    v.source.line = traced.source.line;
    v.source.method = traced.source.method;
    v.source.traceConfidence = result.confidence;
    v.source.traceReason = null;
    // Other places that write the same defect (a second unlabelled <nav>) stay listed behind the primary.
    if (traced.sourceCandidates.length) v.sourceCandidates = traced.sourceCandidates;
    // traceElement is the authority: a legacy `high` on the old line does not survive a re-trace to a weaker one.
    v.source.confidence = result.confidence;
    if (file.startsWith('src/partials/')) {
      v.source.partial = file;
      v.source.page = pageFile;
    }
    // The old preimage belongs to the old line: replace it, or drop it when the new line has none.
    v.source.preimageSha256 = traced.source.preimageSha256 || null;
    v.source.preimageRange = traced.source.preimageRange || null;
  }
}

// ─── Trusted fix routing ─────────────────────────────────────────────────────

async function runTrustedFixFromReport(report, options = {}) {
  const localRoot = options.localRoot || null;
  const loaded = localRoot ? loadTrustedLocalAttestation(localRoot) : { ok: false };
  const target = report?.target || {};

  const plan = planCisFixRoute({
    fix: true,
    fixMode: 'cis',
    targetMode: target.mode || null,
    url: options.url || target.url || null,
    localRoot,
    remoteRevision: target.buildRevision || null,
    remoteInstrumentationDigest: target.instrumentationDigest || null,
    localRevision: loaded.ok ? loaded.attestation.buildRevision : null,
    localInstrumentationDigest: loaded.ok ? loaded.attestation.instrumentationDigest : null,
    remoteDeploymentUrl: target.deploymentUrl || null,
    localDeploymentUrl: loaded.ok ? loaded.attestation.deploymentUrl : null,
    attestationStatus: target.attestationStatus || null,
    attestationReason: target.attestationReason || null,
    fromFixSubcommand: options.fromFixSubcommand || false,
  });

  if (plan.kind !== 'trusted-controller') {
    let reason = plan.capability.reason || target.attestationReason || null;
    if (
      localRoot
      && !loaded.ok
      && requiresHybridAttestation({ targetMode: target.mode, url: target.url, localRoot })
    ) {
      reason = loaded.reason || 'LOCAL_ATTESTATION_MISSING';
    }
    console.log(`Fix unavailable (${plan.capability.mode}): ${reason}`);
    return { status: 'scan-only', capability: { ...plan.capability, reason } };
  }

  const { runTrustedFixCli } = await import('./fix/controller/index.js');
  return runTrustedFixCli({
    report,
    localRoot: plan.localRoot,
    sessionId: options.sessionId || null,
    useUI: options.useUI || false,
  });
}

export function parseSessionIdArg(rawArgs = []) {
  const sessionIdx = rawArgs.indexOf('--session');
  if (sessionIdx === -1) return null;
  const sessionId = rawArgs[sessionIdx + 1];
  if (!sessionId || sessionId.startsWith('--')) {
    throw new FixControllerError('INVALID_SESSION_ID', '--session requires a session ID.');
  }
  return sessionId;
}

export function parseRequiredFlagValue(rawArgs = [], flag, code, message) {
  const index = rawArgs.indexOf(flag);
  if (index === -1) return null;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new FixControllerError(code, message);
  }
  return value;
}

export async function runDemoSubcommand(rawArgs = []) {
  const file = parseRequiredFlagValue(
    rawArgs,
    '--file',
    'DEMO_FILE_REQUIRED',
    '--file requires a relative source file path.',
  );
  if (!file) {
    throw new FixControllerError('DEMO_FILE_REQUIRED', '--file is required for demo mode.');
  }

  const source = parseRequiredFlagValue(
    rawArgs,
    '--source',
    'DEMO_SOURCE_REQUIRED',
    '--source requires a project root path.',
  ) || PROJECT_ROOT;

  const route = parseRequiredFlagValue(
    rawArgs,
    '--route',
    'DEMO_ROUTE_REQUIRED',
    '--route requires a page route.',
  ) || '/';

  const session = parseRequiredFlagValue(
    rawArgs,
    '--session',
    'INVALID_SESSION_ID',
    '--session requires a session ID.',
  );
  const useUI = new Set(rawArgs).has('--ui');
  const { runCisDemo, generateDefaultDemoSessionId } = await import('./fix/demo/orchestrator.js');

  return runCisDemo({
    originalRoot: source,
    targetFile: file,
    sessionId: session || generateDefaultDemoSessionId(),
    route,
    useUI,
  });
}

/** --out-dir wins over config.reportsDir; unset keeps the .ada-scan/ default. */
function applyReportsDir(outDir, config) {
  setReportsDir(outDir || config.reportsDir);
}

const HARNESS_FIXERS = ['recipes', 'cis', 'external', 'working-tree'];

/** ada-scan fix --harness: tasks from the report, a fixer adapter, the gate harness on a shadow copy. Local source tree and an explicit build config only. */
async function runHarnessFromReport(report, { localRoot, v, harnessConfig = {} }) {
  const fromTree = Boolean(v['from-working-tree']);
  if (fromTree && v.fixer && v.fixer !== 'working-tree') throw new CliError('--from-working-tree uses its own fixer; drop --fixer.');
  const fixerName = fromTree ? 'working-tree' : (v.fixer ?? 'recipes');
  if (!HARNESS_FIXERS.includes(fixerName)) throw new CliError(`--fixer must be one of ${HARNESS_FIXERS.join(', ')}.`);
  if (v['max-repairs'] !== undefined && !/^\d+$/.test(v['max-repairs'])) throw new CliError('--max-repairs must be a whole number.');
  const rootCheck = resolveTrustedRoot(localRoot);
  if (report?.target?.mode === 'url-only' || !rootCheck.ok) {
    console.log('Fix unavailable (scan-only): the harness needs a local source tree and a build config; URL-only scans stay scan-only.');
    return { status: 'scan-only' };
  }
  const { runHarness, loadHarnessConfig, createLighthousePerfRunner } = await import('./fix/harness/index.js');
  const { normalizeTask } = await import('./fix/harness/runner.js');
  const hc = loadHarnessConfig(rootCheck.localRoot);
  let fixers;
  try { fixers = await import('./fix/harness/fixers/index.js'); } catch { throw new CliError(`Fixer "${fixerName}" is not available in this build (src/fix/harness/fixers is missing).`); }
  const fixer = await fixers.createFixer(fixerName, { localRoot: rootCheck.localRoot, report });
  const set = buildTaskSet(report, { sourceRoot: rootCheck.localRoot });
  let tasks = set.tasks;
  // Working-tree flow: an editor agent (Cursor chat, Claude Code) already edited the project. The shadow starts from HEAD text for every
  // changed file, the harness replays each task's hunks on it and gates them; nothing is written back (the edits are already in the tree).
  let baselineOverride;
  if (fromTree) {
    // The fixer decides ownership from the same normalised tasks the runner builds (allowlist, element), then moves each task onto its own hunk.
    fixer.setTasks(set.tasks.map((t) => normalizeTask(t, { allowRadius: hc.allowRadius })));
    tasks = fixer.retarget(set.tasks);
    const { execFileSync } = await import('node:child_process');
    const git = (...a) => execFileSync('git', ['-C', rootCheck.localRoot, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    baselineOverride = new Map();
    for (const rel of fixer.changedPaths()) { try { baselineOverride.set(rel, git('show', `HEAD:${rel}`)); } catch { baselineOverride.set(rel, null); } }
    if (!baselineOverride.size) { console.log('No uncommitted changes found (git diff HEAD is empty): nothing to verify.'); return { status: 'nothing-to-verify' }; }
  }
  const runDir = path.join(getReportsDir(), 'harness', new Date().toISOString().replace(/[:.]/g, '-'));
  const { withQuietConsole } = await import('./fix/harness/quiet.js');
  const stdoutLog = path.join(runDir, 'harness-stdout.log');
  const result = await withQuietConsole(stdoutLog, (say) => runHarness({
    projectDir: rootCheck.localRoot, tasks, fixer,
    config: {
      ...hc, runDir, dryRun: fromTree || Boolean(v['dry-run']), ...(baselineOverride ? { baselineOverride, workingTree: { unassigned: () => fixer.unassigned() } } : {}), report, notActionable: set.notActionable, log: (m) => say(`  ${m}`),
      ...(v['max-repairs'] !== undefined ? { maxRepairs: Number(v['max-repairs']) } : {}),
      ...(hc.lighthouse === false || hc.perfRuns === 0 ? {} : { perfRunner: createLighthousePerfRunner() }),
      ...harnessConfig,
    },
  }), { verbose: Boolean(process.env.ADA_SCAN_VERBOSE) });
  for (const r of result.table) console.log(`${r.outcome.padEnd(11)} ${r.rule} ${r.file ?? ''}${r.failedGates.length ? ` [${r.failedGates.join(',')}]` : ''}`);
  console.log(`Harness ${result.status}: ${result.accepted.length} accepted, ${result.queued.length} queued for review, scan delta ${result.scanDelta.fixed} fixed / ${result.scanDelta.added} new${result.dryRun ? ' (dry run, nothing written to the project)' : `; apply: ${result.applyStatus}`}`);
  if (result.environment?.class === 'baseline-incomplete') console.log(`Stopped before any task: the baseline snapshot was truncated (environment, not a candidate failure). Raise "snapshotBudgetMs" in the "harness" block of .scan-config.json (now ${result.environment.snapshotBudgetMs} ms) and run again.`);
  console.log(`Reports: ${result.files.reportMarkdown} and ${result.files.remainingMarkdown}`);
  if (!process.env.ADA_SCAN_VERBOSE && existsSync(stdoutLog)) console.log(`Site server output (file watcher, HMR) went to ${stdoutLog}; set ADA_SCAN_VERBOSE=1 to print it.`);
  if (fromTree) {
    const un = fixer.unassigned();
    console.log('From the working tree: always a dry run. Your edits stay in the working tree (nothing was written or reverted); the harness replayed each task\'s hunks on a shadow copy of HEAD and ran the gates there.');
    if (un.length) console.log(`${un.length} changed hunk(s) belong to no scanned task (not verified, listed in the report): ${un.slice(0, 8).map((u) => `${u.path}:${u.line ?? ''}`).join(', ')}${un.length > 8 ? ', ...' : ''}`);
    result.unassigned = un;
  }
  return result;
}

/** `harnessConfig` is a test seam: harness config keys that cannot come from .scan-config.json (a scanner function, viewports). */
export async function runFixSubcommand(rawArgs = [], { harnessConfig } = {}) {
  const v = parseCliArgs(rawArgs, FIX_OPTIONS);
  if (v.help) {
    console.log(USAGE);
    return;
  }
  const localRoot = v.source ?? PROJECT_ROOT;
  // The config of the project being fixed, not of the cwd: --source may point elsewhere.
  applyReportsDir(v['out-dir'], loadConfig(v.source ? path.resolve(v.source) : undefined));
  setThirdPartyConfigRoot(v.source ? path.resolve(v.source) : undefined);
  const sessionId = v.session ?? null;
  const useUI = Boolean(v.ui);
  const modeError = fixModeError(v['fix-mode']);
  if (modeError) throw new CliError(modeError);

  if (v.verify) {
    if (v.export || v['fix-mode'] !== undefined || useUI || sessionId) throw new CliError('--verify cannot be combined with --export, --fix-mode, --ui or --session.');
    return runFixVerify(v, localRoot);
  }
  // Resolved only here: `--verify` reads the export (--out-dir) or --baseline, never latest.json, and must not fall back to a legacy scan-reports/ of the cwd project.
  const reportPath = v.report ?? resolveReportFile('latest.json');
  if (!existsSync(reportPath)) {
    throw new FixControllerError('REPORT_NOT_FOUND', `Report not found: ${reportPath}`);
  }

  const { report, error: reportError } = readReportFile(reportPath);
  if (reportError) throw new FixControllerError('REPORT_INVALID', `Invalid report: ${reportError}`);
  if (v.harness) {
    if (v['fix-mode'] !== undefined || v.export || useUI || sessionId) throw new CliError('--harness cannot be combined with --fix-mode, --export, --ui or --session.');
    return runHarnessFromReport(report, { localRoot, v, harnessConfig });
  }
  if (v.fixer !== undefined || v['max-repairs'] !== undefined) throw new CliError('--fixer and --max-repairs need --harness.');
  if (v.export && v['fix-mode'] !== undefined) throw new CliError('--export cannot be combined with --fix-mode.');
  if (v['fix-mode'] === undefined) {
    if (useUI || sessionId) throw new CliError(`${useUI ? '--ui' : '--session'} needs the trusted pipeline: add --fix-mode cis (plain "fix" exports a task set).`);
    if (v.severity !== undefined && !IMPACT_ORDER.includes(v.severity)) throw new CliError(`--severity must be one of ${IMPACT_ORDER.join(', ')}.`);
    if (v.max !== undefined && !/^\d+$/.test(v.max)) throw new CliError('--max must be a whole number.');
    const set = buildTaskSet(report, { severity: v.severity, rule: v.rule, page: v.page, max: v.max === undefined ? undefined : Number(v.max), includeNeedsReview: v['include-needs-review'], sourceRoot: localRoot });
    const target = v.target ?? 'generic';
    if (!TARGETS.includes(target)) throw new CliError(`--target must be one of ${TARGETS.join(', ')}.`);
    const dryRun = Boolean(v['dry-run']);
    const tasksDir = path.join(getReportsDir(), 'tasks');
    const rel = path.relative(path.resolve(localRoot), tasksDir);
    const rules = exportRules(target, path.resolve(localRoot), {
      tasksDir: (rel.startsWith('..') || path.isAbsolute(rel) ? tasksDir : rel).split(path.sep).join('/'),
      url: report.target?.url, dryRun, fallback: path.join(getReportsDir(), 'ada-scan-rules.md'),
      // The export lives in --out-dir: a plain `fix --verify` looks in the default folder and finds nothing.
      verifyFlags: v['out-dir'] ? ` --out-dir ${JSON.stringify(v['out-dir'])}` : '',
    });
    const skill = installSkill(target, path.resolve(localRoot), { dryRun });
    if (dryRun) {
      console.log(`Dry run: would write ${set.tasks.length} task(s) and INDEX.md to ${tasksDir}`);
      if (skill) console.log(`Dry run: would install the fix skill to ${skill.dir} (${skill.created.length} new, ${skill.updated.length} updated, ${skill.removed.length} removed, ${skill.refused.length} skipped)`);
      if (rules) console.log(`Dry run: would ${rules.action === 'refused' ? `refuse ${rules.file} (not managed by ada-scan) and write ${rules.fallback}` : `${rules.action} ${rules.file}`}`);
      return;
    }
    const { dir } = writeTaskSet(set, getReportsDir(), { includeNeedsReview: v['include-needs-review'], groupByFile: Boolean(v['group-by-file']) });
    console.log(`Exported ${set.tasks.length} task(s) and ${set.notActionable.length} not-actionable group(s) to ${dir}${path.sep}INDEX.md`);
    console.log(`Next: in your editor chat (Cursor, Claude Code) say: "Fix the accessibility tasks in ${path.relative(process.cwd(), path.join(dir, 'INDEX.md')) || 'INDEX.md'}, file by file, following the ada-scan rules. Leave the edits uncommitted." Then run: ada-scan fix --harness --from-working-tree`);
    if (skill) {
      console.log(`Installed the fix skill in ${skill.dir}: ${skill.created.length} new, ${skill.updated.length} updated, ${skill.unchanged.length} unchanged, ${skill.removed.length} stale removed`);
      for (const rel of skill.refused) console.log(`Skipped ${rel}: not managed by ada-scan (left untouched)`);
    }
    if (rules?.action === 'refused') throw new CliError(`${rules.file} exists and is not managed by ada-scan; left untouched. The rules were written to ${rules.fallback}: copy them into your own file.`);
    if (rules) console.log(`${rules.action === 'create' ? 'Created' : 'Updated'} ${rules.file}`);
    const keepOut = excludeAdvice(target, path.resolve(localRoot));
    const wrote = writtenNotice(target, keepOut);
    if (wrote) console.log(wrote);
    if (keepOut?.advice) console.log(keepOut.advice);
    if (target === 'claude') console.log('Add this line to your own CLAUDE.md (ada-scan never edits it):\n  @.claude/ada-scan.md');
    return;
  }
  return runTrustedFixFromReport(report, {
    localRoot,
    sessionId,
    useUI,
    fromFixSubcommand: true,
  });
}

/** `fix --verify`: working tree diff against the export; prints a table and exits 1 on a violation. */
function runFixVerify(v, localRoot) {
  const root = path.resolve(localRoot);
  let tasks;
  if (v.baseline !== undefined) {
    if (!existsSync(v.baseline)) throw new FixControllerError('REPORT_NOT_FOUND', `Report not found: ${v.baseline}`);
    const { report, error } = readReportFile(v.baseline);
    if (error) throw new FixControllerError('REPORT_INVALID', `Invalid report: ${error}`);
    tasks = buildTaskSet(report, { includeNeedsReview: true, sourceRoot: root }).tasks;
  } else {
    tasks = readExportedTasks(path.join(getReportsDir(), 'tasks'));
    if (!tasks) throw new CliError(`No export found in ${path.join(getReportsDir(), 'tasks')}: run "ada-scan fix --export" first, pass --out-dir <the folder you exported to>, or pass --baseline <report>.`);
  }
  let res;
  try { res = verifyDiff({ root, tasks }); } catch (e) { throw new CliError(e.message); }
  console.log(renderVerifyTable(res));
  if (res.violations) { const err = new CliError(`${res.violations} violation(s) against the fix export.`); err.exitCode = 1; throw err; }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

/** Pages affected by changed files: a changed page file selects that page, a shared (layout/partial/component) template selects all. */
export function selectChangedPages(pages, changedFiles, { pagesRoot = 'src/pages', extension = '.liquid' } = {}) {
  const templates = changedFiles
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.endsWith(extension) || f.endsWith(`${extension}.json`))
    .map((f) => f.replace(/\.json$/, ''));
  if (!templates.length) return { pages, reason: 'no template changes' };
  const root = `${pagesRoot.replace(/\/$/, '')}/`;
  if (templates.some((f) => !f.startsWith(root))) return { pages, reason: 'a shared template changed' };
  const changed = new Set(templates);
  const selected = pages.filter((p) => {
    const rel = p.path.replace(/^\//, '').replace(/\/$/, '') || 'index';
    return changed.has(`${root}${rel}${extension}`) || (rel !== 'index' && changed.has(`${root}${rel}/index${extension}`));
  });
  return selected.length ? { pages: selected } : { pages, reason: 'no configured page matches the changed files' };
}

export async function runCli() {
  const v = parseCliArgs(process.argv.slice(2));
  if (v.help) {
    console.log(USAGE);
    return;
  }

  const dryRun = v['dry-run'];
  const fix = v.fix;
  const baselineMode = v.baseline;
  const reportOnly = v['report-only'];
  const forceBuild = v['force-build'];
  const changedOnly = v['changed-only'];
  const useUI = v.ui;
  const allPages = v.all;
  const verbose = v.verbose;
  const noFail = v['no-fail'];
  const reverify = !v['no-reverify'];
  const allowIncomplete = v['allow-incomplete'];
  const requireTrace = v['require-trace'];
  const keepQuery = v['keep-query'];
  const sarif = v.sarif; // undefined = off, '' = default <outDir>/scan.sarif
  const maxTimeSec = v['max-time'] === undefined ? undefined : Number(v['max-time']);
  if (maxTimeSec !== undefined && !(maxTimeSec > 0)) throw new CliError('--max-time needs a positive number of seconds.');
  const includeThirdPartyRequested = v['include-third-party'];
  const excludeThirdPartyRequested = v['exclude-third-party'];
  const noHydrateJobs = v['no-hydrate-jobs'];
  const forcePSI = v.psi;
  const noPSI = v['no-psi'];
  const lighthouseRuns = v['lighthouse-runs'] ?? null;
  const failOnViolations = v['fail-on-violations'];
  const gate = v.gate;
  const perfGate = v['perf-gate'];
  const seoGate = v['seo-gate'];
  const adHoc = v['ad-hoc'];
  const urlArg = v.url ?? null;
  const pageFilter = v.page ?? null;
  const layersArg = v.layers ?? null;
  const sourceArg = v.source ?? null;
  const sessionId = v.session ?? null;
  if (adHoc && !pageFilter) throw new CliError('--ad-hoc only applies together with --page.');

  const modeError = fixModeError(v['fix-mode']);
  if (modeError) throw new CliError(modeError);

  const activeLayerNames = layersArg === null ? null : layersArg.split(',').map((n) => n.trim()).filter(Boolean);
  if (activeLayerNames) {
    const unknown = activeLayerNames.filter((n) => !KNOWN_LAYERS.includes(n));
    if (!activeLayerNames.length || unknown.length) {
      throw new CliError(`Unknown --layers value${unknown.length ? `: ${unknown.join(', ')}` : ' (empty)'}. Valid layers: ${KNOWN_LAYERS.join(', ')}.`);
    }
  }

  const config = loadConfig();
  applyReportsDir(v['out-dir'], config);
  if (v.profile !== undefined) config.profile = v.profile;

  config.layers = {
    ...config.layers,
    accessScan: config.layers.accessScan ?? true,
    links: config.layers.links ?? true,
  };

  if (activeLayerNames) {
    for (const key of Object.keys(config.layers)) {
      config.layers[key] = activeLayerNames.includes(key);
    }
  }

  if (lighthouseRuns !== null) {
    if (!/^[1-9]\d*$/.test(lighthouseRuns)) throw new CliError('--lighthouse-runs must be an integer >= 1.');
    config.lighthouse = { ...config.lighthouse, runs: Number(lighthouseRuns) };
  }

  config.external = { ...config.external };
  if (v['allow-external']) config.external.w3c = config.external.psi = true;
  if (forcePSI) config.external.psi = true;
  if (noPSI) config.external.psi = false;

  console.log('\nADA & Performance Scanner v2');
  console.log('============================');
  if (dryRun) console.log('DRY RUN — no files will be modified');
  if (baselineMode) console.log('BASELINE MODE — saving results as the baseline');
  if (allPages) console.log('ALL PAGES — explicit all-page scan');
  if (changedOnly) console.log('CHANGED-ONLY — scanning pages with modified .liquid files');
  if (fix) console.log('FIX MODE: cis');

  if (verbose) {
    const activeLayers = Object.entries(config.layers).filter(([, v]) => v).map(([k]) => k);
    console.log(`LAYERS: ${activeLayers.join(', ')}`);
  }

  if (reportOnly) {
    const latestPath = resolveReportFile('latest.json');
    if (!existsSync(latestPath)) {
      console.error('No latest scan found. Run `pnpm scan` first.');
      process.exit(1);
    }
    const { report: latestReport, error: latestError } = readReportFile(latestPath);
    if (latestError) {
      console.error(`Invalid latest scan: ${latestError}. Run \`pnpm scan\` again.`);
      process.exit(1);
    }
    const legacyReport = projectReportForLegacy(latestReport);
    const enriched = enrichReportForHtml(legacyReport);
    const vPath = writeHtmlReport(latestReport.schemaVersion === '2.0.0' ? { ...enriched, v2: latestReport } : enriched);
    console.log(`Visual report: ${vPath}`);
    if (latestReport.schemaVersion === '2.0.0') console.log(`QA report: ${writeQaReport(latestReport)}`);
    if (sarif !== undefined) console.log(`SARIF: ${writeSarif(latestReport, sarif)}`);
    await generateExecSummary(latestReport);
    return;
  }

  // Remote URL scan mode
  if (urlArg) {
    const isLocalUrl = isLoopbackUrl(urlArg);
    const includeThirdParty = resolveIncludeThirdParty({
      isRemoteUrl: !isLocalUrl,
      includeRequested: includeThirdPartyRequested,
      // --no-hydrate-jobs implies no third-party widget findings in the compare path
      excludeRequested: excludeThirdPartyRequested || noHydrateJobs,
    });
    let scanAttestation = null;
    let sourceTracingUnavailable = null;
    if (isLocalUrl) {
      console.log(`\nLocal URL scan: ${urlArg}`);
      console.log('Building instrumented dist for partial tracing...');
      const built = await tryBuildInstrumented(forceBuild, config);
      scanAttestation = built.attestation;
      if (built.unavailable) {
        sourceTracingUnavailable = built.unavailable;
        console.warn(`Warning: source tracing unavailable: ${built.unavailable}`);
        if (requireTrace) throw new CliError(`--require-trace: source tracing unavailable: ${built.unavailable}`);
      }
      clearPartialCache();
      clearTagIndexCache();
    } else {
      console.log(`\nRemote URL scan: ${urlArg}`);
    }
    if (noHydrateJobs) {
      console.log('NO-HYDRATE-JOBS — blocking jobs/chat bundles and stripping mounts');
    }
    try {
      await runScan(
        await discoverScanPages({ rawArgs: process.argv.slice(2), config, baseUrl: urlArg, projectRoot: PROJECT_ROOT, urlMode: true, onWarnings: (w, t) => { discoveryWarnings = w; discoveryTemplates = t || null; } }),
        config,
        {},
        {
          fix, dryRun, baselineMode, useUI,
          isUrlMode: !isLocalUrl, noFail, allowIncomplete, keepQuery, includeThirdParty, failOnViolations, gate, perfGate, seoGate,
          noHydrateJobs, maxTimeSec, reverify, sarif,
          sourceTracingUnavailable, scanAttestation, sourceRoot: sourceArg, sessionId, localUrl: isLocalUrl,
        }
      );
    } finally {
      await closeBrowser();
    }
    return;
  }

  // Local scan
  let serverProcess = null;
  try {
    serverProcess = await ensureServer(new Set(v['no-server'] ? ['--no-server'] : []), config);
    const scanAttestation = await buildInstrumented(forceBuild);
    clearPartialCache();
    clearTagIndexCache();

    const manifest = loadScanManifest();
    console.log(`Manifest: ${Object.keys(manifest).length} path mappings loaded`);

    let pages = config.pages.length > 0 ? config.pages : [{ path: '/', name: 'homepage' }];
    if (config.pages.length === 0 && !pageFilter) {
      pages = await discoverScanPages({ rawArgs: process.argv.slice(2), config, baseUrl: config.baseUrl, projectRoot: PROJECT_ROOT, urlMode: false, onWarnings: (w, t) => { discoveryWarnings = w; discoveryTemplates = t || null; } });
    }

    if (pageFilter) {
      const normalizedFilter = pageFilter.replace(/^\//, '');
      const filtered = pages.filter((p) => {
        const pageName = p.name || '';
        const pagePath = p.path?.replace(/^\//, '') || '';
        return p.path === pageFilter || p.name === pageFilter ||
          pageName === normalizedFilter || pagePath === normalizedFilter ||
          (normalizedFilter === 'index' && p.path === '/');
      });
      if (!filtered.length && config.pages.length && !adHoc) {
        throw new CliError(
          `--page "${pageFilter}" is not a configured page (${config.pages.map((p) => p.name).join(', ')}). Pass --ad-hoc to scan an unlisted path.`,
        );
      }
      const fallbackPath = pageFilter.startsWith('/') ? pageFilter : `/${pageFilter}`;
      pages = filtered.length > 0 ? filtered : [{ path: fallbackPath, name: derivePageName(fallbackPath) }];
    }

    if (changedOnly && !pageFilter) {
      const selection = selectChangedPages(pages, gitChangedSinceLastCommit(PROJECT_ROOT), config.source);
      if (selection.reason) {
        console.log(`Changed-only: ${selection.reason} — scanning all pages`);
      } else {
        pages = selection.pages;
        console.log(`Changed-only: scanning ${pages.length} of ${config.pages.length || 1} page(s)`);
      }
    }

    const pagesToScan = pages.map((p) => {
      if (p.path.startsWith('http')) return { ...p, url: p.path };
      const pagePath = p.path.startsWith('/') ? p.path : `/${p.path}`;
      const base = config.baseUrl.replace(/\/$/, '');
      return { ...p, url: `${base}${pagePath}` };
    });

    const isSinglePage = pagesToScan.length === 1 || !!pageFilter;
    const includeThirdParty = resolveIncludeThirdParty({
      includeRequested: includeThirdPartyRequested,
      excludeRequested: excludeThirdPartyRequested || noHydrateJobs,
    });
    if (noHydrateJobs) {
      console.log('NO-HYDRATE-JOBS — blocking jobs/chat bundles and stripping mounts');
    }
    await runScan(pagesToScan, config, manifest, {
      fix, dryRun, baselineMode, useUI,
      isUrlMode: false, isSinglePage, noFail, allowIncomplete, keepQuery, includeThirdParty, failOnViolations, gate, perfGate, seoGate,
      noHydrateJobs, pageFilter, maxTimeSec, reverify, sarif,
      scanAttestation: scanAttestation || loadScanAttestation(config),
      sourceRoot: PROJECT_ROOT, sessionId,
    });
  } finally {
    await closeBrowser();
    if (serverProcess) {
      console.log('\nStopping dev server...');
      killGroup(serverProcess);
    }
  }
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  const queue = tasks.map((task, idx) => ({ task, idx }));
  const running = new Set();

  async function runNext() {
    if (queue.length === 0) return;
    const { task, idx } = queue.shift();
    const p = task().then((result) => {
      results[idx] = result;
      running.delete(p);
    });
    running.add(p);
    await p;
    return runNext();
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ─── Axe violations → unified schema adapter ─────────────────────────────────

// axe 'incomplete' results (it could not decide) become needs-review findings, at most this many nodes per page.
export const MAX_AXE_INCOMPLETE_PER_PAGE = 10;

export function axeToUnified(axeResult, url, sourceMode = 'url') {
  const violations = [];
  const groups = [
    ...(axeResult.violations || []).map((v) => [v, false]),
    ...(axeResult.incomplete || []).map((v) => [v, true]),
  ];
  let incompleteLeft = MAX_AXE_INCOMPLETE_PER_PAGE;
  for (const [v, incomplete] of groups) {
    for (const node of v.nodes || []) {
      if (node.devArtifact) continue;
      if (incomplete && incompleteLeft-- <= 0) break;
      const impact = incomplete ? capImpact(node.impact || v.impact || 'moderate', 'moderate') : node.impact || v.impact;
      const unified = createViolation({
        ruleId: v.id,
        layer: 'axe',
        category: 'accessibility',
        wcagRef: (v.tags || []).find((t) => t.startsWith('wcag'))?.toUpperCase(),
        impact,
        priority: impactToPriority(impact),
        element: {
          outerHTML: node.html || '',
          selector: Array.isArray(node.target) ? node.target.join(' ') : String(node.target || ''),
          scanId: node.source?.snippetId || null,
        },
        source: {
          mode: sourceMode,
          file: node.source?.file || null,
          line: node.source?.line || null,
          snippet: node.source?.snippetId || null,
          url,
          confidence: node.source?.confidence || (node.source?.file ? 'low' : 'none'),
          method: node.source?.method || (node.source?.file ? 'legacy-source-attribution' : 'unresolved'),
          preimageSha256: node.source?.preimageSha256 || null,
          preimageRange: node.source?.preimageRange || null,
        },
        fix: {
          deterministic: false,
          hint: incomplete
            ? `axe could not decide this check (${v.id}): ${(node.failureSummary || v.help || '').split('\n').filter(Boolean).slice(0, 2).join(' ')}. Needs a human review.`
            : node.pixelContrast?.message || v.description || v.help || '',
        },
      });
      if (node.ownership) unified.ownership = node.ownership;
      unified.evidence = buildAxeEvidence(v, node);
      if (incomplete) {
        unified.evidence.tags.push('axe-incomplete');
        unified.verdict = verdictFor({ kind: 'deterministic', incomplete: true });
      }
      violations.push(unified);
    }
  }
  return violations;
}

const FRESH_PAGE_LAYERS = new Set(['axe', 'accessScan', 'links', 'ariaLive']);

/** Re-checks a page's sensitive findings in one extra fresh context (opened on demand, closed at the end). */
async function reverifyPageFindings(violations, layerTasks, { url, sessionOptions, verify = {}, browser, phases = {}, warm = null }) {
  let fresh = null;
  const rerun = async (layer, targets) => {
    if (FRESH_PAGE_LAYERS.has(layer) && !fresh) {
      fresh = (await warm?.page) || await openScanPage(browser, url, sessionOptions);
      if (fresh.failure) throw new Error(fresh.failure.message);
      await fresh.page.waitForTimeout(500);
      if (sessionOptions.noHydrateJobs) await prepareNoHydrateJobsPage(fresh.page);
    }
    const out = { violations: [], scannerRuns: [] };
    const page = fresh?.page ?? null;
    await timed(phases, `reverify.${layer}`, () => layerTasks.get(layer)(out.violations, out.scannerRuns, { page, shared: { ...sessionOptions, page }, log() {}, rerun: true, targets }));
    if (out.scannerRuns.some((r) => r.status === 'error' || r.status === 'timeout')) throw new Error(`${layer} did not complete`);
    return out.violations;
  };
  try {
    // axe/accessScan/ariaLive share the fresh page, so they go one after another; the layers that open their own contexts run beside them.
    const laneOf = (layer) => (FRESH_PAGE_LAYERS.has(layer) ? 0 : 1);
    return await reverifyFindings(violations, { rerun, key: reverifyKey, laneOf, ...DEFAULT_VERIFY, ...verify });
  } finally {
    await fresh?.close();
  }
}

// ─── Per-page scan ────────────────────────────────────────────────────────────

export const scanOnePage = (pageConfig, config, options = {}) => runInScope(() => scanOnePageInScope(pageConfig, config, options));

async function scanOnePageInScope(pageConfig, config, options) {
  const url = pageConfig.url;
  const violations = [];
  const lighthouseScores = {};
  const scannerRuns = [];
  const phases = {};
  let axeSummary = null;
  const isRemote = options.isUrlMode === true;
  const sourceMode = isRemote ? 'url' : 'local';
  const timeout = isRemote ? REMOTE_PAGE_TIMEOUT_MS : PAGE_TIMEOUT_MS;

  const browser = await getBrowser();
  let page = null;
  let response = null;
  let closeSession = null;
  let pageAttestation = null;
  let attempts = 0;
  let devServer = false;
  let noindex = false;
  let mainHtml = '';
  let servedHtml = null;
  let layerRetriesOut = [];
  let parityViolations = [];
  let parityError = null;
  let layerTasks = null;
  let warm = null;
  const closeWarm = async () => { for (const p of [warm?.page, ...(warm?.viewports.values() || [])]) await (await p)?.close(); };
  const sessionOptions = { navTimeout: timeout, allowStatus: pageConfig.allowStatus || [], noHydrateJobs: options.noHydrateJobs };

  try {
    // One navigation per page; read-only layers share it, mutating ones open their own contexts.
    let failure;
    for (;;) {
      attempts++;
      try {
        ({ page, close: closeSession, response, failure } = await timed(phases, 'navigate', () => openScanPage(browser, url, sessionOptions)));
      } catch (err) {
        failure = {
          reason: isTimeoutError(err) ? 'timeout' : 'navigation-error',
          httpStatus: null,
          message: err.message.split('\n')[0],
        };
      }
      // A local dev server's 5xx is deterministic (the template needs platform data): no retry there.
      if (attempts > NAV_RETRIES || !isTransientFailure(failure)) break; // a local dev server may answer 500 once while it compiles: retry once, then judge unrenderable-locally
      console.log(`  [${pageConfig.name}] ${failure.message} — retrying once`);
      await closeSession?.();
      closeSession = null;
    }
    const unrenderable = (reason) => ({ reason: 'unrenderable-locally', note: `${UNRENDERABLE_NOTE}${reason ? ` (${reason})` : ''}` });
    if (failure && !isRemote && !config.scan?.strict && isUnrenderableLocally(failure)) {
      console.log(`  [${pageConfig.name}] SKIPPED: ${failure.message} from the local dev server (${UNRENDERABLE_NOTE}) — no layer run`);
      await closeSession?.();
      return buildEmptyPageResult(pageConfig, attempts, unrenderable(failure.message));
    }
    if (failure) {
      console.log(`  [${pageConfig.name}] FAILED: ${failure.message} — page not scanned`);
      await closeSession?.();
      return { ...buildFailedPageResult(pageConfig, failure), attempts };
    }
    const failOnOverlay = async () => {
      const failure = { reason: 'dev-error-overlay', httpStatus: null, message: DEV_OVERLAY_REASON };
      console.log(`  [${pageConfig.name}] FAILED: ${failure.message} (page not scanned)`);
      await closeSession?.();
      return { ...buildFailedPageResult(pageConfig, failure), attempts };
    };
    mainHtml = await page.content().catch(() => '');
    servedHtml = typeof response?.text === 'function' ? await response.text().catch(() => null) : null;
    devServer = isDevServerHtml(mainHtml);
    noindex = isNoindex(mainHtml, response?.headers() || {});
    await page.waitForTimeout(500);
    // An overlay is the build error, not the site: nothing on the page is a finding, and the run must not look clean (exit 2).
    // The string sniff alone would fail a page that merely quotes `new ErrorOverlay(` in text, so it counts only for a local target.
    if (await hasDevOverlay(page) || (!isRemote && isDevErrorOverlay(mainHtml))) return failOnOverlay();
    if ((config.scan?.emptyPagePolicy ?? 'skip') === 'skip' && await isEmptyPage(page).catch(() => false)) {
      console.log(`  [${pageConfig.name}] SKIPPED: page is empty (${EMPTY_PAGE_NOTE}) — no layer run`);
      await closeSession?.();
      return buildEmptyPageResult(pageConfig, attempts);
    }
    if (options.noHydrateJobs) {
      await prepareNoHydrateJobsPage(page);
      await page.waitForTimeout(200);
    }

    if (isRemote) {
      pageAttestation = await extractPageAttestationFromPage(page);
    }

    // Layers run on private violation/scannerRuns arrays so concurrent layers keep a stable merge order.
    // readOnly layers share the navigated page; serial layers mutate (accessScan activates content and scrolls,
    // keyboard/focusTrap/dynamicContent interact), so they run afterwards, the latter on fresh contexts.
    const shared = { ...sessionOptions, page };
    const main = { page, shared, log: console.log };
    const own = sessionOptions;
    const readOnly = [];
    const serial = [];

    if (config.layers.axe) readOnly.push(['axe', async (violations, scannerRuns, { page, shared, log, rerun, isRetry, targets } = main) => {
      try {
        // A re-run only needs the viewports its findings were seen at.
        const seenAt = new Set((targets || []).flatMap((v) => (v.evidence?.viewports || []).map((vp) => vp.name)));
        const configured = config.axe?.viewports?.length ? config.axe.viewports : DEFAULT_AXE_VIEWPORTS;
        const viewports = rerun ? configured.filter((vp) => seenAt.has(vp.name)) : [];
        const axeConfig = viewports.length ? { ...config, axe: { ...config.axe, viewports } } : config;
        const axeResult = await scanPageWithAxe(url, axeConfig, { sourceMode, ...(isRetry ? own : shared), ...(rerun && targets ? { onlyRules: new Set(targets.map((v) => v.ruleId)), warmPages: warm?.viewports } : {}) });
        const axeViols = axeToUnified(axeResult, url, sourceMode);
        const summary = buildAxePageMetadata(axeResult);
        if (!rerun) axeSummary = summary; // a re-verify run must not replace the first pass's totals
        scannerRuns.push(...buildAxeScannerRuns(axeResult));
        violations.push(...axeViols);
        log(
          `  [${pageConfig.name}] axe: ${summary.totalIssueGroups} rule group${summary.totalIssueGroups === 1 ? '' : 's'}, ` +
          `${summary.affectedNodes} affected node${summary.affectedNodes === 1 ? '' : 's'} across ${summary.viewports.length} viewports`
        );
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('axe', err));
        log(`  [${pageConfig.name}] axe: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.accessScan) serial.push(['accessScan', async (violations, scannerRuns, { page, shared, log, rerun, targets } = main) => {
      try {
        let accessExecutionRecords = null;
        let accessSessionMetrics = null;
        // Optional profile fields must not be forwarded as `profile: undefined`,
        // or resolveScanProfile forces standards and ignores includeThirdParty.
        // The gate always comes from the standards profile (D9); parity runs below as supplementary info.
        const resolvedAccessProfile = 'standards';
        const accessViols = await scanWithAccessScan(page, url, {
          skipRules: config.skipRules,
          onlyRules: rerun && targets ? new Set(targets.map((v) => v.ruleId)) : undefined,
          profile: resolvedAccessProfile,
          includeThirdParty: options.includeThirdParty,
          skipNavigation: true,
          configureForkedPage: options.noHydrateJobs ? ({ page: fork }) => installNoHydrateJobsRoutes(fork) : undefined,
          activateContent: options.noHydrateJobs ? false : true,
          externalNavigationCount: 1,
          onExecutionRecords: (records, meta) => {
            accessExecutionRecords = records;
            accessSessionMetrics = meta.sessionMetrics;
            if (!rerun) for (const [step, ms] of Object.entries(meta.timings)) phases[`accessScan.${step}`] = ms;
          },
        });
        violations.push(...accessViols);
        scannerRuns.push(buildAccessScanRun(accessViols, {
          includeThirdParty: options.includeThirdParty,
          engineVersion: PACKAGE_VERSION,
          profile: resolvedAccessProfile,
          executionTotals: accessExecutionRecords
            ? buildAccessScanExecutionTotals(accessExecutionRecords)
            : null,
          sessionMetrics: accessSessionMetrics,
        }));
        log(`  [${pageConfig.name}] accessScan: ${accessViols.length} violation${accessViols.length === 1 ? '' : 's'}`);
        if (config.profile === 'commercial-parity' && !rerun) {
          // Supplementary: kept off violations/scannerRuns so it never reaches the gate, summary or exit code.
          try {
            const parityViols = await scanWithAccessScan(page, url, {
              skipRules: config.skipRules,
              profile: 'commercial-parity',
              skipNavigation: true,
              activateContent: false,
              externalNavigationCount: 1,
              configureForkedPage: options.noHydrateJobs ? ({ page: fork }) => installNoHydrateJobsRoutes(fork) : undefined,
            });
            const seen = new Set(accessViols.map(parityKey));
            parityViolations = parityViols.filter((v) => !seen.has(parityKey(v)));
            log(`  [${pageConfig.name}] commercial-parity (supplementary): ${parityViolations.length} extra finding${parityViolations.length === 1 ? '' : 's'}`);
          } catch (err) {
            parityError = err.message.split('\n')[0];
            log(`  [${pageConfig.name}] commercial-parity: skipped — ${parityError}`);
          }
        }
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('accessScan', err));
        log(`  [${pageConfig.name}] accessScan: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    // Each layer is wrapped in try/catch so a timeout in one scanner
    // (common on slow remote URLs) doesn't discard results from earlier layers.

    if (config.layers.w3c) readOnly.push(['w3c', async (violations, scannerRuns, { shared, isRetry } = main) => {
      try {
        const w3cResult = await scanW3cValidation(url, config, isRetry ? own : shared);
        if (w3cResult.scannerRun) scannerRuns.push(w3cResult.scannerRun);
        if (w3cResult.scannerRun?.status === 'skipped') {
          console.log(`  [${pageConfig.name}] w3c: skipped (${w3cResult.scannerRun.evidence.errorCode}), ${config.layers.htmlValidate ? 'html-validate is the validity engine' : 'no HTML validity engine ran'}`);
        }
        const w3cViols = (w3cResult.violations || []).filter((v) => {
          if (v.rule === 'w3c-html-info' || v.type === 'info') return false;
          return true;
        });
        for (const v of w3cViols) {
          const impactMap = { error: 'serious', warning: 'minor' };
          const priorityMap = { error: 2, warning: 4 };
          const vType = v.type || (v.rule === 'w3c-html-error' ? 'error' : 'warning');
          const unified = createViolation({
            ruleId: v.rule || v.id || 'w3c-html-error',
            layer: 'w3c', category: 'markup',
            impact: impactMap[vType] || v.impact || 'minor',
            priority: priorityMap[vType] || 4,
            element: { outerHTML: v.element?.extract || v.html || '', selector: '' },
            source: {
              mode: 'url',
              file: v.source?.file || '',
              line: v.source?.line || null,
              url,
              confidence: v.source?.confidence || 'none',
              method: v.source?.method || 'unresolved',
              preimageSha256: v.source?.preimageSha256 || null,
              preimageRange: v.source?.preimageRange || null,
            },
            fix: { deterministic: false, hint: v.description || v.message || '' },
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : '',
          });
          unified.evidence = {
            renderedLine: v.element?.line || v.line || null,
            renderedLastLine: v.element?.lastLine || v.lastLine || null,
          };
          if (v.count > 1) unified.count = v.count;
          violations.push(unified);
        }
        const infoCount = (w3cResult.violations || []).length - w3cViols.length;
        const occurrenceCount = countViolationOccurrences(w3cViols);
        console.log(`  [${pageConfig.name}] w3c: ${occurrenceCount} violation${occurrenceCount === 1 ? '' : 's'} in ${w3cViols.length} fix unit${w3cViols.length === 1 ? '' : 's'}${infoCount > 0 ? ` (${infoCount} info filtered)` : ''}`);
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('w3c', err));
        console.log(`  [${pageConfig.name}] w3c: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.htmlValidate) readOnly.push(['htmlValidate', async (violations, scannerRuns) => {
      try {
        const hvResult = await scanHtmlValidate(url, config, shared);
        const impactMap = { error: 2, warning: 4 };
        for (const v of hvResult.violations) {
          const unified = createViolation({
            ruleId: v.rule, layer: 'htmlValidate', category: 'markup',
            impact: v.impact, priority: impactMap[v.type],
            element: { outerHTML: v.html, selector: v.selector },
            source: {
              mode: 'url',
              file: v.source?.file || '',
              line: v.source?.line || null,
              url,
              confidence: v.source?.confidence || 'none',
              method: v.source?.method || 'unresolved',
              preimageSha256: v.source?.preimageSha256 || null,
              preimageRange: v.source?.preimageRange || null,
            },
            fix: { deterministic: false, hint: v.description },
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : '',
          });
          unified.evidence = { renderedLine: v.line, renderedColumn: v.element.col, htmlSource: hvResult.htmlSource };
          // Conventions and Nu warnings are likely, never gate-eligible; so is anything validated on HTML other than the live DOM.
          const kind = htmlValidateKind(hvResult.htmlSource, v.type);
          if (kind) unified.kind = kind;
          violations.push(unified);
        }
        scannerRuns.push({
          ...buildInternalScannerRun('htmlValidate', hvResult.violations, { engineVersion: HTML_VALIDATE_VERSION }),
          htmlSource: hvResult.htmlSource,
          engine: { name: HTML_VALIDATE_ENGINE, version: HTML_VALIDATE_VERSION },
        });
        console.log(`  [${pageConfig.name}] htmlValidate: ${hvResult.violations.length} issue${hvResult.violations.length === 1 ? '' : 's'} (offline ${HTML_VALIDATE_ENGINE} ${HTML_VALIDATE_VERSION})`);
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('htmlValidate', err));
        console.log(`  [${pageConfig.name}] htmlValidate: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.links) readOnly.push(['links', async (violations, scannerRuns, { page, shared, log, rerun, targets } = main) => {
      try {
        const linkViols = await scanDeadLinks(page, url, { checker: options.linkChecker, platformRoutes: config.links?.platformRoutes || [], knownRoutes: options.knownRoutes, ...(rerun && targets ? { selectors: new Set(targets.map((v) => v.element?.selector)) } : {}) });
        violations.push(...linkViols);
        scannerRuns.push(buildInternalScannerRun('links', linkViols, {
          engineVersion: PACKAGE_VERSION,
        }));
        log(`  [${pageConfig.name}] links: ${linkViols.length} issue${linkViols.length === 1 ? '' : 's'}`);
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('links', err));
        log(`  [${pageConfig.name}] links: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.keyboard) serial.push(['keyboard', async (violations, scannerRuns, { log } = main) => {
      try {
        const kbResult = await scanKeyboardNavigation(url, own);
        for (const v of kbResult.violations || []) {
          violations.push(carryMeasurement(createViolation({
            ruleId: v.rule || v.id || 'keyboard-trap',
            canonicalRuleId: v.canonicalRuleId,
            layer: 'keyboard', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'serious', priority: impactToPriority(v.impact || 'serious'),
            element: { outerHTML: v.element?.html || v.snippet || '', selector: v.element?.selector || (v.element?.tag ? `<${v.element.tag.toLowerCase()}>` : '') },
            source: { mode: 'url', file: v.source?.file, line: v.source?.line, url },
            fix: { deterministic: false, hint: v.description || '' },
          }), { verdict: v.verdict, evidence: keyboardEvidence(v) }));
        }
        scannerRuns.push(buildInternalScannerRun('keyboard', kbResult.violations || [], {
          engineVersion: PACKAGE_VERSION,
        }));
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('keyboard', err));
        log(`  [${pageConfig.name}] keyboard: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.focusTrap) serial.push(['focusTrap', async (violations, scannerRuns, { log } = main) => {
      try {
        const ftResult = await scanFocusTraps(url, own);
        for (const v of ftResult.violations || []) {
          violations.push(carryMeasurement(createViolation({
            ruleId: v.rule || v.id || 'focus-trap',
            layer: 'focusTrap', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: 'critical', priority: 1,
            element: { outerHTML: v.element?.html || '', selector: v.element?.selector || '' },
            source: { mode: 'url', url },
            fix: { deterministic: false, hint: v.description || '' },
          }), v, ftResult.blockedScripts));
        }
        scannerRuns.push(buildInternalScannerRun('focusTrap', ftResult.violations || [], {
          engineVersion: PACKAGE_VERSION, blockedScripts: ftResult.blockedScripts,
        }));
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('focusTrap', err));
        log(`  [${pageConfig.name}] focusTrap: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.ariaLive) readOnly.push(['ariaLive', async (violations, scannerRuns, { page, shared, log, isRetry } = main) => {
      try {
        const alResult = await scanAriaLiveRegions(url, isRetry ? own : shared);
        for (const v of alResult.violations || []) {
          violations.push(createViolation({
            ruleId: v.rule || v.id || 'aria-live-missing',
            layer: 'ariaLive', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'moderate', priority: 3,
            element: { outerHTML: v.element?.html || '', selector: v.element?.selector || v.element?.id || '' },
            source: { mode: 'url', url },
            fix: { deterministic: false, hint: v.description || '' },
          }));
        }
        scannerRuns.push(buildInternalScannerRun('ariaLive', alResult.violations || [], {
          engineVersion: PACKAGE_VERSION,
        }));
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('ariaLive', err));
        log(`  [${pageConfig.name}] ariaLive: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.dynamicContent) serial.push(['dynamicContent', async (violations, scannerRuns, { log } = main) => {
      try {
        const dcResult = await scanDynamicContent(url, own);
        for (const v of dcResult.violations || []) {
          violations.push(carryMeasurement(createViolation({
            ruleId: v.rule || v.id || 'dynamic-content',
            layer: 'dynamicContent', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'moderate', priority: 3,
            element: { outerHTML: v.element?.html || v.element?.examples?.[0]?.html || '', selector: v.element?.selector || '' },
            source: { mode: 'url', url },
            fix: { deterministic: false, hint: v.description || '' },
          }), v, dcResult.blockedScripts));
        }
        scannerRuns.push(buildInternalScannerRun('dynamicContent', dcResult.violations || [], {
          engineVersion: PACKAGE_VERSION, blockedScripts: dcResult.blockedScripts,
        }));
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('dynamicContent', err));
        log(`  [${pageConfig.name}] dynamicContent: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    if (config.layers.screenReader) readOnly.push(['screenReader', async (violations, scannerRuns, { shared, isRetry } = main) => {
      try {
        const srResult = await scanScreenReaderAccessibility(url, isRetry ? own : shared);
        for (const v of srResult.violations || []) {
          const unified = createViolation({
            ruleId: v.rule || v.id || 'screen-reader',
            layer: 'screenReader', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'serious', priority: 2,
            element: { outerHTML: v.html || v.element?.outerHTML || v.element?.html || v.element?.examples?.[0]?.html || '', selector: v.element?.selector || '' },
            source: { mode: 'url', file: v.source?.file, line: v.source?.line, url },
            fix: { deterministic: false, hint: v.description || '' },
          });
          if (v.evidence) unified.evidence = v.evidence;
          if (v.verdict === 'needs-review') { unified.verdict = 'needs-review'; unified.reason = v.evidence?.reviewReason; }
          else if (v.verdict === 'likely') { unified.verdict = 'likely'; unified.reason = v.evidence?.reviewReason; } // a check that measured the fact but cannot show its effect
          if (v.count > 1) unified.count = v.count;
          violations.push(unified);
        }
        scannerRuns.push({
          ...buildInternalScannerRun('screenReader', srResult.violations || [], { engineVersion: PACKAGE_VERSION }),
          htmlSource: HTML_SOURCE_LIVE_DOM, // judged on the live page, same DOM as axe and html-validate
        });
      } catch (err) {
        scannerRuns.push(buildFailedLayerRun('screenReader', err));
        console.log(`  [${pageConfig.name}] screenReader: skipped — ${err.message.split('\n')[0]}`);
      }
    }]);

    layerTasks = new Map([...readOnly, ...serial]);
    const mergeLayers = (tasks, settled) => settled.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        violations.push(...res.value.violations);
        scannerRuns.push(...res.value.scannerRuns);
      } else {
        scannerRuns.push(buildFailedLayerRun(tasks[i][0], res.reason));
      }
    });
    const layerRetries = [];
    const runLayer = async ([layer, task]) => {
      const out = await timed(phases, layer, () => runLayerWithRetry((v, r, isRetry) => task(v, r, { ...main, isRetry }), { bound: (work) => runBounded(work, options.layerDeadlineMs ?? LAYER_DEADLINE_MS, `layer ${layer}`) }));
      if (out.attempts > 1) layerRetries.push({ layer, attempts: out.attempts, reason: out.reason });
      return out;
    };
    mergeLayers(readOnly, await Promise.allSettled(readOnly.map(runLayer)));
    // Re-verification's fresh contexts load while the serial layers run, but only the ones its findings will need.
    if (options.reverify !== false && serial.length) {
      const need = violations.filter(needsReverify);
      const seenAt = new Set(need.filter((v) => v.layer === 'axe').flatMap((v) => (v.evidence?.viewports || []).map((vp) => vp.name)));
      const mainSize = page.viewportSize();
      const open = (viewport) => openScanPage(browser, url, { ...sessionOptions, ...(viewport ? { viewport } : {}) }).catch(() => null);
      const vps = (config.axe?.viewports?.length ? config.axe.viewports : DEFAULT_AXE_VIEWPORTS)
        .filter((vp) => seenAt.has(vp.name) && (vp.width !== mainSize?.width || vp.height !== mainSize?.height));
      const wantPage = need.some((v) => FRESH_PAGE_LAYERS.has(v.layer));
      if (wantPage || vps.length) warm = { page: wantPage ? open() : null, viewports: new Map(vps.map((vp) => [`${vp.width}x${vp.height}`, open({ width: vp.width, height: vp.height })])) };
    }
    for (const task of serial) mergeLayers([task], await Promise.allSettled([runLayer(task)]));
    layerRetriesOut = layerRetries;
  } catch (err) {
    await closeWarm();
    await closeSession?.();
    throw err;
  }

  let dedupedViolations;
  let reverify = null;
  try { // the pre-opened contexts must not outlive this block
    if (config.layers.lighthouse) {
      const lhResult = await timed(phases, 'lighthouse', () => scanWithLighthouse(url, config));
      lighthouseScores[pageConfig.name] = buildLighthouseScoreEntry(lhResult);
      scannerRuns.push(...buildLighthouseScannerRuns(lhResult));
      for (const v of lhResult.violations || []) {
        if (v.impact === 'info') continue;
        // A noindex target fails is-crawlable and friends by design: keep them as info, outside totals and the gate.
        const nv = normalizeLighthouseViolation(v, 'url', { file: pageConfig.file || null, url });
        if (noindex && !options.seoGate && nv.category === 'seo') nv.impact = 'info';
        violations.push(nv);
      }
      const mPerf = lhResult.lighthouse?.mobile?.scores?.performance ?? 'n/a';
      const dPerf = lhResult.lighthouse?.desktop?.scores?.performance ?? 'n/a';
      const lhSource = formatLighthouseSource(lhResult);
      const unscorable = ['mobile', 'desktop'].filter((d) => lhResult.lighthouse?.[d]?.unscorable);
      console.log(`  [${pageConfig.name}] lighthouse (${lhSource}): mobile ${mPerf}/100, desktop ${dPerf}/100${unscorable.length ? ` (unscorable: ${unscorable.join(', ')})` : ''}`);
    }

    // Both validity engines may run (--allow-external): keep one finding per problem.
    const w3cFindings = violations.filter((v) => v.layer === 'w3c');
    const hvFindings = violations.filter((v) => v.layer === 'htmlValidate');
    const hvDuplicates = new Set(w3cFindings.length && hvFindings.length ? hvFindings.filter((v) => !dropW3cDuplicates([v], w3cFindings).length) : []);
    dedupedViolations = deduplicateViolations(violations.filter((v) => !hvDuplicates.has(v)));
    if (options.reverify !== false && layerTasks) {
      reverify = await timed(phases, 'reverify', () => reverifyPageFindings(dedupedViolations, layerTasks, { url, sessionOptions, verify: config.verify, browser, phases, warm }));
      dedupedViolations = reverify.kept;
      const { unverified, overCap } = reverify.summary;
      if (unverified || overCap) console.log(`  [${pageConfig.name}] reverify: ${unverified} unverified (layer could not re-run), ${overCap} over the cap (verify.maxPerPage ${config.verify?.maxPerPage ?? DEFAULT_VERIFY.maxPerPage})`);
      if (reverify.flaky.length) console.log(`  [${pageConfig.name}] reverify: ${reverify.flaky.length} flaky finding${reverify.flaky.length === 1 ? '' : 's'} excluded (did not reproduce)`);
    }
  } finally {
    await closeWarm();
  }
  // Links to pages the crawl found missing: added after re-verification, which would not reproduce them in a layer rerun.
  for (const b of pageConfig.brokenLinks || []) {
    if (dedupedViolations.some((v) => v.layer === 'links' && v.fix?.hint?.includes(b.url))) continue;
    const href = b.href || b.route;
    const v = createViolation({
      ruleId: 'broken-link', layer: 'links', category: 'reliability', impact: 'moderate', priority: 4,
      element: { outerHTML: `<a href="${href}">`, selector: `a[href="${href}"]` },
      source: { mode: 'url', url },
      fix: { deterministic: false, hint: `Link to ${b.url} returned HTTP ${b.status} (found while crawling; referrer ${pageConfig.path || url}).` },
    });
    // Same grouping key as scanDeadLinks rows: one finding per target across the pages that link to it.
    const reason = !isRemote && routeNotServedLocally(b.url, url, options.knownRoutes) ? 'route-not-served-locally' : null;
    v.evidence = { ...(v.evidence || {}), proof: { type: 'http-status', fact: `HTTP ${b.status} for ${b.url} (the crawl fetched the target)` } };
    v.linkTarget = { url: b.url, fragment: null, status: b.status, reason };
    if (reason) { v.verdict = 'needs-review'; v.kind = 'heuristic'; v.reason = reason; }
    dedupedViolations.push(v);
  }
  // Size findings: which stylesheet rule declares the size (read from the live page; located in the project's CSS after tracing).
  const sized = isRemote ? [] : dedupedViolations.filter((v) => isSizeRule(v.ruleId || v.rule) && v.element?.selector);
  if (sized.length) {
    try {
      (await collectCssRules(page, sized.map((v) => v.element.selector))).forEach((rule, i) => { if (rule) sized[i].cssRule = rule; });
    } catch { /* the markup source stays */ }
  }
  // Colour findings: which declaration (rule, custom property) wins for the failing foreground / background, read from the live CSSOM.
  const coloured = isRemote ? [] : dedupedViolations.filter((v) => /color-contrast/i.test(v.ruleId || v.rule || '') && v.element?.selector);
  if (coloured.length) {
    try {
      (await collectColorChains(page, coloured.map((v) => v.element.selector))).forEach((chain, i) => { if (chain) coloured[i].colorChain = chain; });
    } catch { /* the markup source stays */ }
  }
  // Tool-owned measurements (target size, label in name, settled contrast) decide the verdict of the engine rows for those rules.
  try {
    const measured = await timed(phases, 'measured', () => applyMeasuredChecks(page, dedupedViolations, { viewports: config.axe?.viewports, url, noHydrateJobs: Boolean(options.noHydrateJobs) }));
    dedupedViolations.push(...measured.added);
  } catch { /* the engines' verdicts stand */ }
  await applySvgChildOfNamedControl(page, dedupedViolations);
  applyUnresolvedText(dedupedViolations);
  // Who owns each element (site / platform / third party), from the live page while it is still open.
  try {
    await timed(phases, 'origin', () => annotateOrigins(page, dedupedViolations, {
      vendors: loadVendors(config.tracing?.vendors), servedHtml, foreignImpactCap: config.tracing?.foreignImpactCap === undefined ? 'moderate' : config.tracing.foreignImpactCap,
    }));
    dedupedViolations = await dropStaleEvidence(page, dedupedViolations);
  } catch { // probe machinery itself failed: no origin is claimed, so nothing is silently site-owned and confirmed
    for (const v of dedupedViolations) v.origin ||= classifyOrigin({ ...v, outerHTML: v.element?.outerHTML, selector: v.element?.selector }, { probeFailed: Boolean(v.element?.selector), servedHtml });
  }
  // A bare layout shell: the page template holds no body (the layout may still carry a <main>), or the live page renders no <main>, no heading and next to no text.
  const bareShell = (!isRemote && isEmptyPageTemplate(resolveProject(config, options.localRoot || PROJECT_ROOT).pagesDir, url))
    || await page.evaluate(liveShellProbe).catch(() => false);
  downgradeErrorPage(dedupedViolations, url, config.scan?.errorPages ?? DEFAULT_CONFIG.scan.errorPages, { bareShell });
  // Evidence is captured last, on the shared page, only for findings that survived re-verification, so flaky ones cost no screenshot.
  // An overlay that appeared while the layers ran (a late HMR error) poisons every finding of this page.
  const lateOverlay = await hasDevOverlay(page);
  dedupedViolations = dropDevOverlayFindings(dedupedViolations);
  const liquidLeak = isRemote ? null : await probeLiquidLeak(page);
  const leakNear = liquidLeak ? new Set(await leakNearSelectors(page, dedupedViolations.filter((v) => v.evidence?.pixelContrast).map((v) => v.element?.selector).filter(Boolean))) : null;
  try {
    if (options.evidenceDir) {
      await timed(phases, 'evidence', () => attachEvidence(page, dedupedViolations.filter((v) => v.layer !== 'lighthouse'), { dir: options.evidenceDir, pageUrl: url, screenshots: config.evidence?.screenshots }));
    }
  } finally {
    await closeSession?.();
  }
  if (lateOverlay) {
    const failure = { reason: 'dev-error-overlay', httpStatus: null, message: DEV_OVERLAY_REASON };
    console.log(`  [${pageConfig.name}] FAILED: ${failure.message} (appeared during the scan)`);
    return { ...buildFailedPageResult(pageConfig, failure), attempts };
  }
  const localRoot = options.localRoot || PROJECT_ROOT;
  if (!isRemote) {
    await traceToPartials(dedupedViolations, url, localRoot);
    dedupedViolations = groupByColorOrigin(dedupedViolations);
    applyCssOrigins(dedupedViolations, localRoot);
    ensureSourceLine(dedupedViolations, localRoot);
    enrichLocalSnippets(dedupedViolations, localRoot);
  }
  applyRenderArtefacts(dedupedViolations, { liquidLeak, leakNear, root: isRemote ? null : localRoot });
  if (!isRemote) applyEnvironmentArtefacts(dedupedViolations, { root: localRoot });

  console.log(`  [${pageConfig.name}] phases: ${formatPhases(phases)}`);
  return {
    name: pageConfig.name,
    url,
    phases,
    violations: dedupedViolations,
    lighthouseScores,
    devServer,
    noindex,
    contentHash: pageContentHash(mainHtml),
    axeSummary,
    scannerRuns,
    pageAttestation,
    reverify,
    scanFailed: false,
    status: derivePageStatus(null, scannerRuns),
    failure: null,
    attempts,
    layerRetries: layerRetriesOut,
    ...(config.profile === 'commercial-parity' ? { parity: { findings: parityViolations, error: parityError } } : {}),
  };
}

const parityKey = (v) => `${v.ruleId}|${v.element?.selector || ''}|${v.element?.outerHTML || ''}`;

/** Supplementary commercial-parity section for the report: never read by the gate, summary or exit code. */
function buildParityMetadata(pageResults) {
  return {
    profile: 'commercial-parity',
    gating: false,
    pages: pageResults.filter((p) => p.parity).map((p) => ({
      url: p.url,
      error: p.parity.error,
      findings: p.parity.findings.map((v) => ({
        ruleId: v.ruleId,
        impact: v.impact,
        wcagRef: v.wcagRef,
        selector: v.element?.selector || '',
        html: (v.element?.outerHTML || '').slice(0, 300),
        count: v.count,
      })),
    })),
  };
}

// ─── Report enrichment for html.js ────────────────────────────────────────────

/**
 * Transforms unified scan results into the shape html.js expects:
 * - report.pages[].violations — unified Violation[] per page
 * - report.lighthouse — keyed by page name with { lighthouse: { mobile, desktop } }
 */
export function enrichReportForHtml(report, pageResults) {
  report = projectReportForLegacy(report);
  const lighthouseData = {};

  if (pageResults) {
    for (const pr of pageResults) {
      if (pr.lighthouseScores) {
        for (const [pageName, lhData] of Object.entries(pr.lighthouseScores)) {
          lighthouseData[pageName] = lhData;
        }
      }
    }
  } else {
    for (const page of report.pages || []) {
      const pageName = page.page || 'homepage';
      if (page.lighthouseScores && typeof page.lighthouseScores === 'object') {
        for (const [name, data] of Object.entries(page.lighthouseScores)) {
          lighthouseData[name] = data;
        }
      } else if (page.lighthouse?.lighthouse) {
        lighthouseData[pageName] = { lighthouse: page.lighthouse.lighthouse };
      }
    }
  }

  return { ...report, lighthouse: lighthouseData };
}

// ─── Main scan orchestrator ───────────────────────────────────────────────────

/** A scan without a usable instrumented build keeps the source static tracing attributed (a real file) and marks every other finding's source unavailable. */
export function markSourcesUnavailable(pageResults) {
  for (const pr of pageResults) {
    for (const v of pr.violations || []) {
      if (v.source?.file && v.source.file !== 'unknown') continue;
      v.source = { mode: 'url', method: 'unavailable' };
      delete v.sourceCandidates;
    }
  }
  return pageResults;
}

/**
 * Scans pages with bounded concurrency; one page failing never blocks the others. Progress goes to stderr.
 * Results follow the order of `pages`. options.maxTimeSec skips pages not started within the budget.
 */
export async function scanPages(pages, config, options = {}) {
  options = {
    ...options,
    linkChecker: options.linkChecker || createLinkChecker(), // each distinct link is probed once per scan
    knownRoutes: options.knownRoutes !== undefined ? options.knownRoutes
      : loadProjectRoutes(path.resolve(options.sourceRoot || PROJECT_ROOT), { pagesRoot: config.source?.pagesRoot, outDir: config.outDir }),
  };
  const concurrency = config.concurrency || 2;
  const deadline = options.maxTimeSec ? Date.now() + options.maxTimeSec * 1000 : null;
  const pageRuns = new Array(pages.length);
  let finished = 0;
  const tasks = pages.map((page, idx) => async () => {
    const started = Date.now();
    let result;
    if (deadline && started >= deadline) {
      result = buildSkippedPageResult(page);
    } else {
      try {
        result = await scanOnePage(page, config, options);
      } catch (err) {
        console.error(`  [${page.name}] ERROR: ${err.message}`);
        result = buildFailedPageResult(page, {
          reason: isTimeoutError(err) ? 'timeout' : 'scan-error',
          httpStatus: null,
          message: err.message.split('\n')[0],
        });
      }
    }
    const durationMs = Date.now() - started;
    const route = page.path || page.url || page.name;
    const label = result.failure?.reason === 'skipped' ? 'skipped' : result.status === 'failed' ? 'error' : result.status;
    pageRuns[idx] = { route, status: result.status, durationMs, attempts: result.attempts ?? 1, ...(result.phases ? { phases: result.phases } : {}), ...(result.layerRetries?.length ? { layerRetries: result.layerRetries } : {}) };
    console.error(`[${++finished}/${pages.length}] ${route} ${label} (${(durationMs / 1000).toFixed(1)}s)`);
    return result;
  });
  return { pageResults: await runWithConcurrency(tasks, concurrency), pageRuns };
}

async function runScan(pages, config, manifest, options) {
  const {
    fix, dryRun, baselineMode, useUI, isSinglePage,
    noFail, includeThirdParty, failOnViolations, gate, perfGate, seoGate, isUrlMode, sourceRoot, sessionId,
    noHydrateJobs = false,
    pageFilter = null,
  } = options;
  // Deterministic report order whatever order the pages complete in.
  pages = [...pages].sort((a, b) => String(a.path || a.url || a.name).localeCompare(String(b.path || b.url || b.name)));

  printTraceRoot({ root: sourceRoot || PROJECT_ROOT, url: options.localUrl ? pages[0]?.url : null });
  const framework = resolveAdapter(path.resolve(sourceRoot || PROJECT_ROOT));
  console.log(`\nSource framework: ${framework.id}${framework.message ? ` (${framework.message})` : ''}`);
  console.log(`Scanning ${pages.length} page(s) with concurrency ${config.concurrency || 2}...`);

  // No attested build: dist/ and the manifest are not consulted (stale or partial), so no owner is proven from them. Static tracing of the
  // source tree (the tags the templates write, the page's render tree) needs no build and still attributes; the rest stays unavailable.
  disableBuiltOutput(Boolean(options.sourceTracingUnavailable));
  const { pageResults, pageRuns } = await scanPages(pages, config, { ...options, evidenceDir: path.join(getReportsDir(), 'evidence') });
  if (options.sourceTracingUnavailable) markSourcesUnavailable(pageResults);

  const removed = await reconcileEvidence(path.join(getReportsDir(), 'evidence'), pageResults.flatMap((pr) => pr.violations || []));
  if (removed) console.log(`Evidence: removed ${removed} unreferenced screenshot${removed === 1 ? '' : 's'}`);

  // Build old-style scanResults for writeReport() (per-layer shape)
  const {
    targetFields,
    pageResults: tracedPageResults,
    resolvedSourceRoot,
    sourceDrift,
  } = deriveScanTargetAndTrace({
    pageResults,
    pages,
    sourceRoot,
    isUrlMode,
    scanAttestation: options.scanAttestation,
    manifest,
    config,
  });

  const scanResults = tracedPageResults.map((pr) => ({
    page: pr.name,
    url: pr.url,
    violations: pr.violations,
    lighthouseScores: pr.lighthouseScores,
    contentHash: pr.contentHash,
    axeSummary: pr.axeSummary,
    scannerRuns: pr.scannerRuns,
    status: pr.status,
    failure: pr.failure || null,
    ...(pr.skipped ? { skipped: pr.skipped } : {}),
  }));

  const labelContext = loadScanLabelContext();
  const reportContext = {
    ruleDemotions: labelContext.demotions,
    producer: {
      name: 'ada-scan',
      version: PACKAGE_VERSION,
      nodeVersion: process.versions.node,
    },
    target: targetFields,
    allowIncomplete: Boolean(options.allowIncomplete),
    sourceDrift,
    keepQuery: Boolean(options.keepQuery),
    agreementPolicy: config.verdict?.agreementPolicy,
    sourceTracing: {
      framework: framework.id,
      // A local scan with a source adapter attributes what it can: a confirmed finding must then name a source (see demoteUntraced).
      ...(!isUrlMode && framework.adapter ? { requireSource: true } : {}),
      ...(options.sourceTracingUnavailable ? { status: 'unavailable', reason: options.sourceTracingUnavailable } : {}),
    },
    profiles: config.profile === 'commercial-parity' ? ['standards', 'commercial-parity'] : ['standards'],
    ...(config.profile === 'commercial-parity' ? { parity: buildParityMetadata(pageResults) } : {}),
    strict: Boolean(config.scan?.strict),
    scan: {
      concurrency: config.concurrency || 2,
      ...(options.maxTimeSec ? { maxTimeSec: options.maxTimeSec } : {}),
      retries: pageRuns.reduce((n, r) => n + Math.max(0, r.attempts - 1), 0),
      pages: [...pageRuns].sort((a, b) => a.route.localeCompare(b.route)),
      ...(options.reverify === false ? {} : { reverify: summarizeReverify(pageResults.map((pr, i) => ({ route: pageRuns[i].route, reverify: pr.reverify })), { ...DEFAULT_VERIFY, ...config.verify }) }),
    },
    discovery: {
      partial: pages.some((p) => p.partial),
      warnings: discoveryWarnings,
      ...(discoveryTemplates || {}),
      pages: pages.map((p) => ({ route: p.path || p.url || p.name, source: p.source || 'config', ...(p.template ? { template: p.template } : {}) })),
    },
  };
  // The gate reads the report model (summed counts, info excluded), so build it first and attach the result.
  const prelim = buildReportBundle(scanResults, reportContext).report;
  const gatePages = tracedPageResults.map((pr) => ({ ...pr, findings: prelim.pages.find((p) => p.url === pr.url)?.findings }));
  const gateResult = evaluateGate(gatePages, config.thresholds, { perfGate, seoGate, layers: config.layers, countThirdParty: config.gate?.countThirdParty, countPlatform: config.gate?.countPlatform });
  reportContext.thresholds = gateResult;
  const { comparison, lines: comparisonLines } = buildComparison(prelim, loadComparisonBase());
  if (comparison) reportContext.comparison = comparison;
  const { report, legacyReport, latestPath, histDir } = writeReport(scanResults, reportContext);
  printConsoleSummary(report);
  console.log(comparisonLines.join('\n'));
  for (const n of [...labelContext.warnings, ...gateResult.notices]) console.warn(`Warning: ${n}`);
  for (const n of sourceDrift?.warnings || []) console.warn(`Warning: ${n}`);
  console.log(formatGate(gateResult).join('\n'));
  console.log(`Report: ${latestPath}`);
  if (options.sarif !== undefined) console.log(`SARIF: ${writeSarif(report, options.sarif)}`);

  try {
    const enriched = enrichReportForHtml(legacyReport, pageResults);
    const htmlPath = writeHtmlReport({ ...enriched, v2: report });
    console.log(`Visual report: ${htmlPath}`);
    console.log(`QA report: ${writeQaReport(report)}`);
  } catch (err) {
    console.error(`HTML report error: ${err.message}`);
  }

  if (baselineMode) {
    const baselinePath = writeBaseline(report);
    console.log(`Baseline saved: ${baselinePath}`);
  }

  if (fix) {
    const localRoot = resolvedSourceRoot || (sourceRoot ? resolveTrustedRoot(sourceRoot).localRoot : null);
    await runTrustedFixFromReport(report, {
      url: report.target?.url || null,
      localRoot,
      sessionId,
      useUI,
    });
  }

  await generateExecSummary(report).catch((err) => {
    console.warn(`ROI report warning: ${err.message}`);
  });

  const exitCode = computeExitCode(report.summary, { noFail, failOnViolations, allowIncomplete: options.allowIncomplete, gate, gateResult, countThirdParty: config.gate?.countThirdParty, countPlatform: config.gate?.countPlatform });
  if (exitCode) process.exitCode = exitCode;

  return report;
}

