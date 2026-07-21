#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CorpusToolingError,
  getCommittedFixtureRoot,
  isCorpusToolingError,
  printDeterministicJson,
  serializeDeterministicJson,
  validateDraftSerialized,
  verifyCorpusCaseDiff,
} from './index.js';
import { CORPUS_SCHEMA_VERSION } from '../../src/scanner/access-scan/corpus/constants.js';
import { normalizeCliArgs } from './lib/cli-args.js';
import {
  assertCommittedEvidenceNeutral,
  buildEvidenceSliceCaseFromOracle,
  reprocessCommittedEvidenceSliceCase,
} from './lib/oracle-evidence-slice.js';
import { verifyOracleEvidenceDigest } from './lib/oracle-digest-verify.js';
import { buildCorpusReportFromOracleFile } from './lib/oracle-report.js';
import { defaultReplayScanCase, loadCorpusCaseContext } from './lib/replay.js';
import {
  loadSourceManifest,
  listSeededSourceEntries,
  ORACLE_ARTIFACTS_DIR,
  resolveOracleArtifactPath,
  SOURCE_MANIFEST_PATH,
} from './lib/source-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

/** @type {Record<string, { path: string, format: string }>} */
export const ORACLE_SEED_ARTIFACTS = {
  'site-728': { path: 'oracle-artifacts/site-728-oracle.json', format: 'accessScan-network-request' },
  'site-695': { path: 'oracle-artifacts/site-695-oracle.json', format: 'accessScan-network-request' },
  'site-731': { path: 'oracle-artifacts/site-731-oracle.json', format: 'accessScan-network-request' },
  'site-710': { path: 'oracle-artifacts/site-710-oracle.network-request', format: 'accessScan-network-request' },
  'site-203': { path: 'oracle-artifacts/site-203-oracle.network-request', format: 'accessScan-network-request' },
  'site-538': { path: 'oracle-artifacts/site-538-oracle.json', format: 'accessScan-details-response' },
  'site-375': { path: 'oracle-artifacts/site-375-oracle.json', format: 'accessScan-network-request' },
  'site-124': { path: 'oracle-artifacts/site-124-results.network-request', format: 'accessScan-network-request' },
};

/**
 * @param {string} entryId
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
export function resolveSeedOracleArtifactPath(entryId, entry = {}) {
  const artifact = /** @type {{ path?: string }} */ (
    entry.oracleArtifact || ORACLE_SEED_ARTIFACTS[entryId]
  );
  if (!artifact?.path) {
    throw new CorpusToolingError(
      'incomplete_report',
      `No oracle seed artifact configured for ${entryId}`,
    );
  }
  return resolveOracleArtifactPath(String(artifact.path));
}

/**
 * @param {Record<string, unknown>} entry
 * @param {{ overwrite?: boolean, dryRun?: boolean }=} options
 */
