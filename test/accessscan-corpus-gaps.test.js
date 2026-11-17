import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPUS_TOOLING_ERROR_CODES,
  CorpusToolingError,
  captureStableSnapshot,
  canonicalizeExternalRuleAlias,
  generateDraftCase,
  loadCorpusCaseContext,
  reassertDraftPathSafe,
  replayCorpusCaseWithPlaywright,
  resolveDraftDir,
  setAllowedRuleIdsForTests,
  setCommittedFixtureRootForTests,
  setDraftPathGuardForTests,
  verifyCorpus,
  verifyCorpusCaseDiff,
} from '../scripts/accessscan-corpus/index.js';
import { listAccessScanCatalogRuleIds } from '../src/scanner/access-scan/engine/public-catalog.js';
import { createTestTempDir } from './helpers/accessscan-corpus-test-temp.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus-tooling');
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

test('resolveDraftDir rejects symlink bypass into committed corpus root', () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);
  const tempRoot = createTestTempDir('symlink-');
  const linkPath = path.join(tempRoot, 'bypass-link');
  symlinkSync(COMMITTED_CORPUS_ROOT, linkPath);

  assert.throws(
    () => resolveDraftDir(path.join(linkPath, 'draft-case')),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
  );

  const nested = path.join(tempRoot, 'safe', 'nested');
  mkdirSync(nested, { recursive: true });
  const componentLink = path.join(nested, 'into-corpus');
  symlinkSync(COMMITTED_CORPUS_ROOT, componentLink);
  assert.throws(
    () => resolveDraftDir(path.join(componentLink, 'draft-case')),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
  );

  rmSync(tempRoot, { recursive: true, force: true });
});

test('resolveDraftDir allows symlink prefix when resolved destination is outside committed corpus', () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);
  const tempRoot = createTestTempDir('prefix-');
  const realParent = path.join(tempRoot, 'real-parent');
  mkdirSync(realParent);
  const linkPrefix = path.join(tempRoot, 'link-prefix');
  symlinkSync(realParent, linkPrefix);

  const draftDir = path.join(linkPrefix, 'new', 'draft-case');
  assert.equal(resolveDraftDir(draftDir), path.resolve(draftDir));

  rmSync(tempRoot, { recursive: true, force: true });
});

test('resolveDraftDir allows macOS /tmp and /var symlink prefixes outside committed corpus', () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);

  for (const prefix of ['/tmp', '/var']) {
    if (!existsSync(prefix) || !lstatSync(prefix).isSymbolicLink()) {
      continue;
    }

    const draftDir = path.join(prefix, 'ada-corpus-draft-safe', 'case-id');
    assert.equal(resolveDraftDir(draftDir), path.resolve(draftDir));
    assert.notEqual(
      realpathSync(prefix),
      realpathSync(COMMITTED_CORPUS_ROOT),
    );
  }
});

test('generateDraftCase reasserts resolved draft path before mkdir and every exclusive write', async () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);
  const draftRoot = createTestTempDir('reassert-');
  const draftDir = path.join(draftRoot, 'reassert-case');
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');
  /** @type {string[]} */
  const phases = [];

  setDraftPathGuardForTests({
    reassert: (dir) => {
      phases.push('reassert');
      return reassertDraftPathSafe(dir);
    },
  });

  await generateDraftCase({
    id: 'reassert-case',
    draftDir,
    report,
    captureAdapter: async () => stable,
  });
  assert.deepEqual(phases, ['reassert', 'reassert', 'reassert', 'reassert']);

  rmSync(draftRoot, { recursive: true, force: true });
});

test('generateDraftCase rejects parent symlink swap detected at write-time reassert', async () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);
  const tempRoot = createTestTempDir('swap-');
  const parentDir = path.join(tempRoot, 'parent');
  mkdirSync(parentDir);
  const draftDir = path.join(parentDir, 'draft-case');
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');
  let swapDone = false;

  setDraftPathGuardForTests({
    reassert: (dir) => {
      if (!swapDone) {
        swapDone = true;
        rmSync(parentDir, { recursive: true, force: true });
        symlinkSync(COMMITTED_CORPUS_ROOT, parentDir);
      }
      return reassertDraftPathSafe(dir);
    },
  });

  await assert.rejects(
    () => generateDraftCase({
      id: 'swap-case',
      draftDir,
      report,
      captureAdapter: async () => stable,
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
  );
  assert.equal(existsSync(path.join(COMMITTED_CORPUS_ROOT, 'draft-case')), false);

  rmSync(tempRoot, { recursive: true, force: true });
});

test('generateDraftCase rejects parent symlink swap between file writes', async () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);
  const tempRoot = createTestTempDir('swap-between-');
  const parentDir = path.join(tempRoot, 'parent');
  mkdirSync(parentDir);
  const draftDir = path.join(parentDir, 'draft-case');
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');
  let reassertCount = 0;

  setDraftPathGuardForTests({
    reassert: (dir) => {
      reassertCount += 1;
      if (reassertCount === 3) {
        rmSync(parentDir, { recursive: true, force: true });
        symlinkSync(COMMITTED_CORPUS_ROOT, parentDir);
      }
      return reassertDraftPathSafe(dir);
    },
  });

  await assert.rejects(
    () => generateDraftCase({
      id: 'swap-between-case',
      draftDir,
      report,
      captureAdapter: async () => stable,
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
  );
  assert.equal(existsSync(path.join(COMMITTED_CORPUS_ROOT, 'draft-case')), false);

  rmSync(tempRoot, { recursive: true, force: true });
});

