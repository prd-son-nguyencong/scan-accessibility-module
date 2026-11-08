import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPUS_SCHEMA_VERSION,
} from '../src/scanner/access-scan/corpus/constants.js';
import {
  validateCorpusCase,
  validateCorpusManifest,
} from '../src/scanner/access-scan/corpus/schema.js';
import {
  loadSourceManifest,
  listBlockedSourceEntries,
  listSeededSourceEntries,
  listSourceManifestEntries,
  ORACLE_ARTIFACTS_DIR,
  SOURCE_MANIFEST_PATH,
  validateSourceManifest,
} from '../scripts/accessscan-corpus/lib/source-manifest.js';
import { verifyCorpus } from '../scripts/accessscan-corpus/index.js';
import { buildSnapshotIdentity } from '../scripts/accessscan-corpus/lib/snapshot-identity.js';
import { assertCommittedEvidenceNeutral } from '../scripts/accessscan-corpus/lib/oracle-evidence-slice.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');
const SRC_ROOT = path.join(PACKAGE_ROOT, 'src');
const REQUIRED_SITE_CASE_IDS = [
  'site-728',
  'site-695',
  'site-731',
  'site-710',
  'site-203',
  'site-538',
  'site-375',
  'site-124',
];

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseRetainedFindingCount(meta = {}) {
  const notes = Array.isArray(meta.notes) ? meta.notes : [];
  for (const note of notes) {
    const retained = String(note).match(/Reprocess retained (\d+) replay-confirmed findings/);
    if (retained) {
      return Number(retained[1]);
    }
    const aligned = String(note).match(/with (\d+) aligned findings/);
    if (aligned) {
      return Number(aligned[1]);
    }
  }
  return null;
}