export async function seedCorpusCaseFromSourceEntry(entry, options = {}) {
  const caseId = String(entry.caseId || entry.id);
  const entryId = String(entry.id);
  const oracleArtifactPath = resolveSeedOracleArtifactPath(entryId, entry);

  if (!existsSync(oracleArtifactPath)) {
    throw new CorpusToolingError(
      'incomplete_report',
      `Oracle artifact does not exist: ${oracleArtifactPath}`,
    );
  }

  const oracle = buildCorpusReportFromOracleFile(oracleArtifactPath);
  const committedRoot = getCommittedFixtureRoot();
  const caseDir = path.join(committedRoot, 'cases', caseId);
  const draftDir = path.join(committedRoot, '..', '.seed-drafts', caseId);

  if (existsSync(caseDir) && !options.overwrite) {
    throw new CorpusToolingError(
      'output_exists',
      `Committed case already exists: ${caseDir}`,
    );
  }

  if (options.dryRun) {
    return {
      caseId,
      oracleArtifactPath,
      findings: oracle.report.findings.length,
      limitations: oracle.limitations,
      dryRun: true,
    };
  }

  const payload = JSON.parse(readFileSync(oracleArtifactPath, 'utf8'));
  const sliceCase = await buildEvidenceSliceCaseFromOracle(payload);

  const meta = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    id: caseId,
    profile: sliceCase.profile,
    route: sliceCase.route,
    captureState: sliceCase.pageState,
    viewport: sliceCase.viewport,
    captureMode: 'oracle-evidence-slice',
    notes: [
      'Frozen cross-site accessScan oracle evidence slice seeded from tooling source manifest.',
      'This case is an evidence slice rather than a whole-page baseline.',
      `Evidence slice contains ${sliceCase.sliceCount} uniquely alignable oracle snippets with ${sliceCase.alignedCount} aligned findings.`,
      ...sliceCase.limitations.map((limitation) => `Limitation: ${limitation}`),
    ],
  };

  const serialized = {
    'meta.json': JSON.stringify(meta, null, 2),
    'snapshot.json': JSON.stringify(sliceCase.snapshot, null, 2),
    'expected.json': JSON.stringify(sliceCase.expected, null, 2),
    'page.html': sliceCase.pageHtml,
  };

    assertCommittedEvidenceNeutral(serialized);
  const validationDir = mkdtempSync(path.join(tmpdir(), 'ada-corpus-seed-'));
  try {
    await validateDraftSerialized(serialized, validationDir);
  } finally {
    rmSync(validationDir, { recursive: true, force: true });
  }

  rmSync(draftDir, { recursive: true, force: true });
  mkdirSync(draftDir, { recursive: true });
  for (const [fileName, content] of Object.entries(serialized)) {
    writeFileSync(path.join(draftDir, fileName), fileName.endsWith('.html') ? content : `${content}\n`);
  }

  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(path.dirname(caseDir), { recursive: true });
  cpSync(draftDir, caseDir, { recursive: true });
  rmSync(draftDir, { recursive: true, force: true });

  const context = loadCorpusCaseContext(caseDir);
  const replayFindings = await defaultReplayScanCase(context);
  const replayDiff = verifyCorpusCaseDiff(caseDir, replayFindings);
  if (!replayDiff.ok) {
    throw new CorpusToolingError(
      'replay_mismatch',
      `${caseId} replay findings are not equivalent to expected.json`,
      { diff: replayDiff.diff },
    );
  }

  return {
    caseId,
    caseDir,
    findings: sliceCase.expected.findings.length,
    sliceCount: sliceCase.sliceCount,
    skippedAlignments: sliceCase.skippedAlignments,
    limitations: sliceCase.limitations,
    captureHashes: sliceCase.captureHashes,
    oracleDigest: sliceCase.oracleDigest,
    files: Object.keys(serialized),
  };
}

/**
 * @param {string} manifestPath
 * @param {{ ids?: string[], overwrite?: boolean, dryRun?: boolean }=} options
 */
export async function seedCorpusFromSourceManifest(manifestPath = SOURCE_MANIFEST_PATH, options = {}) {
  const manifest = loadSourceManifest(manifestPath, { allowSeedArtifacts: true });
  const entries = listSeededSourceEntries(manifest)
    .filter((entry) => !options.ids || options.ids.includes(String(entry.id)));

  /** @type {Record<string, unknown>[]} */
  const results = [];
  for (const entry of entries) {
    results.push(await seedCorpusCaseFromSourceEntry(entry, options));
  }

  return {
    manifestPath,
    seeded: results,
  };
}

/**
 * @param {Record<string, unknown>[]} seededResults
 * @param {string} manifestPath
 */
export function updateSourceManifestProvenance(seededResults, manifestPath = SOURCE_MANIFEST_PATH) {
  const manifest = loadSourceManifest(manifestPath, { allowSeedArtifacts: true });
  const byCaseId = new Map(
    seededResults.map((result) => [String(result.caseId), result]),
  );

  for (const entry of manifest.entries) {
    if (entry.seedStatus !== 'seeded') continue;
    const result = byCaseId.get(String(entry.caseId));
    if (!result) continue;

    entry.captureProvenance = {
      stableCaptureHashes: result.captureHashes,
      captureCount: 2,
      captureMode: 'oracle-evidence-slice',
      oracleEvidenceDigest: result.oracleDigest,
      seededAt: '[tooling-only-timestamp]',
    };

    if (Array.isArray(result.limitations) && result.limitations.length > 0) {
      entry.limitationNotes = summarizeLimitations(result.limitations);
    }

    delete entry.oracleArtifact;
    delete entry.oracleLimitations;
  }

  writeFileSync(manifestPath, `${serializeDeterministicJson(manifest)}\n`);
  return manifest;
}

/**
 * @param {string[]} limitations
 * @returns {string[]}
 */
function summarizeLimitations(limitations = []) {
  const unique = [...new Set(limitations.map(String))];
  return unique.slice(0, 12);
}

