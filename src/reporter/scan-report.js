import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';

const ROOT = getProjectRoot();
const REPORTS_DIR = path.join(ROOT, 'scan-reports');
const HISTORY_DIR = path.join(REPORTS_DIR, 'history');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Writes scan results to scan-reports/latest.json and a timestamped history entry.
 */
export function writeReport(scanResults) {
  ensureDir(REPORTS_DIR);

  const report = {
    timestamp: new Date().toISOString(),
    summary: buildSummary(scanResults),
    pages: scanResults,
  };

  const latestPath = path.join(REPORTS_DIR, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(report, null, 2));

  // Write to history
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const histDir = path.join(HISTORY_DIR, ts);
  ensureDir(histDir);
  writeFileSync(path.join(histDir, 'scan.json'), JSON.stringify(report, null, 2));

  return { report, latestPath, histDir };
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

function buildSummary(scanResults) {
  let totalViolations = 0;
  const violationsByRule = {};
  const violationsByFile = {};
  const layerCounts = {
    axe: 0, lighthouse: 0, w3c: 0, accessScan: 0, links: 0,
    keyboard: 0, ariaLive: 0, focusTrap: 0, dynamicContent: 0,
    screenReader: 0,
  };

  for (const pageResult of scanResults) {
    // Unified violations format (from scanOnePage): flat array with .layer field
    if (Array.isArray(pageResult.violations) && pageResult.violations.length > 0 && !pageResult.axe) {
      for (const v of pageResult.violations) {
        totalViolations++;
        const layer = v.layer || 'axe';
        layerCounts[layer] = (layerCounts[layer] || 0) + 1;
        const ruleId = v.ruleId || v.rule || v.id || '?';
        violationsByRule[ruleId] = (violationsByRule[ruleId] || 0) + 1;
        const file = v.source?.file;
        if (file && file !== 'unknown') {
          if (!violationsByFile[file]) violationsByFile[file] = [];
          violationsByFile[file].push({
            ruleId,
            description: v.fix?.hint || v.description || '',
            impact: v.impact,
            layer,
            sourceConfidence: v.source?.confidence || 'low',
            sourceLine: v.source?.line || null,
            snippetId: v.source?.snippetId || v.element?.scanId || null,
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
        violationsByFile[file].push({ ruleId: ruleId || '?', description: v.description || '', impact: v.impact, layer: 'w3c', sourceConfidence: v.source?.confidence || 'low', sourceLine: v.source?.line || null, snippetId: v.source?.snippetId || null });
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
          violationsByFile[file].push({ ruleId: ruleId || '?', description: v.description || '', impact: v.impact, layer: v.layer || key, sourceConfidence: v.source?.confidence || 'low', sourceLine: v.source?.line || null, snippetId: v.source?.snippetId || null });
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
        violationsByFile[file].push({ ruleId: ruleId || '?', description: v.description || '', impact: v.impact, layer: 'screenReader', sourceConfidence: v.source?.confidence || 'low', sourceLine: v.source?.line || null, snippetId: v.source?.snippetId || null });
      }
    }
  }

  return {
    totalViolations,
    pagesScanned: scanResults.length,
    violationsByRule,
    violationsByFile,
    layerCounts,
    topViolations: Object.entries(violationsByRule)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([id, count]) => ({ id, count })),
  };
}

export function printConsoleSummary(report) {
  const { summary } = report;

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
      console.log(`  ${file}${confNote}  (${violations.length} violation${violations.length === 1 ? '' : 's'})`);
      for (const v of violations.slice(0, 5)) {
        const lineNote = v.sourceLine ? `:${v.sourceLine}` : '';
        console.log(`    [${v.impact}] ${v.ruleId}${lineNote}`);
      }
      if (violations.length > 5) console.log(`    ... and ${violations.length - 5} more`);
    }
  }

  console.log('');
}
