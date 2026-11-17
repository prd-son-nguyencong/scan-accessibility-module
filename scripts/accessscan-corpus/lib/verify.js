import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  compareCorpusFindings,
} from '../../../src/scanner/access-scan/corpus/diff.js';
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
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { verifySeededSourceManifestAdmission } from './admission-gate.js';
import { readCorpusCaseJson } from './corpus-case-read.js';
import { getCommittedFixtureRoot } from './paths.js';
import {
  loadSourceManifest,
  SOURCE_MANIFEST_PATH,
} from './source-manifest.js';
import {
  defaultReplayScanCase,
  loadCorpusCaseContext,
} from './replay.js';

/**
 * @param {ReturnType<typeof compareCorpusFindings>} diff
 */
export function serializeCorpusDiff(diff) {
  return {
    equivalent: diff.equivalent,
    missing: diff.missing.map((entry) => entry.key),
    extra: diff.extra.map((entry) => entry.key),
    changed: diff.changed.map((pair) => ({
      expected: pair.expected.key,
      actual: pair.actual.key,
    })),
  };
}

/**
 * @typedef {object} VerifyCorpusOptions
 * @property {(context: ReturnType<typeof loadCorpusCaseContext>) => Promise<Record<string, unknown>[]>} scanCase
 * @property {boolean=} schemaOnly
 * @property {boolean=} skipSourceManifestAdmission
 * @property {string=} sourceManifestPath
 */

/**
 * @param {string} corpusRoot
 * @param {VerifyCorpusOptions=} options
 */