/**
 * @param {string[]} caseIds
 * @param {string} corpusManifestPath
 */
export function updateCommittedCorpusManifest(caseIds, corpusManifestPath) {
  const manifest = existsSync(corpusManifestPath)
    ? JSON.parse(readFileSync(corpusManifestPath, 'utf8'))
    : {
      schemaVersion: '1.0.0',
      description: 'Frozen neutral accessScan corpus contract fixtures for element-level parity gates.',
      cases: [],
    };

  const existing = new Map(
    (Array.isArray(manifest.cases) ? manifest.cases : [])
      .map((entry) => [entry.id, entry]),
  );

  for (const caseId of caseIds) {
    existing.set(caseId, {
      id: caseId,
      path: `cases/${caseId}`,
    });
  }

  manifest.cases = [...existing.values()].sort((left, right) => (
    String(left.id).localeCompare(String(right.id))
  ));

  writeFileSync(corpusManifestPath, `${serializeDeterministicJson(manifest)}\n`);
  return manifest;
}

/**
 * Removes raw oracle artifacts after successful seeding.
 */
export function deleteOracleArtifacts() {
  if (!existsSync(ORACLE_ARTIFACTS_DIR)) {
    return [];
  }

  const deleted = [];
  for (const fileName of readdirSync(ORACLE_ARTIFACTS_DIR)) {
    const filePath = path.join(ORACLE_ARTIFACTS_DIR, fileName);
    rmSync(filePath, { force: true });
    deleted.push(fileName);
  }
  rmSync(ORACLE_ARTIFACTS_DIR, { recursive: true, force: true });
  return deleted;
}

/**
 * @param {{ ids?: string[] }=} options
 */
export async function reprocessCommittedCorpusCases(options = {}) {
  const manifest = loadSourceManifest();
  const committedRoot = getCommittedFixtureRoot();
  const entries = listSeededSourceEntries(manifest)
    .filter((entry) => !options.ids || options.ids.includes(String(entry.id)));

  /** @type {Record<string, unknown>[]} */
  const results = [];

  for (const entry of entries) {
    const caseId = String(entry.caseId);
    const caseDir = path.join(committedRoot, 'cases', caseId);
    const meta = JSON.parse(readFileSync(path.join(caseDir, 'meta.json'), 'utf8'));
    const priorExpected = JSON.parse(readFileSync(path.join(caseDir, 'expected.json'), 'utf8'));

    const reprocessed = await reprocessCommittedEvidenceSliceCase(caseDir, meta, priorExpected);

    const serialized = {
      'meta.json': JSON.stringify({
        ...meta,
        notes: [
          ...(Array.isArray(meta.notes) ? meta.notes : []).filter((note) => !String(note).startsWith('Limitation: Reprocess')),
          `Limitation: Reprocess retained ${reprocessed.alignedCount} replay-confirmed findings after neutralization refresh`,
          ...reprocessed.limitations.map((limitation) => `Limitation: ${limitation}`),
        ],
      }, null, 2),
      'snapshot.json': JSON.stringify(reprocessed.snapshot, null, 2),
      'expected.json': JSON.stringify(reprocessed.expected, null, 2),
      'page.html': reprocessed.pageHtml,
    };

    assertCommittedEvidenceNeutral(serialized);

    for (const [fileName, content] of Object.entries(serialized)) {
      writeFileSync(
        path.join(caseDir, fileName),
        fileName.endsWith('.html') ? content : `${content}\n`,
      );
    }

    entry.captureProvenance = {
      ...(/** @type {Record<string, unknown>} */ (entry.captureProvenance)),
      stableCaptureHashes: reprocessed.captureHashes,
      captureCount: 2,
      captureMode: 'oracle-evidence-slice',
    };

    results.push({
      caseId,
      findings: reprocessed.alignedCount,
      captureHashes: reprocessed.captureHashes,
      limitations: reprocessed.limitations,
    });
  }

  writeFileSync(SOURCE_MANIFEST_PATH, `${serializeDeterministicJson(manifest)}\n`);

  return { reprocessed: results };
}

/**
 * @param {string} manifestPath
 * @param {{ ids?: string[], artifactPath?: string }=} options
 */
