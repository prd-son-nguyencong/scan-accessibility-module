import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS_SCHEMA_VERSION } from '../../../src/scanner/access-scan/corpus/constants.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { validateManifestCaseId, validateSourceManifestUrlShape } from './source-url-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_MANIFEST_PATH = path.join(__dirname, '../source-manifest.json');
export const ORACLE_ARTIFACTS_DIR = path.join(__dirname, '../oracle-artifacts');

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} manifest
 * @param {{ allowSeedArtifacts?: boolean }=} options
 * @returns {{ ok: true, manifest: Record<string, unknown> } | { ok: false, errors: string[] }}
 */
export function validateSourceManifest(manifest, options = {}) {
  /** @type {string[]} */
  const errors = [];

  if (!isObject(manifest)) {
    return { ok: false, errors: ['source manifest must be an object'] };
  }

  if (manifest.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    errors.push(`source manifest schemaVersion must be ${CORPUS_SCHEMA_VERSION}`);
  }

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push('source manifest entries must be a non-empty array');
    return { ok: false, errors };
  }

  const sortedIds = manifest.entries.map((entry) => String(entry.id || ''));
  const expectedSorted = [...sortedIds].sort((left, right) => left.localeCompare(right));
  if (sortedIds.some((id, index) => id !== expectedSorted[index])) {
    errors.push('source manifest entries must be sorted by id');
  }

  const seenIds = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    if (!isObject(entry)) {
      errors.push(`entries[${index}] must be an object`);
      continue;
    }

    const id = entry.id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`entries[${index}].id must be a non-empty string`);
    } else if (seenIds.has(id)) {
      errors.push(`entries[${index}].id duplicates "${id}"`);
    } else {
      seenIds.add(id);
    }

    if (typeof entry.label !== 'string' || entry.label.length === 0) {
      errors.push(`entries[${index}].label must be a non-empty string`);
    }

    if (typeof entry.sourceUrl !== 'string' || entry.sourceUrl.length === 0) {
      errors.push(`entries[${index}].sourceUrl must be a non-empty string`);
    } else {
      try {
        validateSourceManifestUrlShape(entry.sourceUrl);
      } catch (error) {
        const message = error instanceof CorpusToolingError ? error.message : String(error);
        errors.push(`entries[${index}].sourceUrl is not allowed: ${message}`);
      }
    }

    const seedStatus = entry.seedStatus;
    if (seedStatus !== 'seeded' && seedStatus !== 'blocked') {
      errors.push(`entries[${index}].seedStatus must be "seeded" or "blocked"`);
    }

    if (seedStatus === 'seeded') {
      if (typeof entry.caseId !== 'string' || entry.caseId.length === 0) {
        errors.push(`entries[${index}].caseId is required when seedStatus is seeded`);
      } else {
        try {
          validateManifestCaseId(entry.caseId);
        } catch (error) {
          const message = error instanceof CorpusToolingError ? error.message : String(error);
          errors.push(`entries[${index}].caseId is invalid: ${message}`);
        }
      }

      if (!options.allowSeedArtifacts) {
        if (!isObject(entry.captureProvenance)) {
          errors.push(`entries[${index}].captureProvenance is required when seedStatus is seeded`);
        } else {
          const provenance = entry.captureProvenance;
          const hashes = provenance.stableCaptureHashes;
          if (!Array.isArray(hashes) || hashes.length < 2) {
            errors.push(`entries[${index}].captureProvenance.stableCaptureHashes must include two hashes`);
          } else if (hashes[0] !== hashes[1]) {
            errors.push(`entries[${index}].captureProvenance.stableCaptureHashes must be identical across both captures`);
          }

          if (typeof provenance.oracleEvidenceDigest !== 'string' || provenance.oracleEvidenceDigest.length === 0) {
            errors.push(`entries[${index}].captureProvenance.oracleEvidenceDigest is required when seedStatus is seeded`);
          }
          if (provenance.captureMode !== 'oracle-evidence-slice') {
            errors.push(`entries[${index}].captureProvenance.captureMode must be oracle-evidence-slice`);
          }
          if (isObject(entry.oracleArtifact)) {
            errors.push(`entries[${index}] must not retain raw oracleArtifact paths after seeding`);
          }
        }
      }
    }

    if (seedStatus === 'blocked') {
      if (!Array.isArray(entry.limitations) || entry.limitations.length === 0) {
        errors.push(`entries[${index}].limitations must document blocked oracle gaps`);
      }
    }
  }

  return errors.length === 0
    ? { ok: true, manifest }
    : { ok: false, errors };
}

/**
 * @param {string=} manifestPath
 * @param {{ allowSeedArtifacts?: boolean }=} options
 */
export function loadSourceManifest(manifestPath = SOURCE_MANIFEST_PATH, options = {}) {
  if (!existsSync(manifestPath)) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      `Source manifest does not exist: ${manifestPath}`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const validation = validateSourceManifest(manifest, options);
  if (!validation.ok) {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.SCHEMA_FAILURE,
      validation.errors[0],
      { errors: validation.errors },
    );
  }

  return validation.manifest;
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>[]}
 */
export function listSourceManifestEntries(manifest) {
  return Array.isArray(manifest.entries)
    ? /** @type {Record<string, unknown>[]} */ ([...manifest.entries])
    : [];
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>[]}
 */
export function listSeededSourceEntries(manifest) {
  return listSourceManifestEntries(manifest)
    .filter((entry) => entry.seedStatus === 'seeded');
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>[]}
 */
export function listBlockedSourceEntries(manifest) {
  return listSourceManifestEntries(manifest)
    .filter((entry) => entry.seedStatus === 'blocked');
}

/**
 * @param {string} relativeArtifactPath
 * @returns {string}
 */
export function resolveOracleArtifactPath(relativeArtifactPath) {
  return path.resolve(path.dirname(SOURCE_MANIFEST_PATH), relativeArtifactPath);
}