function listProductionSourceFiles(dir = SRC_ROOT) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listProductionSourceFiles(fullPath));
      continue;
    }
    if (/\.(js|ts|mjs|cjs)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

test('source manifest validates eight seeded opaque entries with digest provenance', () => {
  const manifest = loadSourceManifest();
  const validation = validateSourceManifest(manifest);
  assert.equal(validation.ok, true, validation.errors?.join('; '));
  assert.equal(manifest.schemaVersion, CORPUS_SCHEMA_VERSION);

  const entries = listSourceManifestEntries(manifest);
  assert.equal(entries.length, 8);

  const seeded = listSeededSourceEntries(manifest);
  const blocked = listBlockedSourceEntries(manifest);
  assert.equal(seeded.length, 8);
  assert.equal(blocked.length, 0);
  assert.deepEqual(
    seeded.map((entry) => String(entry.id)).sort(),
    [...REQUIRED_SITE_CASE_IDS].sort(),
  );

  for (const entry of seeded) {
    assert.equal(entry.seedStatus, 'seeded');
    assert.match(String(entry.id), /^site-\d+$/);
    assert.match(String(entry.caseId), /^site-\d+$/);
    assert.equal(entry.oracleArtifact, undefined);

    const provenance = /** @type {{
      stableCaptureHashes?: string[],
      captureMode?: string,
      oracleEvidenceDigest?: string,
    }} */ (entry.captureProvenance);
    assert.equal(provenance.captureMode, 'oracle-evidence-slice');
    assert.match(String(provenance.oracleEvidenceDigest), /^sha256:[a-f0-9]{64}$/);
    assert.ok(Array.isArray(provenance.stableCaptureHashes));
    assert.equal(provenance.stableCaptureHashes?.length, 2);
    assert.equal(
      provenance.stableCaptureHashes?.[0],
      provenance.stableCaptureHashes?.[1],
    );

    const caseDir = path.join(CORPUS_ROOT, 'cases', String(entry.caseId));
    const snapshot = loadJson(path.join(caseDir, 'snapshot.json'));
    const identity = buildSnapshotIdentity(snapshot);
    assert.equal(provenance.stableCaptureHashes?.[0], identity);
    assert.equal(provenance.stableCaptureHashes?.[1], identity);
  }
});

test('raw oracle artifacts are removed after seeding', () => {
  assert.equal(existsSync(ORACLE_ARTIFACTS_DIR), false);
  const manifestSource = readFileSync(SOURCE_MANIFEST_PATH, 'utf8').toLowerCase();
  assert.equal(manifestSource.includes('oracle-artifacts/'), false);
  assert.equal(manifestSource.includes('oracleartifact'), false);
});

test('every seeded opaque source entry has a replayable committed corpus case', () => {
  const sourceManifest = loadSourceManifest();
  const corpusManifest = loadJson(path.join(CORPUS_ROOT, 'manifest.json'));
  const corpusIds = new Set(corpusManifest.cases.map((entry) => entry.id));

  for (const entry of listSeededSourceEntries(sourceManifest)) {
    const caseId = String(entry.caseId);
    assert.ok(corpusIds.has(caseId), `missing committed corpus case for ${caseId}`);
    const caseDir = path.join(CORPUS_ROOT, 'cases', caseId);
    const validation = validateCorpusCase(caseDir);
    assert.equal(validation.ok, true, validation.errors?.join('; '));
    assert.equal(existsSync(path.join(caseDir, 'page.html')), true, `${caseId} missing page.html`);
  }
});

test('seeded committed cases are neutralized without host leakage or forbidden tokens', () => {
  const sourceManifest = loadSourceManifest();

  for (const entry of listSeededSourceEntries(sourceManifest)) {
    const caseDir = path.join(CORPUS_ROOT, 'cases', String(entry.caseId));
    const meta = loadJson(path.join(caseDir, 'meta.json'));
    assert.equal(meta.captureMode, 'oracle-evidence-slice');

    const files = {
      'meta.json': readFileSync(path.join(caseDir, 'meta.json'), 'utf8'),
      'snapshot.json': readFileSync(path.join(caseDir, 'snapshot.json'), 'utf8'),
      'expected.json': readFileSync(path.join(caseDir, 'expected.json'), 'utf8'),
      'page.html': readFileSync(path.join(caseDir, 'page.html'), 'utf8'),
    };

    assert.doesNotThrow(
      () => assertCommittedEvidenceNeutral(files),
      `${entry.caseId} committed evidence is not neutralized`,
    );
  }
});

test('seeded expected findings are nonempty html-backed replay slices', () => {
  const sourceManifest = loadSourceManifest();

  for (const entry of listSeededSourceEntries(sourceManifest)) {
    const caseDir = path.join(CORPUS_ROOT, 'cases', String(entry.caseId));
    const expected = loadJson(path.join(caseDir, 'expected.json'));

    assert.ok(expected.findings.length > 0, `${entry.caseId} must contain aligned findings`);
    for (const finding of expected.findings) {
      assert.ok(finding.element?.semantic, `${entry.caseId} finding missing aligned semantic identity`);
      assert.ok(finding.ruleId, `${entry.caseId} finding missing ruleId`);
      assert.ok(finding.canonicalRuleId, `${entry.caseId} finding missing canonicalRuleId`);
    }
  }
});

test('meta retained finding count matches expected.json for every seeded site case', () => {
  const sourceManifest = loadSourceManifest();

  for (const entry of listSeededSourceEntries(sourceManifest)) {
    const caseId = String(entry.caseId);
    const caseDir = path.join(CORPUS_ROOT, 'cases', caseId);
    const meta = loadJson(path.join(caseDir, 'meta.json'));
    const expected = loadJson(path.join(caseDir, 'expected.json'));
    const retained = parseRetainedFindingCount(meta);

    assert.notEqual(retained, null, `${caseId} meta is missing retained/aligned finding count`);
    assert.equal(
      expected.findings.length,
      retained,
      `${caseId} expected findings (${expected.findings.length}) must match meta retained count (${retained})`,
    );
  }
});

test('committed corpus manifest validates deterministically with all seeded cases', () => {
  const manifest = loadJson(path.join(CORPUS_ROOT, 'manifest.json'));
  const validation = validateCorpusManifest(manifest, { rootDir: CORPUS_ROOT });
  assert.equal(validation.ok, true, validation.errors?.join('; '));

  const ids = manifest.cases.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort((left, right) => left.localeCompare(right)));
  for (const caseId of REQUIRED_SITE_CASE_IDS) {
    assert.ok(ids.includes(caseId), `missing corpus manifest entry for ${caseId}`);
  }
});

test('production src modules do not import tooling-only source manifest', () => {
  const needles = [
    'source-manifest',
    'source-manifest.json',
    'accessscan-corpus/source-manifest',
  ];

  for (const filePath of listProductionSourceFiles()) {
    const content = readFileSync(filePath, 'utf8');
    for (const needle of needles) {
      assert.equal(
        content.includes(needle),
        false,
        `${path.relative(PACKAGE_ROOT, filePath)} imports tooling-only source manifest`,
      );
    }
  }
});

test('verifyCorpus replays all eight seeded committed cases with exact parity', async () => {
  const result = await verifyCorpus(CORPUS_ROOT);
  assert.equal(result.ok, true, result.errors?.join('; '));

  const siteCases = result.cases.filter((entry) => entry.id.startsWith('site-'));
  assert.equal(siteCases.length, 8);
  for (const caseResult of siteCases) {
    assert.equal(caseResult.ok, true, `${caseResult.id}: ${JSON.stringify(caseResult.diff)}`);
    assert.equal(caseResult.replaySkipped, undefined);
    assert.equal(caseResult.diff?.equivalent, true, `${caseResult.id} replay diff not equivalent`);
  }
});
