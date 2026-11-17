import { readFileSync } from 'node:fs';
import path from 'node:path';

import { compareCorpusFindings } from '../../../src/scanner/access-scan/corpus/diff.js';
import {
  classifyCorpusDiff,
  serializeClassifiedCorpusDiff,
} from '../../../src/scanner/access-scan/corpus/delta-classification.js';
import {
  computeCommercialParityMetrics,
  meetsCommercialParityThreshold,
  serializeCommercialParityMetrics,
} from '../../../src/scanner/access-scan/corpus/parity-metrics.js';
import {
  validateCorpusCase,
  validateCorpusManifest,
} from '../../../src/scanner/access-scan/corpus/schema.js';
import { getCommittedFixtureRoot } from './paths.js';
import {
  defaultReplayScanCase,
  loadCorpusCaseContext,
} from './replay.js';
import { serializeCorpusDiff } from './verify.js';

/**
 * @typedef {object} CorpusCaseDifferential
 * @property {string} id
 * @property {string} path
 * @property {boolean} ok
 * @property {boolean} schemaOk
 * @property {boolean=} replaySkipped
 * @property {string[]=} errors
 * @property {ReturnType<typeof serializeCorpusDiff> | null} diff
 * @property {ReturnType<typeof serializeClassifiedCorpusDiff> | null} classification
 * @property {ReturnType<typeof serializeCommercialParityMetrics> | null} metrics
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function deterministicScanErrorCode(error) {
  if (error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string') {
    return error.errorCode;
  }
  return 'scan_failure';
}

/**
 * @param {string} corpusRoot
 * @param {{
 *   scanCase?: typeof defaultReplayScanCase,
 *   schemaOnly?: boolean,
 * }=} options
 */
export async function evaluateCorpusDifferentials(
  corpusRoot = getCommittedFixtureRoot(),
  options = {},
) {
  const resolvedRoot = path.resolve(corpusRoot);
  const manifest = JSON.parse(readFileSync(path.join(resolvedRoot, 'manifest.json'), 'utf8'));
  const manifestResult = validateCorpusManifest(manifest, { rootDir: resolvedRoot });
  if (!manifestResult.ok) {
    throw new Error(manifestResult.errors.join('; '));
  }

  const scanCase = options.scanCase || defaultReplayScanCase;
  /** @type {CorpusCaseDifferential[]} */
  const cases = [];

  for (const entry of manifest.cases) {
    const caseDir = path.join(resolvedRoot, entry.path);
    const caseValidation = validateCorpusCase(caseDir);

    if (!caseValidation.ok) {
      cases.push({
        id: entry.id,
        path: entry.path,
        ok: false,
        schemaOk: false,
        errors: caseValidation.errors,
        diff: null,
        classification: null,
        metrics: null,
      });
      continue;
    }

    if (options.schemaOnly) {
      cases.push({
        id: entry.id,
        path: entry.path,
        ok: true,
        schemaOk: true,
        replaySkipped: true,
        diff: null,
        classification: null,
        metrics: null,
      });
      continue;
    }

    const context = loadCorpusCaseContext(caseDir);
    if (!context.pageHtml) {
      cases.push({
        id: entry.id,
        path: entry.path,
        ok: false,
        schemaOk: true,
        errors: ['replay_requires_page_html'],
        diff: null,
        classification: null,
        metrics: null,
      });
      continue;
    }

    const expectedFindings = Array.isArray(context.expected.findings)
      ? context.expected.findings
      : [];

    try {
      const actualFindings = await scanCase(context);
      const diff = compareCorpusFindings(expectedFindings, actualFindings);
      const classified = classifyCorpusDiff(diff, { caseMeta: context.meta });
      const metrics = computeCommercialParityMetrics(diff, {
        expectedCount: expectedFindings.length,
        actualCount: actualFindings.length,
      });
      const meetsThreshold = meetsCommercialParityThreshold(metrics, { precision: 1, recall: 1 });

      cases.push({
        id: entry.id,
        path: entry.path,
        ok: diff.equivalent && meetsThreshold,
        schemaOk: true,
        diff: serializeCorpusDiff(diff),
        classification: serializeClassifiedCorpusDiff(classified),
        metrics: serializeCommercialParityMetrics(metrics),
      });
    } catch (error) {
      cases.push({
        id: entry.id,
        path: entry.path,
        ok: false,
        schemaOk: true,
        errors: [deterministicScanErrorCode(error)],
        diff: null,
        classification: null,
        metrics: null,
      });
    }
  }

  const replayedCases = cases.filter((caseResult) => caseResult.metrics != null);
  const aggregate = replayedCases.reduce((summary, caseResult) => {
    summary.truePositives += caseResult.metrics.truePositives;
    summary.falsePositives += caseResult.metrics.falsePositives;
    summary.falseNegatives += caseResult.metrics.falseNegatives;
    summary.expectedCount += caseResult.metrics.expectedCount;
    summary.actualCount += caseResult.metrics.actualCount;
    for (const [category, count] of Object.entries(caseResult.classification.counts)) {
      summary.deltaCounts[category] = (summary.deltaCounts[category] || 0) + count;
    }
    return summary;
  }, {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    expectedCount: 0,
    actualCount: 0,
    deltaCounts: /** @type {Record<string, number>} */ ({}),
  });

  const precision = aggregate.actualCount === 0
    ? (aggregate.expectedCount === 0 ? 1 : 0)
    : aggregate.truePositives / aggregate.actualCount;
  const recall = aggregate.expectedCount === 0
    ? (aggregate.actualCount === 0 ? 1 : 0)
    : aggregate.truePositives / aggregate.expectedCount;
  const aggregateMetrics = {
    ...aggregate,
    precision: Number(precision.toFixed(6)),
    recall: Number(recall.toFixed(6)),
  };
  const aggregateMeetsThreshold = replayedCases.length > 0
    && meetsCommercialParityThreshold({
      ...aggregateMetrics,
      precision,
      recall,
    }, { precision: 1, recall: 1 });

  return {
    ok: cases.every((caseResult) => caseResult.ok) && (options.schemaOnly || aggregateMeetsThreshold),
    corpusRoot: resolvedRoot,
    caseCount: cases.length,
    cases,
    aggregate: options.schemaOnly
      ? null
      : {
        ...aggregateMetrics,
        meetsThreshold: aggregateMeetsThreshold,
      },
  };
}
