import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';
import { buildScanReportV2, projectReportV1 } from './report-v2.js';

const ROOT = getProjectRoot();
const REPORTS_DIR = path.join(ROOT, 'scan-reports');
const HISTORY_DIR = path.join(REPORTS_DIR, 'history');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Writes scan results to scan-reports/latest.json and a timestamped history entry.
 */
export function buildReportBundle(scanResults, context = {}) {
  const report = buildScanReportV2(scanResults, context);
  const legacyReport = projectReportV1(report);
  legacyReport.summary = buildSummary(legacyReport.pages);
  return { report, legacyReport };
}

export function projectReportForLegacy(report) {
  if (report?.schemaVersion !== '2.0.0') return report;
  const legacyReport = projectReportV1(report);
  legacyReport.summary = buildSummary(legacyReport.pages);
  return legacyReport;
}

export function writeReport(scanResults, context = {}) {
  ensureDir(REPORTS_DIR);
  const { report, legacyReport } = buildReportBundle(scanResults, context);

  const latestPath = path.join(REPORTS_DIR, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(report, null, 2));

  // Write to history
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const histDir = path.join(HISTORY_DIR, ts);
  ensureDir(histDir);
  writeFileSync(path.join(histDir, 'scan.json'), JSON.stringify(report, null, 2));

  return { report, legacyReport, latestPath, histDir };
}

/**
 * Saves current scan as the ROI baseline.
 */
export function writeBaseline(report) {
  ensureDir(REPORTS_DIR);
  const baselinePath = path.join(REPORTS_DIR, 'baseline.json');
  writeFileSync(baselinePath, JSON.stringify(report, null, 2));
  return baselinePath;
}

/**
 * Loads the baseline report if it exists.
 */
export function loadBaseline() {
  const baselinePath = path.join(REPORTS_DIR, 'baseline.json');
  if (!existsSync(baselinePath)) return null;
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return null;
  }
}

