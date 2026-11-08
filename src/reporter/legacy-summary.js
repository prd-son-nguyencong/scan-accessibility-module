// The one summary builder for legacy (v1-shaped) pages; projectReportV1 and scan-report both use it.
export function buildSummary(scanResults) {
  let totalViolations = 0;
  let pagesFailed = 0;
  let pagesPartial = 0;
  let scannerErrors = 0;
  const violationsByRule = {};
  const violationsByFile = {};
  let sourceUnavailable = 0;
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
    if (pageResult.status === 'failed') pagesFailed++;
    else if (pageResult.status === 'partial') pagesPartial++;
    scannerErrors += (pageResult.scannerRuns || [])
      .filter((run) => run.status === 'error' || run.status === 'timeout').length;
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
        if (v.impact === 'info') continue; // informational only; never part of totals (same rule as the v2 summary)
        const occurrenceCount = Number.isInteger(v.count) && v.count > 0 ? v.count : 1;
        totalViolations += occurrenceCount;
        const layer = v.layer || 'axe';
        layerCounts[layer] = (layerCounts[layer] || 0) + occurrenceCount;
        const ruleId = v.ruleId || v.rule || v.id || '?';
        violationsByRule[ruleId] = (violationsByRule[ruleId] || 0) + occurrenceCount;
        const file = v.source?.file;
        if (v.source?.method === 'no-source-project') sourceUnavailable += occurrenceCount;
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
    pagesFailed,
    pagesPartial,
    scannerErrors,
    violationsByRule,
    violationsByFile,
    sourceUnavailable,
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
