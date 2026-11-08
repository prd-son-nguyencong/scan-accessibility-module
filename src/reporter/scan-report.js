import { ownerBadge } from './origin-display.js';
import { GATE_NOTE, totalsLabel } from './wording.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'fs';
import path from 'path';
import { getReportsDir, resolveReportFile } from '../utils/paths.js';
import { buildScanReportV2, projectReportV1, extractAccessScanRunMetadata, validateScanReportV2 } from './report-v2.js';
import { buildSummary } from './legacy-summary.js';
import { buildSarif } from './sarif.js';
import { compareReports, formatComparison } from './compare.js';
import { buildQaModel, renderQaHtml } from './qa-report.js';
import { loadManualStore } from './manual-checks.js';
import { loadLabels, pct, MIN_LABELS, MIN_PRECISION } from './labels.js';

export { buildSummary };


function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Write to a temp file then rename so readers never see a partial report.
function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// Millisecond timestamp; a numeric suffix keeps concurrent or rapid runs from sharing a directory.
function createHistoryDir(historyRoot) {
  mkdirSync(historyRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  for (let n = 0; ; n += 1) {
    const dir = path.join(historyRoot, n === 0 ? ts : `${ts}-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Writes scan results to latest.json (under the reports dir) and a timestamped history entry.
 */
export function buildReportBundle(scanResults, context = {}) {
  const report = buildScanReportV2(scanResults, context);
  const legacyReport = projectReportV1(report);
  return { report, legacyReport };
}

export function projectReportForLegacy(report) {
  if (report?.schemaVersion !== '2.0.0') return report;
  const legacyReport = projectReportV1(report);
  return legacyReport;
}

export function writeReport(scanResults, context = {}) {
  const REPORTS_DIR = getReportsDir();
  ensureDir(REPORTS_DIR);
  const { report, legacyReport } = buildReportBundle(scanResults, context);

  const latestPath = path.join(REPORTS_DIR, 'latest.json');
  writeFileAtomic(latestPath, JSON.stringify(report, null, 2));

  // Write to history
  const histDir = createHistoryDir(path.join(REPORTS_DIR, 'history'));
  writeFileAtomic(path.join(histDir, 'scan.json'), JSON.stringify(report, null, 2));

  return { report, legacyReport, latestPath, histDir };
}

/** Writes the SARIF 2.1.0 export to `file` (empty = <reports dir>/scan.sarif) and returns the path. */
export function writeSarif(report, file = '') {
  const target = file ? path.resolve(file) : path.join(getReportsDir(), 'scan.sarif');
  ensureDir(path.dirname(target));
  writeFileAtomic(target, JSON.stringify(buildSarif(report), null, 2));
  return target;
}

/** Writes qa-report.html and qa-report.json (T-E5.4) to the reports dir and returns the HTML path. */
export function writeQaReport(report) {
  const dir = getReportsDir();
  ensureDir(dir);
  let manual = null;
  let manualError = null;
  try {
    manual = loadManualStore(path.join(dir, 'manual-checks.json'));
  } catch (err) {
    manualError = err.message;
  }
  let labels = [];
  let labelsError = null;
  try {
    labels = loadLabels(path.join(dir, 'labels.json')).labels;
  } catch (err) {
    labelsError = err.message;
  }
  const model = buildQaModel(report, { manual, manualError, labels, labelsError });
  writeFileAtomic(path.join(dir, 'qa-report.json'), JSON.stringify(model, null, 2));
  const htmlPath = path.join(dir, 'qa-report.html');
  writeFileAtomic(htmlPath, renderQaHtml(model));
  return htmlPath;
}

/**
 * Saves current scan as the baseline later scans are compared with.
 */
export function writeBaseline(report) {
  ensureDir(getReportsDir());
  const baselinePath = path.join(getReportsDir(), 'baseline.json');
  writeFileAtomic(baselinePath, JSON.stringify(report, null, 2));
  return baselinePath;
}

/**
 * Reads a report file (latest, history entry, baseline) and validates it before anyone uses it.
 * Returns { report } or { error } with a message naming the file; never throws.
 * v2 reports get the full canonical check; the legacy v1 shape only needs a pages array.
 */
export function readReportFile(file) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `${file} is not readable JSON (${error.message})` };
  }
  if (report?.schemaVersion !== undefined && report.schemaVersion !== '2.0.0') {
    return { error: `${file} has unsupported schemaVersion ${JSON.stringify(report.schemaVersion)}` };
  }
  if (report?.schemaVersion === '2.0.0') {
    try {
      validateScanReportV2(report);
    } catch (error) {
      return { error: `${file} failed validation: ${error.message}` };
    }
  } else if (!report || !Array.isArray(report.pages) || report.pages.some((page) => !page || typeof page !== 'object')) {
    return { error: `${file} is not a scan report (no pages array)` };
  }
  return { report };
}

/**
 * Loads the baseline report if it exists and is valid; an invalid one is ignored with a warning.
 */
export function loadBaseline() {
  const baselinePath = resolveReportFile('baseline.json');
  if (!existsSync(baselinePath)) return null;
  const { report, error } = readReportFile(baselinePath);
  if (error) {
    console.warn(`Ignoring invalid baseline: ${error}. Re-run with --baseline to replace it.`);
    return null;
  }
  return report;
}

/**
 * What to compare a new scan with: the saved baseline, else the previous latest.json.
 * Call before writeReport overwrites latest.json. Returns { report, source } or { reason }.
 */
export function loadComparisonBase() {
  const baseline = loadBaseline();
  if (baseline) return { report: baseline, source: 'baseline' };
  const latestPath = path.join(getReportsDir(), 'latest.json');
  if (existsSync(latestPath)) {
    const { report, error } = readReportFile(latestPath);
    if (report) return { report, source: 'previous scan' };
    console.warn(`Ignoring unusable previous scan: ${error}`);
  }
  return { reason: 'no baseline or previous scan; run with --baseline to save one' };
}

/** The comparison to attach to a new report, or null plus the console lines saying why not. */
export function buildComparison(report, base) {
  const comparison = base.report ? compareReports(report, base.report, { source: base.source }) : null;
  if (comparison?.unusable) return { comparison: null, lines: formatComparison(null, comparison.unusable) };
  return { comparison, lines: formatComparison(comparison, base.reason) };
}

/** One line per owner with findings (occurrences), only when something is not plain site code; third-party names its vendors. */
export function ownerLines(report) {
  const counts = new Map();
  for (const f of (report.pages || []).flatMap((p) => p.findings || [])) {
    if (f.impact === 'info') continue;
    const b = ownerBadge(f.origin);
    const c = counts.get(b.key) || { n: 0, names: new Map() };
    c.n += f.count ?? 1;
    c.names.set(b.text, (c.names.get(b.text) || 0) + (f.count ?? 1));
    counts.set(b.key, c);
  }
  if (![...counts.keys()].some((k) => k !== 'site')) return [];
  return ['site', 'platform', 'third-party', 'injected', 'iframe'].filter((k) => counts.has(k)).map((k) => {
    const c = counts.get(k);
    const detail = k === 'third-party' ? ` (${[...c.names].map(([name, n]) => `${name.replace('Third-party: ', '')} ${n}`).join(', ')})` : '';
    return `Owner ${k}:`.padEnd(20) + `${c.n}${detail}`;
  });
}

export function printConsoleSummary(report) {
  const legacy = projectReportForLegacy(report);
  const { summary } = legacy;

  console.log('\nScan Summary');
  console.log('============');
  console.log(`Pages scanned:    ${summary.pagesScanned}${summary.pagesSkipped ? ` (${summary.pagesSkipped} skipped: empty or unrenderable locally)` : ''}`);
  console.log(`Total violations: ${summary.totalViolations} (${totalsLabel(summary.totalViolations, legacy.pages.reduce((n, p) => n + (p.violations || []).filter((v) => v.impact !== 'info').length, 0))})`);
  console.log(GATE_NOTE);
  const vc = report.summary?.verdictCounts;
  const dem = report.runMetadata?.ruleDemotions;
  if (dem) console.log(`!! Rule demotions: ${dem.demotedFindings} finding(s) moved to needs-review because their rule has precision below ${pct(MIN_PRECISION)} over at least ${MIN_LABELS} QA labels (${dem.rules.map((r) => `${r.ruleId} ${pct(r.precision)}, n=${r.n}`).join('; ')}).`);
  if (vc) console.log(`By confidence:    ${vc.confirmed} confirmed, ${vc.likely} likely, ${vc.needsReview} need review (only confirmed fail the gate)`);
  for (const line of ownerLines(report)) console.log(line);
  if (summary.pagesFailed || summary.pagesPartial || summary.scannerErrors) {
    console.log(`\n!! INCOMPLETE SCAN: ${summary.pagesFailed || 0} page(s) failed, ${summary.pagesPartial || 0} partial, ${summary.scannerErrors || 0} scanner error(s).`);
    console.log('!! The violation total above is not a pass.');
    if (report.summary?.pagesPartialGating === 0 && !summary.pagesFailed) console.log('!! Only supplementary layers (lighthouse, w3c) are incomplete: exit code stays 0 unless scan.strict is true.');
    for (const page of legacy.pages) {
      if (page.status === 'failed') console.log(`!!   ${page.url}: not scanned (${page.failure?.message || page.failure?.reason})`);
      else if (page.status === 'partial') {
        const reasons = report.pages.find((p) => p.url === page.url)?.partialReasons
          ?? (page.scannerRuns || []).filter((run) => ['error', 'timeout', 'skipped'].includes(run.status)).map((run) => ({ layer: run.layer, reason: run.status, gating: true }));
        console.log(`!!   ${page.url}: partial (${reasons.map((r) => `${r.layer} ${r.reason}${r.gating ? '' : ' [supplementary, not gating]'}`).join('; ')})`);
      }
    }
    if (report.runMetadata?.allowIncomplete) console.log('!! --allow-incomplete: exit code 2 suppressed.');
  }

  const accessScan = report.runMetadata?.accessScan
    || (report.schemaVersion === '2.0.0' && Array.isArray(report.scanners)
      ? extractAccessScanRunMetadata(report.scanners)
      : null);
  if (accessScan) {
    console.log('\naccessScan run metadata');
    console.log(`  Profile:      ${accessScan.profile || 'unknown'}`);
    console.log(`  Comparator:   ${accessScan.comparatorVersion || 'unknown'}`);
    console.log(`  Page runs:    ${accessScan.pageRunCount || 1}`);
    if (accessScan.execution?.aggregates) {
      const { rules, checks } = accessScan.execution.aggregates;
      console.log(`  Rule totals:  complete=${rules.complete || 0}, inapplicable=${rules.inapplicable || 0}, error=${rules.error || 0}, timeout=${rules.timeout || 0}, skipped=${rules.skipped || 0}`);
      console.log(`  Check totals: complete=${checks.complete || 0}, inapplicable=${checks.inapplicable || 0}, error=${checks.error || 0}, timeout=${checks.timeout || 0}, skipped=${checks.skipped || 0}, candidates=${checks.candidates || 0}, findings=${checks.findings || 0}`);
    }
  }

  if (summary.topViolations.length > 0) {
    console.log('\nTop violations:');
    for (const { id, count } of summary.topViolations) {
      console.log(`  ${String(count).padStart(3)}x  ${id}`);
    }
  }

  const filesWithViolations = Object.entries(summary.violationsByFile);
  if (filesWithViolations.length > 0) {
    console.log('\nAffected source files:');
    for (const [file, violations] of filesWithViolations) {
      // The label must hold for every violation in the file, so use the weakest confidence.
      const rank = { high: 3, medium: 2, low: 1 };
      const conf = violations.reduce((min, v) => ((rank[v.sourceConfidence] || 0) < (rank[min] || 0) ? v.sourceConfidence : min), violations[0]?.sourceConfidence || '');
      const confNote = conf === 'high' ? '' : conf === 'medium' ? ' (partial match)' : ' (page-level trace)';
      const occurrenceCount = violations.reduce((total, violation) => total + (violation.count || 1), 0);
      console.log(`  ${file}${confNote}  (${occurrenceCount} violation${occurrenceCount === 1 ? '' : 's'})`);
      for (const v of violations.slice(0, 5)) {
        const lineNote = v.sourceLine ? `:${v.sourceLine}` : '';
        console.log(`    [${v.impact}] ${v.ruleId}${lineNote}`);
      }
      if (violations.length > 5) console.log(`    ... and ${violations.length - 5} more`);
    }
  }

  if (summary.sourceUnavailable > 0) {
    console.log(`\nSource: unavailable (no source project) for ${summary.sourceUnavailable} violation${summary.sourceUnavailable === 1 ? '' : 's'}`);
  }

  console.log('');
}