export function buildSummary(scanResults) {
  let totalViolations = 0;
  const violationsByRule = {};
  const violationsByFile = {};
  const axe = {
    pages: 0,
    totalIssueGroups: 0,
    automaticIssues: 0,
    guidedIssues: null,
    manualIssues: null,
    bestPractice: 0,
    affectedNodes: 0,
    incompleteResults: 0,
    artifactNodeCount: 0,
    artifactViolationGroupsSkipped: 0,
    impact: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    viewportRuns: 0,
    viewportMatrix: [],
    unsupportedIssueTypes: [],
    tags: [],
    engines: [],
  };
  const layerCounts = {
    axe: 0, lighthouse: 0, w3c: 0, accessScan: 0, links: 0,
    keyboard: 0, ariaLive: 0, focusTrap: 0, dynamicContent: 0,
    screenReader: 0,
  };

  for (const pageResult of scanResults) {
    if (pageResult.axeSummary) {
      const pageAxe = pageResult.axeSummary;
      axe.pages++;
      axe.totalIssueGroups += pageAxe.totalIssueGroups || 0;
      axe.automaticIssues += pageAxe.automaticIssues || 0;
      axe.bestPractice += pageAxe.bestPractice || 0;
      axe.affectedNodes += pageAxe.affectedNodes || 0;
      axe.incompleteResults += pageAxe.incompleteCount || 0;
      axe.artifactNodeCount += pageAxe.artifactNodeCount || 0;
      axe.artifactViolationGroupsSkipped += pageAxe.artifactViolationGroupsSkipped || 0;
      axe.viewportRuns += pageAxe.viewports?.length || 0;
      for (const viewport of pageAxe.viewports || []) {
        const normalized = {
          name: viewport.name,
          width: viewport.width,
          height: viewport.height,
        };
        if (!axe.viewportMatrix.some((item) => (
          item.name === normalized.name &&
          item.width === normalized.width &&
          item.height === normalized.height
        ))) {
          axe.viewportMatrix.push(normalized);
        }
      }
      for (const issueType of pageAxe.unsupportedIssueTypes || []) {
        if (!axe.unsupportedIssueTypes.includes(issueType)) {
          axe.unsupportedIssueTypes.push(issueType);
        }
      }
      for (const tag of pageAxe.tags || []) {
        if (!axe.tags.includes(tag)) axe.tags.push(tag);
      }
      if (
        pageAxe.testEngine &&
        !axe.engines.some((engine) => (
          engine.name === pageAxe.testEngine.name &&
          engine.version === pageAxe.testEngine.version
        ))
      ) {
        axe.engines.push(pageAxe.testEngine);
      }
      for (const impact of Object.keys(axe.impact)) {
        axe.impact[impact] += pageAxe.impact?.[impact] || 0;
      }
      if (typeof pageAxe.guidedIssues === 'number') {
        axe.guidedIssues = (axe.guidedIssues || 0) + pageAxe.guidedIssues;
      }
      if (typeof pageAxe.manualIssues === 'number') {
        axe.manualIssues = (axe.manualIssues || 0) + pageAxe.manualIssues;
      }
    }

    // Unified violations format (from scanOnePage): flat array with .layer field
    if (Array.isArray(pageResult.violations) && pageResult.violations.length > 0 && !pageResult.axe) {
      for (const v of pageResult.violations) {
        const occurrenceCount = Number.isInteger(v.count) && v.count > 0 ? v.count : 1;
        totalViolations += occurrenceCount;
        const layer = v.layer || 'axe';
        layerCounts[layer] = (layerCounts[layer] || 0) + occurrenceCount;
        const ruleId = v.ruleId || v.rule || v.id || '?';
        violationsByRule[ruleId] = (violationsByRule[ruleId] || 0) + occurrenceCount;
        const file = v.source?.file;
        if (file && file !== 'unknown') {
          if (!violationsByFile[file]) violationsByFile[file] = [];
          violationsByFile[file].push({
            ruleId,
            description: v.fix?.hint || v.description || '',
            impact: v.impact,
            layer,
            sourceConfidence: v.source?.confidence || 'unknown',
            sourceLine: v.source?.line || null,
            snippetId: v.source?.snippetId || v.element?.scanId || null,
            count: occurrenceCount,
          });
        }
      }
      continue;
    }

    // Legacy per-layer format (from old runScan)
    for (const violation of pageResult.axe?.violations || []) {
      const realNodes = (violation.nodes || []).filter((n) => !n.devArtifact);
      totalViolations += realNodes.length;
      violationsByRule[violation.id] = (violationsByRule[violation.id] || 0) + realNodes.length;
      layerCounts.axe += realNodes.length;

      for (const node of realNodes) {
        const file = node.source?.file || 'unknown';
        if (!violationsByFile[file]) violationsByFile[file] = [];
        violationsByFile[file].push({
          ruleId: violation.id,
          description: violation.description,
          impact: violation.impact,
          layer: 'axe',
          target: Array.isArray(node.target) ? node.target.join(' ') : String(node.target),
          sourceConfidence: node.source?.confidence || 'unknown',
          sourceLine: node.source?.line || null,
          snippetId: node.source?.snippetId || null,
        });
      }
    }

    for (const v of pageResult.lighthouse?.violations || []) {
      if (v.impact === 'info') continue;
      totalViolations++;
      layerCounts.lighthouse++;
      violationsByRule[v.rule] = (violationsByRule[v.rule] || 0) + 1;
    }

    for (const v of pageResult.w3c?.violations || []) {
      totalViolations++;
      layerCounts.w3c++;
      const ruleId = v.rule || v.id;
      if (ruleId) violationsByRule[ruleId] = (violationsByRule[ruleId] || 0) + 1;
      const file = v.source?.file;
      if (file && file !== 'unknown') {
        if (!violationsByFile[file]) violationsByFile[file] = [];
        violationsByFile[file].push({ ruleId: ruleId || '?', description: v.description || '', impact: v.impact, layer: 'w3c', sourceConfidence: v.source?.confidence || 'unknown', sourceLine: v.source?.line || null, snippetId: v.source?.snippetId || null });
      }
    }

    for (const key of ['keyboard', 'ariaLive', 'focusTrap', 'dynamicContent']) {
      for (const v of pageResult[key]?.violations || []) {
        totalViolations++;
        layerCounts[key]++;
        const ruleId = v.rule || v.id;
        if (ruleId) violationsByRule[ruleId] = (violationsByRule[ruleId] || 0) + 1;
        const file = v.source?.file;
        if (file && file !== 'unknown') {
          if (!violationsByFile[file]) violationsByFile[file] = [];
          violationsByFile[file].push({ ruleId: ruleId || '?', description: v.description || '', impact: v.impact, layer: v.layer || key, sourceConfidence: v.source?.confidence || 'unknown', sourceLine: v.source?.line || null, snippetId: v.source?.snippetId || null });
        }
      }
    }

    for (const v of pageResult.screenReader?.violations || []) {
      totalViolations++;
      layerCounts.screenReader++;
      const ruleId = v.rule || v.id;
      if (ruleId) violationsByRule[ruleId] = (violationsByRule[ruleId] || 0) + 1;
      const file = v.source?.file;
      if (file && file !== 'unknown') {
        if (!violationsByFile[file]) violationsByFile[file] = [];
        violationsByFile[file].push({ ruleId: ruleId || '?', description: v.description || '', impact: v.impact, layer: 'screenReader', sourceConfidence: v.source?.confidence || 'unknown', sourceLine: v.source?.line || null, snippetId: v.source?.snippetId || null });
      }
    }
  }

  return {
    totalViolations,
    pagesScanned: scanResults.length,
    violationsByRule,
    violationsByFile,
    layerCounts,
    axe: axe.pages > 0
      ? {
          ...axe,
          unsupportedIssueTypes: axe.unsupportedIssueTypes.sort(),
          tags: axe.tags.sort(),
        }
      : null,
    topViolations: Object.entries(violationsByRule)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([id, count]) => ({ id, count })),
  };
}

export function printConsoleSummary(report) {
  const { summary } = projectReportForLegacy(report);

  console.log('\nScan Summary');
  console.log('============');
  console.log(`Pages scanned:    ${summary.pagesScanned}`);
  console.log(`Total violations: ${summary.totalViolations}`);

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
      const conf = violations[0]?.sourceConfidence || '';
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

  console.log('');
}
