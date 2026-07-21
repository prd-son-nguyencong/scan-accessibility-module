import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFindingsIdentity,
  captureLiveStableDriftCandidate,
} from '../scripts/accessscan-corpus/lib/live-drift-capture.js';
import { loadCorpusCaseContext } from '../scripts/accessscan-corpus/lib/replay.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

test('captureLiveStableDriftCandidate uses two atomic same-state passes without a third scan session', async () => {
  const context = loadCorpusCaseContext(`${COMMITTED_CORPUS_ROOT}/cases/site-728`);
  let sessionCount = 0;
  let passCount = 0;

  const outcome = await captureLiveStableDriftCandidate({
    sourceUrl: 'https://hitachi728.preview.sites.stg.paradox.ai/',
    context,
    navigate: async () => {},
    atomicPass: async () => {
      passCount += 1;
      sessionCount += 1;
      return {
        snapshot: context.snapshot,
        findings: context.expected.findings,
      };
    },
  });

  assert.equal(passCount, 2);
  assert.equal(sessionCount, 2);
  assert.equal(outcome.passes.length, 2);
  assert.equal(outcome.passes[0].snapshotIdentity, outcome.passes[1].snapshotIdentity);
  assert.equal(outcome.passes[0].findingsIdentity, outcome.passes[1].findingsIdentity);
  assert.equal(outcome.driftBasis, 'scanner-vs-frozen-oracle');
  assert.equal(outcome.findings.length, context.expected.findings.length);
});

test('buildFindingsIdentity is deterministic for aligned findings', () => {
  const identity = buildFindingsIdentity([
    {
      ruleId: 'ListEmpty',
      canonicalRuleId: 'ListEmpty',
      element: { semantic: { tag: 'ul', landmarkPath: ['main'], ordinal: 0 } },
    },
  ]);
  assert.match(identity, /ListEmpty\|/);
});
