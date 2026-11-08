import path from 'node:path';

import { classifyCorpusDiff } from '../../../src/scanner/access-scan/corpus/delta-classification.js';
import { computeCommercialParityMetrics } from '../../../src/scanner/access-scan/corpus/parity-metrics.js';
import { resolveCorpusCaseDir } from './corpus-case-dir.js';
import {
  assertBlockedEntriesIsolated,
  assertManifestEntryDriftEligible,
  verifySeededSourceManifestAdmission,
} from './admission-gate.js';
import { normalizeSanitizedDriftError, sanitizeDiagnosticText } from './drift-error.js';
import { evaluateCorpusDrift } from './drift.js';
import { getCommittedFixtureRoot } from './paths.js';
import { captureLiveStableDriftCandidate } from './live-drift-capture.js';
import { loadCorpusCaseContext } from './replay.js';
import { loadSourceManifest } from './source-manifest.js';
import { validateSourceManifestUrl } from './source-url-policy.js';
import { serializeCorpusDiff, verifyCorpus } from './verify.js';
import { serializeClassifiedCorpusDiff } from '../../../src/scanner/access-scan/corpus/delta-classification.js';
import { serializeCommercialParityMetrics } from '../../../src/scanner/access-scan/corpus/parity-metrics.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';

/**
 * @typedef {object} DriftCaptureResult
 * @property {Record<string, unknown>} snapshot
 * @property {Record<string, unknown>[]} findings
 * @property {'scanner-vs-frozen-oracle'=} driftBasis
 */

/**
 * @typedef {object} ManifestDriftCaseResult
 * @property {string} caseId
 * @property {boolean} ok
 * @property {boolean | null=} snapshotDrift
 * @property {boolean | null=} findingsEquivalent
 * @property {string | null=} errorCode
 * @property {string | null=} message
 * @property {'scanner-vs-frozen-oracle'=} driftBasis
 * @property {{ committed: string | null, candidate: string | null } | null=} snapshotIdentity
 * @property {ReturnType<typeof serializeCorpusDiff> | null=} diff
 * @property {ReturnType<typeof serializeClassifiedCorpusDiff> | null=} classification
 * @property {ReturnType<typeof serializeCommercialParityMetrics> | null=} metrics
 */

/**
 * @param {{ sourceUrl: string, context: ReturnType<typeof loadCorpusCaseContext> }} request
 * @returns {Promise<DriftCaptureResult>}
 */
export async function captureLiveDriftCandidate(request) {
  const outcome = await captureLiveStableDriftCandidate(request);
  return {
    snapshot: outcome.snapshot,
    findings: outcome.findings,
    driftBasis: outcome.driftBasis,
  };
}

/**
 * @param {{
 *   entry: Record<string, unknown>,
 *   corpusRoot: string,
 *   captureEntry?: (request: {
 *     entry: Record<string, unknown>,
 *     corpusRoot: string,
 *     sourceUrl: string,
 *     context: ReturnType<typeof loadCorpusCaseContext>,
 *   }) => Promise<DriftCaptureResult>,
 * }} request
 * @returns {Promise<ManifestDriftCaseResult>}
 */
