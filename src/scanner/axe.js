import { AxeBuilder } from '@axe-core/playwright';
import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapViolationToSource } from '../tracer/partial-map.js';
import { isTemplateDevArtifact } from '../utils/third-party.js';
import { DEFAULT_AXE_VIEWPORTS } from '../utils/config.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const PAGE_TIMEOUT_MS = 60000;

function axeNodeKey(node) {
  const target = node.target || [];
  if (target.length === 0) return node.html || '';
  const elementTag = String(node.html || '').match(/^\s*<([a-z][\w:-]*)\b/i)?.[1]?.toLowerCase() || '';
  const escapedTag = elementTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizedTarget = target.map((part) => {
    const value = String(part).trim();
    if (!escapedTag) return value;
    return value.replace(
      new RegExp(`(^|[\\s>+~,(])${escapedTag}(?=[.#])`, 'gi'),
      '$1'
    );
  });
  return JSON.stringify([elementTag, normalizedTarget]);
}

function mergeNodeViewportEvidence(existing, node, viewport) {
  if (node.html && node.html !== existing.html) {
    if (!existing.htmlSnapshots) {
      existing.htmlSnapshots = [{
        viewport: existing.viewports[0],
        html: existing.html || '',
      }];
    }
    if (!existing.htmlSnapshots.some((item) => item.viewport.name === viewport.name)) {
      existing.htmlSnapshots.push({ viewport, html: node.html });
    }
  }
  if (!existing.viewports.some((item) => item.name === viewport.name)) {
    existing.viewports.push(viewport);
  }
}

function collectRuleIds(viewportResults, field) {
  return new Set(
    viewportResults.flatMap(({ results }) => (results[field] || []).map((item) => item.id))
  );
}

