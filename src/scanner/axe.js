import { AxeBuilder } from '@axe-core/playwright';
import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapViolationToSource } from '../tracer/partial-map.js';
import { isTemplateDevArtifact } from '../utils/third-party.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const PAGE_TIMEOUT_MS = 60000;

/**
 * Scans a page with axe-core for WCAG 2.2 AA violations.
 * Enriches each violation node with:
 *   - source: { file, line, confidence } via partial-map tracer
 *   - devArtifact: true when the violation is caused by Paradox template tokens
 *     (empty in dev, populated in production — not a real violation)
 */
export async function scanPageWithAxe(pageUrl, config = {}) {
  const browser = await getBrowser();
  const page = await newPage(browser);

  try {
    await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });

    // Wait for JS-driven rendering to settle
    await page.waitForTimeout(500);

    const skipRules = config.skipRules || [];
    let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
    if (skipRules.length > 0) builder = builder.disableRules(skipRules);

    const results = await builder.analyze();

    // Enrich violations with source tracing + dev-artifact flag
    const enrichedViolations = await Promise.all(
      results.violations.map(async (violation) => {
        const enrichedNodes = await Promise.all(
          violation.nodes.map(async (node) => {
            const source = await mapViolationToSource(node, pageUrl);
            const devArtifact = isTemplateDevArtifact(node.html || '');
            return { ...node, source, ...(devArtifact ? { devArtifact: true } : {}) };
          })
        );
        return { ...violation, nodes: enrichedNodes };
      })
    );

    // Filter out violations where ALL nodes are dev artifacts
    // (keep violations that have at least one real node)
    const realViolations = enrichedViolations.filter(
      (v) => v.nodes.some((n) => !n.devArtifact)
    );
    const artifactCount = enrichedViolations.length - realViolations.length;

    return {
      url: pageUrl,
      violations: realViolations,
      artifactViolationsSkipped: artifactCount,
      passesCount: results.passes.length,
      incompleteCount: results.incomplete.length,
      inapplicableCount: results.inapplicable.length,
      timestamp: new Date().toISOString(),
    };
  } finally {
    await page.context().close().catch(() => {});
  }
}
