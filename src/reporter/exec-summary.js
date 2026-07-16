import { generateRoiDocuments } from './roi-doc.js';
import { loadBaseline, projectReportForLegacy } from './scan-report.js';

/**
 * Generates ROI comparison documents from the latest scan report.
 * Called by `pnpm scan:report` (--report-only flag).
 */
export async function generateExecSummary(latestReport) {
  const baselineSource = loadBaseline();
  const baseline = baselineSource ? projectReportForLegacy(baselineSource) : null;
  const latest = projectReportForLegacy(latestReport);

  if (!baseline) {
    console.log('\nNo baseline found. Run `pnpm scan:baseline` first to enable comparison.');
    console.log('Generating single-run report without comparison...');
  }

  const { comparisonPath, technicalPath } = generateRoiDocuments(latest, baseline);

  console.log(`\nROI Documents generated:`);
  console.log(`  Executive summary: ${comparisonPath}`);
  console.log(`  Technical report:  ${technicalPath}`);

  return { comparisonPath, technicalPath };
}
