import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPUS_TOOLING_ERROR_CODES,
  CorpusToolingError,
  alignFindingToSnapshot,
  assertNoRedactionLeaks,
  buildSnapshotIdentity,
  canonicalizeExternalRuleAlias,
  captureStableSnapshot,
  evaluateCorpusDrift,
  findRedactionLeaks,
  generateDraftCase,
  ingestAccessScanReport,
  normalizeReportFindings,
  resolveDraftDir,
  sanitizeSnapshot,
  sanitizeTextValue,
  setAllowedRuleIdsForTests,
  setCommittedFixtureRootForTests,
  snapshotsSemanticallyEqual,
  verifyCorpus,
} from '../scripts/accessscan-corpus/index.js';
import { createTestTempDir } from './helpers/accessscan-corpus-test-temp.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus-tooling');
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

test('snapshots with different volatile ids share semantic identity', () => {
  const left = loadFixture('snapshot-neutral-stable.json');
  const right = loadFixture('snapshot-neutral-stable-alt-ids.json');
  assert.equal(snapshotsSemanticallyEqual(left, right), true);
  assert.notEqual(buildSnapshotIdentity(left), buildSnapshotIdentity(loadFixture('snapshot-neutral-unstable.json')));
});

test('captureStableSnapshot requires two semantically stable captures', async () => {
  const stable = loadFixture('snapshot-neutral-stable.json');
  const unstable = loadFixture('snapshot-neutral-unstable.json');

  const stableResult = await captureStableSnapshot({
    captureAdapter: async () => stable,
  });
  assert.equal(stableResult.elements.length, 3);

  await assert.rejects(
    () => captureStableSnapshot({
      captureAdapter: async ({ attempt }) => (attempt === 1 ? stable : unstable),
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.UNSTABLE_CAPTURE,
  );
});

test('ingestAccessScanReport fails closed on incomplete oracle payload', () => {
  assert.throws(
    () => ingestAccessScanReport({ profile: 'standards' }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
  );
});

test('canonicalizeExternalRuleAlias fails closed on unknown commercial alias', async () => {
  setAllowedRuleIdsForTests(new Set(['ListEmpty', 'HtmlLangValid']));

  await assert.rejects(
    () => canonicalizeExternalRuleAlias('TotallyUnknownCommercialRule', { profile: 'commercial-parity' }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.UNKNOWN_ALIAS,
  );
  assert.deepEqual(await canonicalizeExternalRuleAlias('ListNotEmpty'), {
    nativeRuleId: 'ListEmpty',
    canonicalRuleId: 'ListEmpty',
  });
  assert.deepEqual(await canonicalizeExternalRuleAlias('HtmlLangValid'), {
    nativeRuleId: 'HtmlLangValid',
    canonicalRuleId: 'HtmlLangValid',
  });
});

test('alignFindingToSnapshot fails closed on ambiguous sibling matches', async () => {
  const snapshot = sanitizeSnapshot(loadFixture('snapshot-ambiguous-siblings.json'));
  const report = ingestAccessScanReport(loadFixture('report-ambiguous-alignment.json'));
  const findings = await normalizeReportFindings(report);
  const [finding] = findings;

  assert.throws(
    () => alignFindingToSnapshot(snapshot, finding),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.AMBIGUOUS_ALIGNMENT,
  );
});

test('alignFindingToSnapshot aligns exact selector and outerHTML evidence positively', async () => {
  const snapshot = sanitizeSnapshot(loadFixture('snapshot-neutral-stable.json'));
  const report = ingestAccessScanReport(loadFixture('report-neutral-empty-list.json'));
  const [finding] = await normalizeReportFindings(report);
  const aligned = alignFindingToSnapshot(snapshot, finding);

  assert.equal(aligned.element.semantic.tag, 'ul');
  assert.equal(aligned.element.semantic.ordinal, 0);
});

test('alignFindingToSnapshot rejects misleading html substring matches without corroboration', async () => {
  const snapshot = sanitizeSnapshot(loadFixture('snapshot-misleading-html-substring.json'));
  const report = ingestAccessScanReport(loadFixture('report-misleading-html-substring.json'));
  const [finding] = await normalizeReportFindings(report);
  const aligned = alignFindingToSnapshot(snapshot, finding);

  assert.equal(aligned.element.semantic.tag, 'ul');
  assert.equal(aligned.element.semantic.ordinal, 0);
});

test('alignFindingToSnapshot fails closed when generic selector evidence is insufficient', async () => {
  const snapshot = sanitizeSnapshot(loadFixture('snapshot-neutral-stable.json'));
  const report = ingestAccessScanReport(loadFixture('report-generic-selector-insufficient.json'));
  const [finding] = await normalizeReportFindings(report);

  assert.throws(
    () => alignFindingToSnapshot(snapshot, finding),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.NO_MATCH,
  );
});

test('canonicalizeExternalRuleAlias accepts scoped allowedRuleIds without module overrides', async () => {
  await assert.rejects(
    () => canonicalizeExternalRuleAlias('TotallyUnknownCommercialRule', {
      profile: 'commercial-parity',
      allowedRuleIds: new Set(['ListEmpty']),
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.UNKNOWN_ALIAS,
  );

  assert.deepEqual(
    await canonicalizeExternalRuleAlias('ListEmpty', {
      profile: 'standards',
      allowedRuleIds: new Set(['ListEmpty']),
    }),
    { nativeRuleId: 'ListEmpty', canonicalRuleId: 'ListEmpty' },
  );
});

test('sanitizeTextValue redacts api keys Bearer tokens and secrets', () => {
  assert.match(sanitizeTextValue('api_key=supersecret'), /neutral-secret-/i);
  assert.match(sanitizeTextValue('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload'), /neutral-secret-/i);
  assert.match(sanitizeTextValue('token=abc123'), /neutral-secret-/i);
  assert.doesNotMatch(sanitizeTextValue('neutral visible text'), /neutral-secret-|neutral-token-/i);
});

test('findRedactionLeaks and assertNoRedactionLeaks fail closed on brand and host leakage', () => {
  const leaks = findRedactionLeaks('https://vendor.example/jobs and mcdonald', 'payload');
  assert.ok(leaks.some((entry) => /host or URL leakage/i.test(entry)));
  assert.ok(leaks.some((entry) => /forbidden token/i.test(entry)));

  assert.throws(
    () => assertNoRedactionLeaks({ 'snapshot.json': '{"text":"mcdonald"}' }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.REDACTION_LEAK,
  );
});

test('resolveDraftDir rejects committed fixture root', () => {
  setCommittedFixtureRootForTests(COMMITTED_CORPUS_ROOT);
  assert.throws(
    () => resolveDraftDir(COMMITTED_CORPUS_ROOT),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
  );
  assert.throws(
    () => resolveDraftDir(path.join(COMMITTED_CORPUS_ROOT, 'cases/neutral-empty-list')),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_OUTPUT_ROOT,
  );
});

test('generateDraftCase writes deterministic sanitized draft without overwriting', async () => {
  const draftRoot = createTestTempDir('draft-');
  const draftDir = path.join(draftRoot, 'neutral-empty-list');
  const stable = loadFixture('snapshot-neutral-stable.json');
  const report = loadFixture('report-neutral-empty-list.json');

  const first = await generateDraftCase({
    id: 'neutral-empty-list',
    draftDir,
    report,
    captureAdapter: async () => stable,
    pageHtml: '<main><ul></ul></main>',
  });

  assert.deepEqual(first.files.sort(), ['expected.json', 'meta.json', 'page.html', 'snapshot.json']);
  assert.equal(existsSync(path.join(draftDir, 'meta.json')), true);
  assert.equal(existsSync(path.join(draftDir, 'snapshot.json')), true);
  assert.equal(existsSync(path.join(draftDir, 'expected.json')), true);
  assert.equal(existsSync(path.join(draftDir, 'page.html')), true);

  const expected = JSON.parse(readFileSync(path.join(draftDir, 'expected.json'), 'utf8'));
  assert.equal(expected.findings.length, 1);
  assert.equal(expected.findings[0].ruleId, 'ListEmpty');
  assert.equal(expected.findings[0].element.semantic.tag, 'ul');
  assert.equal(expected.findings[0].element.semantic.ordinal, 0);

  await assert.rejects(
    () => generateDraftCase({
      id: 'neutral-empty-list',
      draftDir,
      report,
      captureAdapter: async () => stable,
    }),
    (error) => error instanceof CorpusToolingError
      && error.errorCode === CORPUS_TOOLING_ERROR_CODES.OUTPUT_EXISTS,
  );

  rmSync(draftRoot, { recursive: true, force: true });
});

test('verifyCorpus validates committed fixtures deterministically', async () => {
  const result = await verifyCorpus(COMMITTED_CORPUS_ROOT, {
    scanCase: async (context) => context.expected.findings,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cases.length, 9);
  assert.equal(result.cases.filter((entry) => entry.id === 'neutral-empty-list').length, 1);
});

test('verifyCorpus replays all eight seeded cross-site fixtures with exact parity', async () => {
  const result = await verifyCorpus(COMMITTED_CORPUS_ROOT);
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(result.cases.length, 9);
  const seeded = result.cases.filter((entry) => entry.id.startsWith('site-'));
  assert.equal(seeded.length, 8);
  assert.ok(seeded.every((entry) => entry.ok === true));
  assert.ok(seeded.every((entry) => entry.diff?.equivalent === true));
  assert.ok(seeded.every((entry) => entry.replaySkipped !== true));
});

test('evaluateCorpusDrift reports no drift for aligned local fixtures', async () => {
  const snapshot = sanitizeSnapshot(loadFixture('snapshot-neutral-stable.json'));
  const report = loadFixture('report-neutral-empty-list.json');
  const drift = await evaluateCorpusDrift({
    caseId: 'neutral-empty-list',
    corpusRoot: COMMITTED_CORPUS_ROOT,
    snapshot,
    report,
  });
  assert.equal(drift.ok, true);
  assert.equal(drift.findingsEquivalent, true);
  assert.equal(drift.snapshotDrift, false);
});

test('evaluateCorpusDrift reports drift when snapshot identity changes', async () => {
  const drift = await evaluateCorpusDrift({
    caseId: 'neutral-empty-list',
    corpusRoot: COMMITTED_CORPUS_ROOT,
    snapshot: sanitizeSnapshot(loadFixture('snapshot-neutral-unstable.json')),
    report: loadFixture('report-neutral-empty-list.json'),
  });
  assert.equal(drift.ok, false);
  assert.equal(drift.snapshotDrift, true);
});