export async function verifyCommittedOracleDigests(manifestPath = SOURCE_MANIFEST_PATH, options = {}) {
  const manifest = loadSourceManifest(manifestPath, { allowSeedArtifacts: true });
  const entries = listSeededSourceEntries(manifest)
    .filter((entry) => !options.ids || options.ids.includes(String(entry.id)));

  /** @type {Record<string, unknown>[]} */
  const verified = [];

  for (const entry of entries) {
    const artifactPath = options.artifactPath
      || resolveSeedOracleArtifactPath(String(entry.id), entry);
    const provenance = /** @type {{ oracleEvidenceDigest?: string }} */ (entry.captureProvenance);
    const expectedDigest = String(provenance.oracleEvidenceDigest || '');
    const result = verifyOracleEvidenceDigest(artifactPath, expectedDigest);
    verified.push({
      caseId: entry.caseId,
      digest: result.digest,
      artifactPath,
    });
    rmSync(artifactPath, { force: true });
  }

  return { verified };
}

/**
 * @param {string[]} argv
 */
export async function runCorpusSeedCli(argv = normalizeCliArgs(process.argv.slice(2))) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      id: { type: 'string', multiple: true },
      overwrite: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'manifest-path': { type: 'string' },
      'delete-artifacts': { type: 'boolean', default: false },
      'reprocess-committed': { type: 'boolean', default: false },
      'verify-digest': { type: 'boolean', default: false },
      artifact: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printDeterministicJson({
      ok: true,
      command: 'corpus:seed',
      usage: [
        'node scripts/accessscan-corpus/seed.js --overwrite',
        'node scripts/accessscan-corpus/seed.js --reprocess-committed',
        'node scripts/accessscan-corpus/seed.js --verify-digest --id site-728 --artifact oracle-artifacts/site-728-oracle.json',
      ],
      recaptureVerification: 'Supply a fresh oracle artifact with --verify-digest to compare oracleEvidenceDigest without retaining raw payloads.',
    });
    return 0;
  }

  const manifestPath = typeof values['manifest-path'] === 'string'
    ? values['manifest-path']
    : SOURCE_MANIFEST_PATH;

  try {
    if (values['verify-digest']) {
      const result = await verifyCommittedOracleDigests(manifestPath, {
        ids: Array.isArray(values.id) ? values.id.map(String) : undefined,
        artifactPath: typeof values.artifact === 'string' ? values.artifact : undefined,
      });
      printDeterministicJson({
        ok: true,
        command: 'corpus:seed',
        mode: 'verify-digest',
        verified: result.verified,
      });
      return 0;
    }

    if (values['reprocess-committed']) {
      const result = await reprocessCommittedCorpusCases({
        ids: Array.isArray(values.id) ? values.id.map(String) : undefined,
      });
      printDeterministicJson({
        ok: true,
        command: 'corpus:seed',
        mode: 'reprocess-committed',
        reprocessed: result.reprocessed,
      });
      return 0;
    }

    const result = await seedCorpusFromSourceManifest(manifestPath, {
      ids: Array.isArray(values.id) ? values.id.map(String) : undefined,
      overwrite: Boolean(values.overwrite),
      dryRun: Boolean(values['dry-run']),
    });

    if (!values['dry-run']) {
      updateSourceManifestProvenance(result.seeded, manifestPath);
      updateCommittedCorpusManifest(
        result.seeded.map((entry) => String(entry.caseId)),
        path.join(getCommittedFixtureRoot(), 'manifest.json'),
      );
      if (values['delete-artifacts']) {
        deleteOracleArtifacts();
      }
    }

    printDeterministicJson({
      ok: true,
      command: 'corpus:seed',
      seeded: result.seeded.map((entry) => ({
        caseId: entry.caseId,
        findings: entry.findings,
        sliceCount: entry.sliceCount || null,
        limitations: entry.limitations,
        captureHashes: entry.captureHashes || null,
        oracleDigest: entry.oracleDigest || null,
        dryRun: entry.dryRun || false,
      })),
    });
    return 0;
  } catch (error) {
    const payload = isCorpusToolingError(error)
      ? {
        ok: false,
        errorCode: error.errorCode,
        message: error.message,
        details: error.details || null,
      }
      : {
        ok: false,
        errorCode: 'schema_failure',
        message: error instanceof Error ? error.message : String(error),
      };
    printDeterministicJson(payload);
    return 1;
  }
}

if (isMain) {
  runCorpusSeedCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    printDeterministicJson({
      ok: false,
      errorCode: 'schema_failure',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