export async function evaluateManifestEntryDrift(request) {
  const corpusRoot = path.resolve(request.corpusRoot);
  const entry = request.entry;
  const caseId = String(entry.caseId || entry.id);

  try {
    assertManifestEntryDriftEligible(entry);
    const caseDir = resolveCorpusCaseDir(corpusRoot, caseId);
    const context = loadCorpusCaseContext(caseDir, corpusRoot);
    const sourceUrl = await validateSourceManifestUrl(String(entry.sourceUrl || ''));

    const captureEntry = request.captureEntry || (async (captureRequest) => (
      captureLiveDriftCandidate({
        sourceUrl: captureRequest.sourceUrl,
        context: captureRequest.context,
      })
    ));

    const candidate = await captureEntry({
      entry,
      corpusRoot,
      sourceUrl,
      context,
    });

    const drift = await evaluateCorpusDrift({
      caseId,
      corpusRoot,
      snapshot: candidate.snapshot,
      actualFindings: candidate.findings,
    });

    const classified = classifyCorpusDiff(drift.diff, {
      caseMeta: {
        ...context.meta,
        captureMode: 'scanner-drift',
      },
    });
    const metrics = computeCommercialParityMetrics(drift.diff, {
      expectedCount: Array.isArray(context.expected.findings) ? context.expected.findings.length : 0,
      actualCount: candidate.findings.length,
    });

    return {
      caseId,
      ok: drift.ok,
      snapshotDrift: drift.snapshotDrift,
      findingsEquivalent: drift.findingsEquivalent,
      errorCode: null,
      message: null,
      driftBasis: candidate.driftBasis || 'scanner-vs-frozen-oracle',
      snapshotIdentity: drift.snapshotIdentity,
      diff: serializeCorpusDiff(drift.diff),
      classification: serializeClassifiedCorpusDiff(classified),
      metrics: serializeCommercialParityMetrics(metrics),
    };
  } catch (error) {
    const normalized = normalizeSanitizedDriftError(error);
    return {
      caseId,
      ok: false,
      snapshotDrift: null,
      findingsEquivalent: null,
      errorCode: normalized.errorCode,
      message: normalized.message,
      driftBasis: 'scanner-vs-frozen-oracle',
      snapshotIdentity: null,
      diff: null,
      classification: null,
      metrics: null,
    };
  }
}

/**
 * @param {{
 *   manifest?: Record<string, unknown>,
 *   manifestPath?: string,
 *   corpusRoot?: string,
 *   skipFrozenRegression?: boolean,
 *   verifyCorpusFn?: typeof verifyCorpus,
 *   captureEntry?: (request: {
 *     entry: Record<string, unknown>,
 *     corpusRoot: string,
 *     sourceUrl: string,
 *     context: ReturnType<typeof loadCorpusCaseContext>,
 *   }) => Promise<DriftCaptureResult>,
 * }} options
 */
export async function evaluateCorpusDriftAll(options = {}) {
  const corpusRoot = path.resolve(options.corpusRoot || getCommittedFixtureRoot());
  const manifest = options.manifest || loadSourceManifest(options.manifestPath);
  const verifyCorpusFn = options.verifyCorpusFn || verifyCorpus;

  assertBlockedEntriesIsolated(manifest, corpusRoot);

  const preAdmission = verifySeededSourceManifestAdmission(manifest, corpusRoot, {
    fullCorpusRegressionProven: false,
  });
  if (!preAdmission.ok) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      preAdmission.errors[0],
      { errors: preAdmission.errors },
    );
  }

  if (!options.skipFrozenRegression) {
    const regression = await verifyCorpusFn(corpusRoot, {
      sourceManifestPath: options.manifestPath,
      skipSourceManifestAdmission: true,
    });
    if (!regression.ok) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
        regression.errors[0] || 'Frozen corpus regression failed before live drift navigation',
        { errors: regression.errors },
      );
    }

    const postAdmission = verifySeededSourceManifestAdmission(manifest, corpusRoot, {
      fullCorpusRegressionProven: true,
      requireFullCorpusRegressionProof: true,
    });
    if (!postAdmission.ok) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
        postAdmission.errors[0],
        { errors: postAdmission.errors },
      );
    }
  }

  const entries = manifest.entries
    .filter((entry) => entry.seedStatus === 'seeded')
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));

  /** @type {ManifestDriftCaseResult[]} */
  const cases = [];
  for (const entry of entries) {
    cases.push(await evaluateManifestEntryDrift({
      entry,
      corpusRoot,
      captureEntry: options.captureEntry,
    }));
  }

  const driftCount = cases.filter((entry) => entry.ok === false && !entry.errorCode).length;
  const errorCount = cases.filter((entry) => Boolean(entry.errorCode)).length;
  const ok = driftCount === 0 && errorCount === 0;
  const observedExitCode = ok ? 0 : 1;

  return {
    ok,
    observedExitCode,
    caseCount: cases.length,
    driftCount,
    errorCount,
    driftBasis: 'scanner-vs-frozen-oracle',
    cases,
  };
}
