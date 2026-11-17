import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCorpusCaseDir } from '../scripts/accessscan-corpus/lib/corpus-case-dir.js';
import { createTestTempDir } from './helpers/accessscan-corpus-test-temp.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

test('resolveCorpusCaseDir resolves committed cases and rejects malformed ids', () => {
  const caseDir = resolveCorpusCaseDir(COMMITTED_CORPUS_ROOT, 'site-728');
  assert.equal(existsSync(caseDir), true);
  assert.throws(() => resolveCorpusCaseDir(COMMITTED_CORPUS_ROOT, '../escape'), /caseId|case id/i);
  assert.throws(() => resolveCorpusCaseDir(COMMITTED_CORPUS_ROOT, 'UPPER'), /caseId|case id/i);
});

test('resolveCorpusCaseDir rejects symlink escape outside cases root', () => {
  const tempRoot = createTestTempDir('case-dir-symlink-');
  const corpusRoot = path.join(tempRoot, 'corpus');
  const casesRoot = path.join(corpusRoot, 'cases');
  const outside = path.join(tempRoot, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(casesRoot, { recursive: true });
  symlinkSync(outside, path.join(casesRoot, 'site-evil'));

  assert.throws(
    () => resolveCorpusCaseDir(corpusRoot, 'site-evil'),
    /symlink|escape|forbidden/i,
  );

  rmSync(tempRoot, { recursive: true, force: true });
});
