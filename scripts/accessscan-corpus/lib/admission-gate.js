import { existsSync } from 'node:fs';

import { validateCorpusCase } from '../../../src/scanner/access-scan/corpus/schema.js';
import { resolveCorpusCaseDir } from './corpus-case-dir.js';
import { readCorpusCaseFile, readCorpusCaseJson } from './corpus-case-read.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { assertCommittedEvidenceNeutral } from './oracle-evidence-slice.js';
import { buildSnapshotIdentity } from './snapshot-identity.js';
import {
  listBlockedSourceEntries,
  listSeededSourceEntries,
} from './source-manifest.js';
import {
  validateManifestCaseId,
  validateSourceManifestUrlShape,
} from './source-url-policy.js';

/** Per-entry evidence requirements (full_corpus_regression is corpus-level proof). */
export const ADMISSION_REQUIREMENTS = Object.freeze([
  'ingestion',
  'sanitization',
  'unique_alignment',
  'two_stable_captures',
  'schema_validation',
]);

export const CORPUS_ADMISSION_PROOF_REQUIREMENT = 'full_corpus_regression';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} caseDir
 * @param {string} corpusRoot
 */
function assertCommittedCaseSanitized(caseDir, corpusRoot) {
  const files = {
    'meta.json': readCorpusCaseFile(caseDir, 'meta.json', corpusRoot),
    'snapshot.json': readCorpusCaseFile(caseDir, 'snapshot.json', corpusRoot),
    'expected.json': readCorpusCaseFile(caseDir, 'expected.json', corpusRoot),
    'page.html': readCorpusCaseFile(caseDir, 'page.html', corpusRoot),
  };
  assertCommittedEvidenceNeutral(files);
}

/**
 * @param {string} caseDir
 * @param {string} corpusRoot
 */
function assertCommittedFindingsAligned(caseDir, corpusRoot) {
  const expected = readCorpusCaseJson(caseDir, 'expected.json', corpusRoot);
  const findings = Array.isArray(expected.findings) ? expected.findings : [];
  const seen = new Set();

  for (const finding of findings) {
    const semantic = finding?.element?.semantic;
    if (!semantic || typeof semantic.tag !== 'string') {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
        'Committed expected findings require aligned semantic identity',
        { caseDir },
      );
    }
    const key = `${finding.ruleId}|${semantic.tag}|${JSON.stringify(semantic.landmarkPath || [])}|${semantic.ordinal}`;
    if (seen.has(key)) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.AMBIGUOUS_ALIGNMENT,
        'Committed expected findings contain ambiguous duplicate alignment',
        { caseDir, key },
      );
    }
    seen.add(key);
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} caseDir
 * @param {string} corpusRoot
 */
function assertStableCaptureProvenanceMatchesSnapshot(entry, caseDir, corpusRoot) {
  if (!isObject(entry.captureProvenance)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      'Seeded manifest entry requires captureProvenance',
      { entryId: entry.id },
    );
  }

  const hashes = entry.captureProvenance.stableCaptureHashes;
  if (!Array.isArray(hashes) || hashes.length < 2 || hashes[0] !== hashes[1]) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.UNSTABLE_CAPTURE,
      'Seeded manifest entry requires two identical stable capture hashes',
      { entryId: entry.id },
    );
  }

  const snapshot = readCorpusCaseJson(caseDir, 'snapshot.json', corpusRoot);
  const identity = buildSnapshotIdentity(snapshot);
  if (hashes[0] !== identity) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      'Stable capture provenance does not match committed snapshot identity',
      { entryId: entry.id, committedIdentity: identity, provenanceHash: hashes[0] },
    );
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} caseDir
 * @param {string} corpusRoot
 * @returns {boolean}
 */
function evaluateIngestionEvidence(entry, caseDir, corpusRoot) {
  if (!isObject(entry.captureProvenance)) {
    return false;
  }

  const provenance = entry.captureProvenance;
  if (provenance.captureMode !== 'oracle-evidence-slice') {
    return false;
  }

  if (typeof provenance.oracleEvidenceDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(String(provenance.oracleEvidenceDigest))) {
    return false;
  }

  const validation = validateCorpusCase(caseDir);
  if (!validation.ok) {
    return false;
  }

  try {
    assertStableCaptureProvenanceMatchesSnapshot(entry, caseDir, corpusRoot);
  } catch {
    return false;
  }

  try {
    assertCommittedCaseSanitized(caseDir, corpusRoot);
  } catch {
    return false;
  }

  return true;
}

/**
 * @param {Record<string, unknown>} entry
 */
export function assertManifestEntryDriftEligible(entry) {
  if (entry.seedStatus !== 'seeded') {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      `Drift monitor requires seeded manifest entry: ${entry.id}`,
      { entryId: entry.id, seedStatus: entry.seedStatus },
    );
  }

  validateManifestCaseId(String(entry.caseId || entry.id));
  validateSourceManifestUrlShape(String(entry.sourceUrl || ''));

  if (!isObject(entry.captureProvenance)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      `Drift monitor requires captureProvenance for ${entry.id}`,
      { entryId: entry.id },
    );
  }

  const hashes = entry.captureProvenance.stableCaptureHashes;
  if (!Array.isArray(hashes) || hashes.length < 2 || hashes[0] !== hashes[1]) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.UNSTABLE_CAPTURE,
      `Drift monitor requires two identical stableCaptureHashes for ${entry.id}`,
      { entryId: entry.id },
    );
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {{
 *   corpusRoot: string,
 *   fullCorpusRegressionProven?: boolean,
 *   requireFullCorpusRegressionProof?: boolean,
 * }=} options
 */
