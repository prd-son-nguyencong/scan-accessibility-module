import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertBlockedEntriesIsolated,
  assertManifestEntryDriftEligible,
  CORPUS_ADMISSION_PROOF_REQUIREMENT,
  validateManifestEntryAdmission,
} from '../scripts/accessscan-corpus/lib/admission-gate.js';
import {
  buildDriftArtifactPayload,
  buildDriftHumanSummary,
  serializeDriftCaseResult,
} from '../scripts/accessscan-corpus/lib/drift-artifact.js';
import {
  evaluateCorpusDriftAll,
  evaluateManifestEntryDrift,
} from '../scripts/accessscan-corpus/lib/drift-manifest.js';
import { runCorpusDriftCli } from '../scripts/accessscan-corpus/drift.js';
import { loadCorpusCaseContext } from '../scripts/accessscan-corpus/lib/replay.js';
import { loadSourceManifest } from '../scripts/accessscan-corpus/lib/source-manifest.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';
import { createTestTempDir, testSubprocessEnv } from './helpers/accessscan-corpus-test-temp.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus-tooling');
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

/**
 * @param {string} script
 * @param {string[]} args
 */
function runCli(script, args) {
  const result = spawnSync('node', [path.join(PACKAGE_ROOT, script), ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: testSubprocessEnv(),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

test('assertManifestEntryDriftEligible requires seeded provenance with two stable captures', () => {
  const manifest = loadSourceManifest();
  const [seeded] = manifest.entries;
  assert.doesNotThrow(() => assertManifestEntryDriftEligible(seeded));

  assert.throws(
    () => assertManifestEntryDriftEligible({
      id: 'blocked-case',
      seedStatus: 'blocked',
      limitations: ['oracle gap'],
    }),
    /seeded manifest entry/i,
  );

  assert.throws(
    () => assertManifestEntryDriftEligible({
      id: 'site-new',
      seedStatus: 'seeded',
      caseId: 'site-new',
      sourceUrl: 'https://fake123.preview.sites.stg.paradox.ai/',
      captureProvenance: { stableCaptureHashes: ['sha256:abc'] },
    }),
    /two identical stableCaptureHashes|stableCaptureHashes/i,
  );
});

test('validateManifestEntryAdmission enforces evidence-backed gates for new evidence', () => {
  const manifest = loadSourceManifest();
  const [seeded] = manifest.entries;
  const withoutProof = validateManifestEntryAdmission(seeded, { corpusRoot: COMMITTED_CORPUS_ROOT });
  assert.equal(withoutProof.ok, true);
  assert.ok(!withoutProof.requirementsMet.includes(CORPUS_ADMISSION_PROOF_REQUIREMENT));

  const requiringProof = validateManifestEntryAdmission(seeded, {
    corpusRoot: COMMITTED_CORPUS_ROOT,
    requireFullCorpusRegressionProof: true,
  });
  assert.equal(requiringProof.ok, false);
  assert.ok(requiringProof.missingRequirements.includes(CORPUS_ADMISSION_PROOF_REQUIREMENT));

  const admission = validateManifestEntryAdmission(seeded, {
    corpusRoot: COMMITTED_CORPUS_ROOT,
    fullCorpusRegressionProven: true,
    requireFullCorpusRegressionProof: true,
  });
  assert.equal(admission.ok, true);
  assert.deepEqual(admission.requirementsMet.sort(), [
    CORPUS_ADMISSION_PROOF_REQUIREMENT,
    'ingestion',
    'sanitization',
    'schema_validation',
    'two_stable_captures',
    'unique_alignment',
  ]);

  const blockedAdmission = validateManifestEntryAdmission({
    id: 'blocked-new',
    seedStatus: 'blocked',
    limitations: ['incomplete oracle evidence'],
  }, { corpusRoot: COMMITTED_CORPUS_ROOT });
  assert.equal(blockedAdmission.ok, false);
  assert.ok(blockedAdmission.missingRequirements.includes('ingestion'));
});

test('validateManifestEntryAdmission rejects digest-shaped ingestion spoof without committed evidence', () => {
  const manifest = loadSourceManifest();
  const [seeded] = manifest.entries;
  const spoofed = {
    ...seeded,
    captureProvenance: {
      ...seeded.captureProvenance,
      stableCaptureHashes: ['sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
      oracleEvidenceDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    },
  };

  const admission = validateManifestEntryAdmission(spoofed, {
    corpusRoot: COMMITTED_CORPUS_ROOT,
    requireFullCorpusRegressionProof: true,
    fullCorpusRegressionProven: true,
  });
  assert.equal(admission.ok, false);
  assert.ok(admission.missingRequirements.includes('ingestion'));
  assert.ok(admission.missingRequirements.includes('two_stable_captures'));
});

test('evaluateCorpusDriftAll blocks live navigation when admission fails', async () => {
  const manifest = loadSourceManifest();
  let navigationCount = 0;

  await assert.rejects(
    () => evaluateCorpusDriftAll({
      manifest: {
        ...manifest,
        entries: manifest.entries.map((entry) => ({
          ...entry,
          captureProvenance: entry.captureProvenance
            ? {
              ...entry.captureProvenance,
              stableCaptureHashes: ['sha256:bad', 'sha256:bad'],
            }
            : entry.captureProvenance,
        })),
      },
      corpusRoot: COMMITTED_CORPUS_ROOT,
      skipFrozenRegression: true,
      captureEntry: async () => {
        navigationCount += 1;
        return { snapshot: {}, findings: [] };
      },
    }),
    /admission failed|stable capture|ingestion/i,
  );

  assert.equal(navigationCount, 0);
});

test('assertBlockedEntriesIsolated fails when blocked manifest entry maps to committed corpus case', () => {
  const tempRoot = createTestTempDir('blocked-isolation-');
  const corpusRoot = path.join(tempRoot, 'corpus');
  mkdirSync(path.join(corpusRoot, 'cases/site-blocked'), { recursive: true });
  writeFileSync(path.join(corpusRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: '1.0.0',
    cases: [{ id: 'site-blocked', path: 'cases/site-blocked' }],
  }, null, 2)}\n`);

  const manifest = {
    schemaVersion: '1.0.0',
    entries: [{
      id: 'site-blocked',
      label: 'Blocked',
      sourceUrl: 'https://example.test/blocked',
      seedStatus: 'blocked',
      caseId: 'site-blocked',
      limitations: ['oracle gap'],
    }],
  };

  assert.throws(
    () => assertBlockedEntriesIsolated(manifest, corpusRoot),
    /blocked/i,
  );

  rmSync(tempRoot, { recursive: true, force: true });
});

test('evaluateManifestEntryDrift isolates per-case capture failures and continues', async () => {
  const manifest = loadSourceManifest();
  const entries = manifest.entries.slice(0, 2);
  const firstContext = loadCorpusCaseContext(path.join(COMMITTED_CORPUS_ROOT, 'cases', String(entries[0].caseId)));
  const captureResults = new Map([
    [String(entries[0].caseId), {
      snapshot: firstContext.snapshot,
      findings: firstContext.expected.findings,
    }],
    [String(entries[1].caseId), { error: new Error('live capture failed') }],
  ]);

  const results = [];
  for (const entry of entries) {
    results.push(await evaluateManifestEntryDrift({
      entry,
      corpusRoot: COMMITTED_CORPUS_ROOT,
      captureEntry: async ({ entry: current }) => {
        const outcome = captureResults.get(String(current.caseId));
        if (!outcome || outcome.error) {
          throw outcome?.error || new Error('missing capture stub');
        }
        return outcome;
      },
    }));
  }

  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].errorCode, 'capture_failure');
});

test('evaluateCorpusDriftAll runs every seeded manifest entry with aggregate observed exit code', async () => {
  const manifest = loadSourceManifest();
  const driftCaseId = 'site-695';

  const result = await evaluateCorpusDriftAll({
    manifest,
    corpusRoot: COMMITTED_CORPUS_ROOT,
    skipFrozenRegression: true,
    captureEntry: async ({ entry, context }) => ({
      snapshot: context.snapshot,
      findings: entry.id === driftCaseId
        ? [{
          ruleId: 'ListEmpty',
          canonicalRuleId: 'ListEmpty',
          violationType: 'confirmed',
          evidence: { checkId: 'lists:list-empty' },
          element: {
            semantic: {
              tag: 'main',
              role: null,
              attributes: {},
              landmarkPath: [],
              ordinal: 0,
              framePath: [],
              shadowPath: [],
            },
          },
        }]
        : context.expected.findings,
    }),
  });

  assert.equal(result.caseCount, 8);
  assert.equal(result.observedExitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.driftCount, 1);
  assert.equal(result.errorCount, 0);
  assert.ok(result.cases.every((entry) => typeof entry.caseId === 'string'));
  assert.ok(result.cases.every((entry) => !('sourceUrl' in entry)));
});

test('drift artifact payload and summary stay neutral without source URLs or raw DOM', () => {
  const payload = buildDriftArtifactPayload({
    ok: false,
    observedExitCode: 1,
    caseCount: 1,
    driftCount: 1,
    errorCount: 0,
    cases: [{
      caseId: 'site-728',
      ok: false,
      snapshotDrift: true,
      findingsEquivalent: false,
      diff: {
        equivalent: false,
        missing: ['ListEmpty|ul|main|0'],
        extra: [],
        changed: [],
      },
      classification: { counts: { oracle_drift: 1 } },
      metrics: { precision: 0, recall: 0, expectedCount: 1, actualCount: 0 },
      snapshotIdentity: {
        committed: 'sha256:committed',
        candidate: 'sha256:candidate',
      },
    }],
  });

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /sourceUrl|paradox\.ai|mchire\.com|outerHTML/i);
  assert.equal(payload.mode, 'manifest-all');
  assert.equal(payload.observedExitCode, 1);

  const summary = buildDriftHumanSummary(payload);
  assert.match(summary, /site-728/);
  assert.doesNotMatch(summary, /sourceUrl|paradox\.ai|mchire\.com/i);

  const sanitizedCase = serializeDriftCaseResult({
    caseId: 'site-728',
    ok: false,
    candidateSnapshot: {
      elements: [{ outerHTML: '<ul class="vendor-secret"></ul>', tag: 'ul' }],
    },
    committedSnapshot: {
      elements: [{ outerHTML: '<ul></ul>', tag: 'ul' }],
    },
  });
  assert.equal('candidateSnapshot' in sanitizedCase, false);
  assert.equal('committedSnapshot' in sanitizedCase, false);
  assert.equal('sourceUrl' in sanitizedCase, false);
});

test('corpus drift CLI supports manifest --all mode with deterministic JSON and artifact files', async () => {
  const outputDir = createTestTempDir('drift-cli-all-');
  const manifest = loadSourceManifest();
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');

  const code = await runCorpusDriftCli([
    '--all',
    '--root', COMMITTED_CORPUS_ROOT,
    '--manifest', path.join(PACKAGE_ROOT, 'scripts/accessscan-corpus/source-manifest.json'),
    '--output-dir', outputDir,
    '--capture-fixture-mode', 'committed',
  ]);

  assert.equal(code, 0);
  assert.equal(existsSync(path.join(outputDir, 'drift-report.json')), true);
  assert.equal(existsSync(path.join(outputDir, 'drift-summary.md')), true);

  const artifact = JSON.parse(readFileSync(path.join(outputDir, 'drift-report.json'), 'utf8'));
  assert.equal(artifact.command, 'corpus:drift');
  assert.equal(artifact.mode, 'manifest-all');
  assert.equal(artifact.caseCount, 8);
  assert.equal(artifact.ok, true);
  assert.ok(artifact.cases.every((entry) => entry.ok === true));

  rmSync(outputDir, { recursive: true, force: true });
});

test('corpus drift CLI --all returns nonzero on drift while workflow wrapper remains successful', () => {
  const outputDir = createTestTempDir('drift-cli-drift-');
  const { stdout, status } = runCli('scripts/accessscan-corpus/drift.js', [
    '--all',
    '--root', COMMITTED_CORPUS_ROOT,
    '--manifest', path.join(PACKAGE_ROOT, 'scripts/accessscan-corpus/source-manifest.json'),
    '--output-dir', outputDir,
    '--capture-fixture-snapshot', path.join(FIXTURE_ROOT, 'snapshot-neutral-unstable.json'),
    '--capture-fixture-report', path.join(FIXTURE_ROOT, 'report-neutral-empty-list.json'),
  ]);
  assert.equal(status, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.observedExitCode, 1);
  assert.ok(payload.driftCount >= 1);

  const wrapper = spawnSync('bash', [
    path.join(PACKAGE_ROOT, 'scripts/accessscan-corpus/run-drift-nonblocking.sh'),
    outputDir,
  ], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: testSubprocessEnv(),
  });
  assert.equal(wrapper.status, 0, wrapper.stderr || wrapper.stdout);

  rmSync(outputDir, { recursive: true, force: true });
});
