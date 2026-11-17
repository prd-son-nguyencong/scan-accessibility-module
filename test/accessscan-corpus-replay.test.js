import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AccessScanUnknownProfileError } from '../src/scanner/access-scan/index.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import { corpusFindingsEquivalent } from '../src/scanner/access-scan/corpus/diff.js';
import {
  loadCorpusCaseContext,
  replayCorpusCaseWithPlaywright,
} from '../scripts/accessscan-corpus/lib/replay.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

test('replayCorpusCaseWithPlaywright replays standards profile fixture with exact parity', async () => {
  const context = loadCorpusCaseContext(path.join(CORPUS_ROOT, 'cases/neutral-empty-list'));
  assert.equal(context.meta.profile, PROFILES.STANDARDS);
  assert.equal(context.expected.profile, PROFILES.STANDARDS);

  const actualFindings = await replayCorpusCaseWithPlaywright(context);
  const expectedFindings = Array.isArray(context.expected.findings) ? context.expected.findings : [];

  assert.equal(
    corpusFindingsEquivalent(expectedFindings, actualFindings),
    true,
    'standards replay findings must match expected.json',
  );
});

test('replayCorpusCaseWithPlaywright rejects unknown corpus profile before scan', async () => {
  const context = loadCorpusCaseContext(path.join(CORPUS_ROOT, 'cases/neutral-empty-list'));
  context.meta.profile = 'legacy-overlay';

  await assert.rejects(
    () => replayCorpusCaseWithPlaywright(context),
    (error) => {
      assert.ok(error instanceof AccessScanUnknownProfileError);
      assert.equal(error.errorCode, 'unknown_profile');
      assert.equal(error.profile, 'legacy-overlay');
      return true;
    },
  );
});
