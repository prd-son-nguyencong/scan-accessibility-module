import { generateRoiDocuments } from './roi-doc.js';
import { loadBaseline } from './scan-report.js';

/**
 * Generates ROI comparison documents from the latest scan report.
 * Called by `pnpm scan:report` (--report-only flag).
 */
export async function generateExecSummary(latestReport) {
  const baseline = loadBaseline();

  if (!baseline) {
    console.log('\nNo baseline found. Run `pnpm scan:baseline` first to enable comparison.');
    console.log('Generating single-run report without comparison...');
  }

  const { comparisonPath, technicalPath } = generateRoiDocuments(latestReport, baseline);

  console.log(`\nROI Documents generated:`);
  console.log(`  Executive summary: ${comparisonPath}`);
  console.log(`  Technical report:  ${technicalPath}`);

  return { comparisonPath, technicalPath };
}
