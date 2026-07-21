import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyCorpus } from '../scripts/accessscan-corpus/lib/verify.js';
import { runCorpusVerifyCli } from '../scripts/accessscan-corpus/verify.js';
import { createTestTempDir } from './helpers/accessscan-corpus-test-temp.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');
const PACKAGE_ROOT = path.join(__dirname, '..');

test('verifyCorpus fails when seeded source manifest entry lacks committed case', async () => {
  const tempRoot = createTestTempDir('verify-missing-case-');
  const manifestPath = path.join(tempRoot, 'fake-source-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      id: 'site-fake',
      label: 'Fake',
      sourceUrl: 'https://fake123.preview.sites.stg.paradox.ai/',
      seedStatus: 'seeded',
      caseId: 'site-fake',
      captureProvenance: {
        stableCaptureHashes: ['sha256:abc', 'sha256:abc'],
        captureMode: 'oracle-evidence-slice',
        oracleEvidenceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }],
  }, null, 2)}\n`);

  const result = await verifyCorpus(COMMITTED_CORPUS_ROOT, {
    schemaOnly: true,
    sourceManifestPath: manifestPath,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /missing committed corpus case site-fake|admission failed/i);

  writeFileSync(path.join(tempRoot, '.done'), '');
});

test('verifyCorpus fails when blocked source entry maps to committed corpus case', async () => {
  const tempRoot = createTestTempDir('verify-blocked-map-');
  const manifestPath = path.join(tempRoot, 'blocked-source-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      id: 'site-124',
      label: 'Blocked',
      sourceUrl: 'https://blocked123.preview.sites.stg.paradox.ai/',
      seedStatus: 'blocked',
      caseId: 'site-124',
      limitations: ['oracle gap'],
    }],
  }, null, 2)}\n`);

  const result = await verifyCorpus(COMMITTED_CORPUS_ROOT, {
    schemaOnly: true,
    sourceManifestPath: manifestPath,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /blocked/i);
});

test('corpus verify CLI remains blocking when source manifest admission fails', async () => {
  const tempRoot = createTestTempDir('verify-cli-block-');
  const manifestPath = path.join(tempRoot, 'fake-source-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      id: 'site-fake',
      label: 'Fake',
      sourceUrl: 'https://fake123.preview.sites.stg.paradox.ai/',
      seedStatus: 'seeded',
      caseId: 'site-fake',
      captureProvenance: {
        stableCaptureHashes: ['sha256:abc', 'sha256:abc'],
        captureMode: 'oracle-evidence-slice',
        oracleEvidenceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }],
  }, null, 2)}\n`);

  const code = await runCorpusVerifyCli([
    '--root', COMMITTED_CORPUS_ROOT,
    '--schema-only',
    '--source-manifest', manifestPath,
  ]);
  assert.equal(code, 1);
});