function mergeAxeStatusItems(viewportResults, field, includedIds) {
  const itemsById = new Map();
  for (const { viewport, results } of viewportResults) {
    for (const item of results[field] || []) {
      if (!includedIds.has(item.id)) continue;
      const existing = itemsById.get(item.id);
      if (existing) {
        for (const node of item.nodes || []) {
          const key = axeNodeKey(node);
          const existingNode = existing.nodes.find((entry) => axeNodeKey(entry) === key);
          if (existingNode) {
            mergeNodeViewportEvidence(existingNode, node, viewport);
          } else {
            existing.nodes.push({ ...node, viewports: [viewport] });
          }
        }
        if (!existing.viewports.some((entry) => entry.name === viewport.name)) {
          existing.viewports.push(viewport);
        }
      } else {
        itemsById.set(item.id, {
          ...item,
          nodes: (item.nodes || []).map((node) => ({ ...node, viewports: [viewport] })),
          viewports: [viewport],
        });
      }
    }
  }
  return [...itemsById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeAxeViewportResults(viewportResults) {
  const violationsById = new Map();
  const nodesByRule = new Map();

  for (const { viewport, results } of viewportResults) {
    for (const violation of results.violations || []) {
      if (!violationsById.has(violation.id)) {
        violationsById.set(violation.id, { ...violation, nodes: [] });
        nodesByRule.set(violation.id, new Map());
      }

      const nodeMap = nodesByRule.get(violation.id);
      for (const node of violation.nodes || []) {
        const key = axeNodeKey(node);
        const existing = nodeMap.get(key);
        if (existing) {
          mergeNodeViewportEvidence(existing, node, viewport);
          continue;
        }

        const mergedNode = { ...node, viewports: [viewport] };
        nodeMap.set(key, mergedNode);
        violationsById.get(violation.id).nodes.push(mergedNode);
      }
    }
  }

  const violations = [...violationsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const violationIds = new Set(violations.map((item) => item.id));
  const incompleteIds = collectRuleIds(viewportResults, 'incomplete');
  const passIds = collectRuleIds(viewportResults, 'passes');
  const inapplicableIds = collectRuleIds(viewportResults, 'inapplicable');

  for (const id of violationIds) {
    passIds.delete(id);
    inapplicableIds.delete(id);
  }
  for (const id of incompleteIds) {
    passIds.delete(id);
    inapplicableIds.delete(id);
  }
  for (const id of passIds) inapplicableIds.delete(id);

  return {
    violations,
    incomplete: mergeAxeStatusItems(viewportResults, 'incomplete', incompleteIds),
    passesCount: passIds.size,
    incompleteCount: incompleteIds.size,
    inapplicableCount: inapplicableIds.size,
  };
}

export function buildAxeSummary(violations, viewportResults, {
  artifactNodeCount = 0,
  artifactViolationGroupsSkipped = 0,
} = {}) {
  const impact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const violation of violations) {
    if (violation.impact in impact) impact[violation.impact]++;
  }

  return {
    totalIssueGroups: violations.length,
    automaticIssues: violations.length,
    guidedIssues: null,
    manualIssues: null,
    bestPractice: violations.filter((item) => (item.tags || []).includes('best-practice')).length,
    affectedNodes: violations.reduce(
      (total, item) => total + (item.nodes || []).filter((node) => !node.devArtifact).length,
      0
    ),
    impact,
    artifactNodeCount,
    artifactViolationGroupsSkipped,
    viewports: viewportResults.map(({ viewport, results }) => {
      const nodesForViewport = (violation) => (violation.nodes || []).filter((node) => {
        if (node.devArtifact) return false;
        const nodeViewports = node.viewports || [];
        return nodeViewports.length === 0 || nodeViewports.some((item) => item.name === viewport.name);
      });
      return {
        ...viewport,
        issueGroups: violations.filter((violation) => nodesForViewport(violation).length > 0).length,
        affectedNodes: violations.reduce(
          (total, violation) => total + nodesForViewport(violation).length,
          0
        ),
        incomplete: (results.incomplete || []).length,
      };
    }),
    unsupportedIssueTypes: ['guided', 'manual'],
  };
}

export function filterAxeDevArtifacts(violations, {
  sourceMode = 'url',
  templateTokens,
} = {}) {
  if (
    sourceMode !== 'local' ||
    !Array.isArray(templateTokens) ||
    templateTokens.length < 2
  ) {
    return {
      violations,
      artifactNodeCount: 0,
      artifactViolationGroupsSkipped: 0,
    };
  }

  let artifactNodeCount = 0;
  const enriched = violations.map((violation) => ({
    ...violation,
    nodes: (violation.nodes || []).map((node) => {
      const devArtifact = isTemplateDevArtifact(node.html || '', templateTokens);
      if (devArtifact) artifactNodeCount++;
      return { ...node, ...(devArtifact ? { devArtifact: true } : {}) };
    }),
  }));
  const realViolations = enriched.filter(
    (violation) => violation.nodes.some((node) => !node.devArtifact)
  );

  return {
    violations: realViolations,
    artifactNodeCount,
    artifactViolationGroupsSkipped: enriched.length - realViolations.length,
  };
}

export function buildAxeEvidence(violation, node) {
  return {
    issueType: 'automatic',
    tags: [...(violation.tags || [])],
    impact: node.impact || violation.impact || null,
    help: violation.help || '',
    helpUrl: violation.helpUrl || '',
    failureSummary: node.failureSummary || '',
    ruleGroupNodeCount: (violation.nodes || []).filter((item) => !item.devArtifact).length,
    viewports: [...(node.viewports || [])],
    ...(node.htmlSnapshots ? { htmlSnapshots: [...node.htmlSnapshots] } : {}),
  };
}

export function buildAxePageMetadata(axeResult) {
  return {
    ...axeResult.summary,
    passesCount: axeResult.passesCount,
    incompleteCount: axeResult.incompleteCount,
    inapplicableCount: axeResult.inapplicableCount,
    incomplete: axeResult.incomplete,
    tags: axeResult.tags,
    testEngine: axeResult.testEngine,
    toolOptions: axeResult.toolOptions,
    timestamp: axeResult.timestamp,
  };
}

/**
 * Scans a page with axe-core for WCAG 2.2 AA violations.
 * Runs every configured viewport and merges repeated logical nodes before
 * normalization so responsive-only failures retain viewport evidence.
 * Enriches each violation node with:
 *   - source: { file, line, confidence } via partial-map tracer
 *   - devArtifact: true only in explicit local mode when configured template
 *     tokens are the node's sole content
 */
export async function scanPageWithAxe(pageUrl, config = {}, options = {}) {
  const browser = await getBrowser();
  const configuredViewports = config.axe?.viewports;
  const viewports = Array.isArray(configuredViewports) && configuredViewports.length > 0
    ? configuredViewports
    : DEFAULT_AXE_VIEWPORTS;
  const viewportResults = [];

  for (const viewport of viewports) {
    const page = await newPage(browser, {
      viewport: { width: viewport.width, height: viewport.height },
    });

    try {
      await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });
      await page.waitForTimeout(500);

      const skipRules = config.skipRules || [];
      let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
      if (skipRules.length > 0) builder = builder.disableRules(skipRules);

      const results = await builder.analyze();
      viewportResults.push({ viewport, results });
    } finally {
      await page.context().close().catch(() => {});
    }
  }

  const merged = mergeAxeViewportResults(viewportResults);
  const filtered = filterAxeDevArtifacts(merged.violations, {
    sourceMode: options.sourceMode || 'url',
    templateTokens: config.thirdParty?.devArtifactTokens,
  });
  const enrichedViolations = await Promise.all(
    filtered.violations.map(async (violation) => ({
      ...violation,
      nodes: await Promise.all(
        violation.nodes.map(async (node) => ({
          ...node,
          source: await mapViolationToSource(node, pageUrl),
        }))
      ),
    }))
  );
  const summary = buildAxeSummary(enrichedViolations, viewportResults, filtered);
  const firstResult = viewportResults[0]?.results;

  return {
    url: pageUrl,
    violations: enrichedViolations,
    incomplete: merged.incomplete,
    passesCount: merged.passesCount,
    incompleteCount: merged.incompleteCount,
    inapplicableCount: merged.inapplicableCount,
    artifactViolationsSkipped: filtered.artifactViolationGroupsSkipped,
    artifactViolationGroupsSkipped: filtered.artifactViolationGroupsSkipped,
    artifactNodeCount: filtered.artifactNodeCount,
    tags: [...WCAG_TAGS],
    testEngine: firstResult?.testEngine || null,
    toolOptions: firstResult?.toolOptions || null,
    summary,
    timestamp: new Date().toISOString(),
  };
}