test('generateDraftCase uses exclusive writes and maps EEXIST to output_exists', async () => {
  const draftRoot = createTestTempDir('exclusive-');
  const draftDir = path.join(draftRoot, 'exclusive-case');
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');

  await generateDraftCase({
    id: 'exclusive-case',
    draftDir,
    report,
    captureAdapter: async () => stable,
  });

  await assert.rejects(
    () => generateDraftCase({
      id: 'exclusive-case',
      draftDir,
      report,
      captureAdapter: async () => stable,
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.OUTPUT_EXISTS,
  );

  rmSync(draftRoot, { recursive: true, force: true });
});

test('generateDraftCase does not leave partial drafts when exclusive write fails', async () => {
  const draftRoot = createTestTempDir('partial-');
  const draftDir = path.join(draftRoot, 'partial-case');
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');

  await mkdir(draftDir, { recursive: true });
  await writeFile(path.join(draftDir, 'expected.json'), '{}\n');

  await assert.rejects(
    () => generateDraftCase({
      id: 'partial-case',
      draftDir,
      report,
      captureAdapter: async () => stable,
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.OUTPUT_EXISTS,
  );

  const files = ['meta.json', 'snapshot.json', 'page.html'];
  for (const fileName of files) {
    assert.equal(existsSync(path.join(draftDir, fileName)), false);
  }

  rmSync(draftRoot, { recursive: true, force: true });
});

test('captureStableSnapshot propagates viewport and fails closed on unsupported page state', async () => {
  const stable = loadFixture('snapshot-neutral-stable.json');
  /** @type {Record<string, unknown>[]} */
  const contexts = [];

  await captureStableSnapshot({
    captureState: 'initial',
    viewport: { width: 1440, height: 900 },
    captureAdapter: async (context) => {
      contexts.push(context);
      return stable;
    },
  });

  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[0].viewport, { width: 1440, height: 900 });
  assert.equal(contexts[0].captureState, 'initial');

  await assert.rejects(
    () => captureStableSnapshot({
      captureState: 'menu-open',
      viewport: { width: 1280, height: 900 },
      captureAdapter: async () => stable,
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.UNSUPPORTED_PAGE_STATE,
  );

  await captureStableSnapshot({
    captureState: 'menu-open',
    viewport: { width: 1280, height: 900 },
    stateAdapter: async () => {},
    captureAdapter: async (context) => {
      assert.equal(context.captureState, 'menu-open');
      return stable;
    },
  });
});

test('canonicalizeExternalRuleAlias rejects arbitrary unknown oracle ids without substring heuristics', async () => {
  setAllowedRuleIdsForTests(new Set(listAccessScanCatalogRuleIds()));

  await assert.rejects(
    () => canonicalizeExternalRuleAlias('OracleRuleXYZ', { profile: 'commercial-parity' }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.UNKNOWN_ALIAS,
  );

  await assert.rejects(
    () => canonicalizeExternalRuleAlias('OracleRuleXYZ', { profile: 'standards' }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.UNKNOWN_ALIAS,
  );

  assert.deepEqual(
    await canonicalizeExternalRuleAlias('ListNotEmpty', { profile: 'commercial-parity' }),
    { nativeRuleId: 'ListEmpty', canonicalRuleId: 'ListEmpty' },
  );
  assert.deepEqual(
    await canonicalizeExternalRuleAlias('ListEmpty', { profile: 'standards' }),
    { nativeRuleId: 'ListEmpty', canonicalRuleId: 'ListEmpty' },
  );
});

test('verifyCorpus replays cases and detects wrong-element drift with equal finding count', async () => {
  const caseDir = path.join(COMMITTED_CORPUS_ROOT, 'cases/neutral-empty-list');
  const context = loadCorpusCaseContext(caseDir);

  const wrongElementFinding = {
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
  };

  const result = await verifyCorpus(COMMITTED_CORPUS_ROOT, {
    scanCase: async () => [wrongElementFinding],
  });

  assert.equal(result.ok, false);
  const caseResult = result.cases.find((entry) => entry.id === 'neutral-empty-list');
  assert.ok(caseResult);
  assert.equal(caseResult.ok, false);
  assert.equal(caseResult.diff.equivalent, false);
  assert.equal(caseResult.diff.changed.length, 1);
  assert.equal(caseResult.diff.missing.length, 0);
  assert.equal(caseResult.diff.extra.length, 0);
});

test('replayCorpusCaseWithPlaywright reproduces neutral-empty-list expected findings', async () => {
  const caseDir = path.join(COMMITTED_CORPUS_ROOT, 'cases/neutral-empty-list');
  const context = loadCorpusCaseContext(caseDir);
  const actual = await replayCorpusCaseWithPlaywright(context);
  const result = verifyCorpusCaseDiff(caseDir, actual);
  assert.equal(result.ok, true);
});

test('verifyCorpus passes replay equivalence for matching injectable scan results', async () => {
  const caseDir = path.join(COMMITTED_CORPUS_ROOT, 'cases/neutral-empty-list');
  const context = loadCorpusCaseContext(caseDir);
  const expected = context.expected;

  const result = await verifyCorpus(COMMITTED_CORPUS_ROOT, {
    scanCase: async (caseContext) => (
      caseContext.meta.id === 'neutral-empty-list'
        ? expected.findings
        : replayCorpusCaseWithPlaywright(caseContext)
    ),
  });

  assert.equal(result.ok, true);
  const caseResult = result.cases.find((entry) => entry.id === 'neutral-empty-list');
  assert.equal(caseResult.ok, true);
  assert.equal(caseResult.diff.equivalent, true);
});