export async function verifyCorpus(corpusRoot = getCommittedFixtureRoot(), options = {}) {
  const resolvedRoot = path.resolve(corpusRoot);
  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestResult = validateCorpusManifest(manifest, { rootDir: resolvedRoot });

  /** @type {Array<{
   *   id: string,
   *   path: string,
   *   ok: boolean,
   *   schemaOk: boolean,
   *   errors: string[],
   *   diff: ReturnType<typeof serializeCorpusDiff> | null,
   * }>} */
  const cases = [];
  /** @type {string[]} */
  const errors = [...manifestResult.errors];

  if (!manifestResult.ok) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      errors[0],
      { errors, cases },
    );
  }

  const scanCase = options.scanCase || defaultReplayScanCase;

  for (const entry of manifest.cases) {
    const caseDir = path.join(resolvedRoot, entry.path);
    const caseResult = validateCorpusCase(caseDir);
    /** @type {ReturnType<typeof serializeCorpusDiff> | null} */
    let diffSummary = null;
    let replayOk = true;

    if (!caseResult.ok) {
      errors.push(...caseResult.errors.map((error) => `${entry.id}: ${error}`));
      cases.push({
        id: entry.id,
        path: entry.path,
        ok: false,
        schemaOk: false,
        errors: caseResult.errors,
        diff: null,
      });
      continue;
    }

    if (!options.schemaOnly) {
      const context = loadCorpusCaseContext(caseDir, resolvedRoot);
      if (!context.pageHtml) {
        errors.push(`${entry.id}: replay requires page.html`);
        cases.push({
          id: entry.id,
          path: entry.path,
          ok: false,
          schemaOk: caseResult.ok,
          errors: [`${entry.id}: replay requires page.html`],
          diff: null,
        });
        continue;
      }

      try {
        const expected = context.expected;
        const actualFindings = await scanCase(context);
        const expectedFindings = Array.isArray(expected.findings) ? expected.findings : [];
        const diff = compareCorpusFindings(expectedFindings, actualFindings);
        const metrics = computeCommercialParityMetrics(diff, {
          expectedCount: expectedFindings.length,
          actualCount: actualFindings.length,
        });
        diffSummary = {
          ...serializeCorpusDiff(diff),
          classification: serializeClassifiedCorpusDiff(
            classifyCorpusDiff(diff, { caseMeta: context.meta }),
          ),
          metrics: serializeCommercialParityMetrics(metrics),
        };
        replayOk = diff.equivalent
          && meetsCommercialParityThreshold(metrics, { precision: 1, recall: 1 });
        if (!diff.equivalent) {
          errors.push(`${entry.id}: replay findings are not equivalent to expected.json`);
        }
        if (!meetsCommercialParityThreshold(metrics, { precision: 1, recall: 1 })) {
          errors.push(`${entry.id}: commercial parity metrics below required threshold`);
        }
      } catch (error) {
        replayOk = false;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${entry.id}: ${message}`);
        if (error instanceof CorpusToolingError) {
          errors.push(`${entry.id}: ${error.errorCode}`);
        }
      }
    }

    cases.push({
      id: entry.id,
      path: entry.path,
      ok: caseResult.ok && replayOk,
      schemaOk: caseResult.ok,
      errors: replayOk ? [] : errors.filter((error) => error.startsWith(`${entry.id}:`)),
      diff: diffSummary,
    });
  }

  const replayComplete = options.schemaOnly || cases.every((entry) => entry.ok);
  const fullCorpusRegressionProven = replayComplete && !options.schemaOnly;
  let admissionOk = true;

  if (!options.skipSourceManifestAdmission) {
    try {
      const sourceManifest = loadSourceManifest(options.sourceManifestPath || SOURCE_MANIFEST_PATH);
      const admission = verifySeededSourceManifestAdmission(sourceManifest, resolvedRoot, {
        fullCorpusRegressionProven,
        requireFullCorpusRegressionProof: fullCorpusRegressionProven,
      });
      if (!admission.ok) {
        admissionOk = false;
        errors.push(...admission.errors);
      }
    } catch (error) {
      admissionOk = false;
      const message = error instanceof CorpusToolingError
        ? `${error.errorCode}: ${error.message}`
        : (error instanceof Error ? error.message : String(error));
      errors.push(`source-manifest: ${message}`);
    }
  }

  const ok = cases.every((entry) => entry.ok) && admissionOk;
  const aggregateMetrics = cases.reduce((summary, caseEntry) => {
    if (!caseEntry.diff?.metrics) return summary;
    summary.truePositives += caseEntry.diff.metrics.truePositives;
    summary.falsePositives += caseEntry.diff.metrics.falsePositives;
    summary.falseNegatives += caseEntry.diff.metrics.falseNegatives;
    summary.expectedCount += caseEntry.diff.metrics.expectedCount;
    summary.actualCount += caseEntry.diff.metrics.actualCount;
    return summary;
  }, {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    expectedCount: 0,
    actualCount: 0,
  });
  const aggregatePrecision = aggregateMetrics.actualCount === 0
    ? (aggregateMetrics.expectedCount === 0 ? 1 : 0)
    : aggregateMetrics.truePositives / aggregateMetrics.actualCount;
  const aggregateRecall = aggregateMetrics.expectedCount === 0
    ? (aggregateMetrics.actualCount === 0 ? 1 : 0)
    : aggregateMetrics.truePositives / aggregateMetrics.expectedCount;
  const aggregateMeetsThreshold = meetsCommercialParityThreshold({
    ...aggregateMetrics,
    precision: aggregatePrecision,
    recall: aggregateRecall,
  }, { precision: 1, recall: 1 });

  if (!ok) {
    return {
      ok: false,
      corpusRoot: resolvedRoot,
      cases,
      errors,
      aggregate: {
        ...aggregateMetrics,
        precision: Number(aggregatePrecision.toFixed(6)),
        recall: Number(aggregateRecall.toFixed(6)),
        meetsThreshold: aggregateMeetsThreshold,
      },
    };
  }

  if (!aggregateMeetsThreshold) {
    return {
      ok: false,
      corpusRoot: resolvedRoot,
      cases,
      errors: [...errors, 'aggregate: commercial parity metrics below required threshold'],
      aggregate: {
        ...aggregateMetrics,
        precision: Number(aggregatePrecision.toFixed(6)),
        recall: Number(aggregateRecall.toFixed(6)),
        meetsThreshold: false,
      },
    };
  }

  return {
    ok: true,
    corpusRoot: resolvedRoot,
    cases,
    errors,
    aggregate: {
      ...aggregateMetrics,
      precision: Number(aggregatePrecision.toFixed(6)),
      recall: Number(aggregateRecall.toFixed(6)),
      meetsThreshold: true,
    },
  };
}

/**
 * @param {string} caseDir
 * @param {Record<string, unknown>[]} actualFindings
 * @returns {{
 *   ok: boolean,
 *   equivalent: boolean,
 *   caseDir: string,
 *   diff: ReturnType<typeof compareCorpusFindings>,
 * }}
 */
export function verifyCorpusCaseDiff(caseDir, actualFindings = []) {
  const resolved = path.resolve(caseDir);
  const validation = validateCorpusCase(resolved);
  if (!validation.ok) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      validation.errors[0],
      { errors: validation.errors },
    );
  }

  const expected = readCorpusCaseJson(resolved, 'expected.json', path.dirname(path.dirname(resolved)));
  const diff = compareCorpusFindings(
    Array.isArray(expected.findings) ? expected.findings : [],
    actualFindings,
  );

  return {
    ok: diff.equivalent,
    equivalent: diff.equivalent,
    caseDir: resolved,
    diff,
  };
}