export function validateManifestEntryAdmission(entry, options = {}) {
  /** @type {string[]} */
  const requirementsMet = [];
  /** @type {string[]} */
  const missingRequirements = [];
  const corpusRoot = options.corpusRoot;
  const fullCorpusRegressionProven = options.fullCorpusRegressionProven === true;

  if (entry.seedStatus !== 'seeded') {
    return {
      ok: false,
      entryId: String(entry.id || ''),
      requirementsMet,
      missingRequirements: [...ADMISSION_REQUIREMENTS, CORPUS_ADMISSION_PROOF_REQUIREMENT],
    };
  }

  const caseId = validateManifestCaseId(String(entry.caseId || entry.id));

  try {
    validateSourceManifestUrlShape(String(entry.sourceUrl || ''));
  } catch {
    missingRequirements.push('ingestion');
  }

  const caseDir = resolveCorpusCaseDir(corpusRoot, caseId);
  if (!existsSync(caseDir)) {
    missingRequirements.push(
      'ingestion',
      'sanitization',
      'unique_alignment',
      'schema_validation',
      'two_stable_captures',
    );
  } else {
    const validation = validateCorpusCase(caseDir);
    if (validation.ok) {
      requirementsMet.push('schema_validation');
    } else {
      missingRequirements.push('schema_validation');
    }

    if (evaluateIngestionEvidence(entry, caseDir, corpusRoot)) {
      requirementsMet.push('ingestion');
    } else {
      missingRequirements.push('ingestion');
    }

    try {
      assertStableCaptureProvenanceMatchesSnapshot(entry, caseDir, corpusRoot);
      requirementsMet.push('two_stable_captures');
    } catch {
      missingRequirements.push('two_stable_captures');
    }

    try {
      assertCommittedCaseSanitized(caseDir, corpusRoot);
      requirementsMet.push('sanitization');
    } catch {
      missingRequirements.push('sanitization');
    }

    try {
      assertCommittedFindingsAligned(caseDir, corpusRoot);
      requirementsMet.push('unique_alignment');
    } catch {
      missingRequirements.push('unique_alignment');
    }
  }

  if (fullCorpusRegressionProven) {
    requirementsMet.push(CORPUS_ADMISSION_PROOF_REQUIREMENT);
  } else if (options.requireFullCorpusRegressionProof === true) {
    missingRequirements.push(CORPUS_ADMISSION_PROOF_REQUIREMENT);
  }

  const uniqueMissing = [...new Set(missingRequirements.filter((requirement) => (
    !requirementsMet.includes(requirement)
  )))];

  return {
    ok: uniqueMissing.length === 0,
    entryId: caseId,
    requirementsMet: [...new Set(requirementsMet)].sort(),
    missingRequirements: uniqueMissing.sort(),
  };
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} corpusRoot
 */
export function assertBlockedEntriesIsolated(manifest, corpusRoot) {
  for (const entry of listBlockedSourceEntries(manifest)) {
    const caseId = typeof entry.caseId === 'string' ? validateManifestCaseId(entry.caseId) : null;
    if (!caseId) {
      continue;
    }

    const caseDir = resolveCorpusCaseDir(corpusRoot, caseId);
    if (existsSync(caseDir)) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
        `Blocked source manifest entry ${entry.id} must not map to committed corpus case ${caseId}`,
        { entryId: entry.id, caseId },
      );
    }
  }
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} corpusRoot
 * @param {{ fullCorpusRegressionProven?: boolean, requireFullCorpusRegressionProof?: boolean }=} options
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifySeededSourceManifestAdmission(manifest, corpusRoot, options = {}) {
  assertBlockedEntriesIsolated(manifest, corpusRoot);
  /** @type {string[]} */
  const errors = [];
  const entries = listSeededSourceEntries(manifest)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));

  for (const entry of entries) {
    const caseId = validateManifestCaseId(String(entry.caseId || entry.id));
    const caseDir = resolveCorpusCaseDir(corpusRoot, caseId);
    if (!existsSync(caseDir)) {
      errors.push(`source ${entry.id}: missing committed corpus case ${caseId}`);
      continue;
    }

    const admission = validateManifestEntryAdmission(entry, {
      corpusRoot,
      fullCorpusRegressionProven: options.fullCorpusRegressionProven === true,
      requireFullCorpusRegressionProof: options.requireFullCorpusRegressionProof === true,
    });
    if (!admission.ok) {
      errors.push(
        `source ${entry.id}: admission failed (${admission.missingRequirements.join(', ')})`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} corpusRoot
 */
export function listDriftMonitorEntries(manifest, corpusRoot) {
  return listSeededSourceEntries(manifest)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((entry) => {
      validateManifestCaseId(String(entry.caseId || entry.id));
      validateSourceManifestUrlShape(String(entry.sourceUrl || ''));
      assertStableCaptureProvenanceMatchesSnapshot(
        entry,
        resolveCorpusCaseDir(corpusRoot, String(entry.caseId || entry.id)),
        corpusRoot,
      );
      return entry;
    });
}
