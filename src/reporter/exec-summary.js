import { generateRoiDocuments } from './roi-doc.js';
import { projectReportForLegacy } from './scan-report.js';

/**
 * Generates the summary documents from the latest scan report.
 * The comparison (fixed / remaining / new by stableId) was computed at scan time and travels in the report.
 * Called by `pnpm scan:report` (--report-only flag).
 */
export async function generateExecSummary(latestReport) {
  const latest = projectReportForLegacy(latestReport);

  if (!latest.comparison) {
    console.log('\nNo comparison in this scan (no baseline or previous scan). Run `pnpm scan:baseline` to save one.');
  }

  const { comparisonPath, technicalPath } = generateRoiDocuments(latest);

  console.log(`\nSummary documents generated:`);
  console.log(`  Executive summary: ${comparisonPath}`);
  console.log(`  Technical report:  ${technicalPath}`);

  return { comparisonPath, technicalPath };
}
