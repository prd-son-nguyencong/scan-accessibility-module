import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readCorpusCaseFile,
  reassertSafeCorpusCaseDir,
} from '../scripts/accessscan-corpus/lib/corpus-case-read.js';
import { createTestTempDir } from './helpers/accessscan-corpus-test-temp.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

test('reassertSafeCorpusCaseDir rejects symlink escape before reads', () => {
  const tempRoot = createTestTempDir('case-read-symlink-');
  const corpusRoot = path.join(tempRoot, 'corpus');
  const casesRoot = path.join(corpusRoot, 'cases');
  const outside = path.join(tempRoot, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(casesRoot, { recursive: true });
  writeFileSync(path.join(outside, 'secret.json'), '{"leak":true}\n');
  symlinkSync(outside, path.join(casesRoot, 'site-evil'));

  assert.throws(
    () => reassertSafeCorpusCaseDir(path.join(casesRoot, 'site-evil'), corpusRoot),
    /symlink|escape|forbidden/i,
  );

  rmSync(tempRoot, { recursive: true, force: true });
});

test('readCorpusCaseFile reasserts containment immediately before each read', () => {
  const caseDir = path.join(COMMITTED_CORPUS_ROOT, 'cases/site-728');
  const meta = readCorpusCaseFile(caseDir, 'meta.json', COMMITTED_CORPUS_ROOT);
  assert.match(meta, /viewport|"profile"/);
  assert.throws(
    () => readCorpusCaseFile(caseDir, '../manifest.json', COMMITTED_CORPUS_ROOT),
    /traversal|forbidden/i,
  );
});

test('readCorpusCaseFile fails closed when case path becomes symlink escape', () => {
  const tempRoot = createTestTempDir('case-read-swap-');
  const corpusRoot = path.join(tempRoot, 'corpus');
  const casesRoot = path.join(corpusRoot, 'cases');
  const outside = path.join(tempRoot, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(casesRoot, { recursive: true });
  writeFileSync(path.join(outside, 'meta.json'), '{"leak":true}\n');
  symlinkSync(outside, path.join(casesRoot, 'site-evil'));

  assert.throws(
    () => readCorpusCaseFile(path.join(casesRoot, 'site-evil'), 'meta.json', corpusRoot),
    /symlink|escape|forbidden/i,
  );

  rmSync(tempRoot, { recursive: true, force: true });
});
