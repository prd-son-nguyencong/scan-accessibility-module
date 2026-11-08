import { CORPUS_COMPARATOR_VERSION, CORPUS_SCHEMA_VERSION } from '../../../src/scanner/access-scan/corpus/constants.js';
import {
  classifyCorpusDiff,
  serializeClassifiedCorpusDiff,
} from '../../../src/scanner/access-scan/corpus/delta-classification.js';
import {
  computeCommercialParityMetrics,
  serializeCommercialParityMetrics,
} from '../../../src/scanner/access-scan/corpus/parity-metrics.js';
import { serializeCorpusDiff } from './verify.js';

/**
 * @param {Record<string, unknown>} caseResult
 */
export function serializeDriftCaseResult(caseResult = {}) {
  return {
    caseId: caseResult.caseId,
    ok: Boolean(caseResult.ok),
    snapshotDrift: caseResult.snapshotDrift ?? null,
    findingsEquivalent: caseResult.findingsEquivalent ?? null,
    errorCode: caseResult.errorCode || null,
    message: caseResult.message ? String(caseResult.message) : null,
    driftBasis: caseResult.driftBasis || null,
    snapshotIdentity: caseResult.snapshotIdentity || null,
    diff: caseResult.diff || null,
    classification: caseResult.classification || null,
    metrics: caseResult.metrics || null,
  };
}

/**
 * @param {Record<string, unknown>} result
 */
export function buildDriftArtifactPayload(result = {}) {
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    comparatorVersion: CORPUS_COMPARATOR_VERSION,
    command: 'corpus:drift',
    mode: 'manifest-all',
    ok: Boolean(result.ok),
    observedExitCode: Number(result.observedExitCode ?? (result.ok ? 0 : 1)),
    caseCount: Number(result.caseCount || 0),
    driftCount: Number(result.driftCount || 0),
    errorCount: Number(result.errorCount || 0),
    driftBasis: result.driftBasis || 'scanner-vs-frozen-oracle',
    cases: Array.isArray(result.cases)
      ? result.cases.map((entry) => serializeDriftCaseResult(entry))
      : [],
  };
}

/**
 * @param {ReturnType<typeof buildDriftArtifactPayload>} payload
 * @returns {string}
 */
export function buildDriftHumanSummary(payload = {}) {
  const lines = [
    '# accessScan corpus drift summary',
    '',
    `- Mode: ${payload.mode}`,
    `- Comparator: ${payload.comparatorVersion}`,
    `- Drift basis: ${payload.driftBasis}`,
    `- Cases: ${payload.caseCount}`,
    `- Drift observed: ${payload.driftCount}`,
    `- Errors: ${payload.errorCount}`,
    `- Observed exit code: ${payload.observedExitCode}`,
    `- Aggregate ok: ${payload.ok}`,
    '',
    '## Per-case results',
  ];

  for (const caseResult of payload.cases || []) {
    if (caseResult.errorCode) {
      lines.push(`- ${caseResult.caseId}: error (${caseResult.errorCode}) ${caseResult.message || ''}`.trim());
      continue;
    }

    if (caseResult.ok) {
      lines.push(`- ${caseResult.caseId}: no drift`);
      continue;
    }

    const diff = caseResult.diff || {};
    lines.push(
      `- ${caseResult.caseId}: drift (snapshotDrift=${caseResult.snapshotDrift}, missing=${diff.missing?.length || 0}, extra=${diff.extra?.length || 0}, changed=${diff.changed?.length || 0})`,
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * @param {import('../../../src/scanner/access-scan/corpus/diff.js').CorpusDiffResult} diff
 * @param {Record<string, unknown>} meta
 */
export function serializeDriftClassification(diff, meta = {}) {
  return serializeClassifiedCorpusDiff(classifyCorpusDiff(diff, { caseMeta: meta }));
}

/**
 * @param {import('../../../src/scanner/access-scan/corpus/diff.js').CorpusDiffResult} diff
 * @param {{ expectedCount?: number, actualCount?: number }} options
 */
export function serializeDriftMetrics(diff, options = {}) {
  return serializeCommercialParityMetrics(computeCommercialParityMetrics(diff, options));
}

/**
 * @param {import('../../../src/scanner/access-scan/corpus/diff.js').CorpusDiffResult} diff
 */
export function serializeDriftDiff(diff) {
  return serializeCorpusDiff(diff);
}
