import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestTempDir, testSubprocessEnv } from './helpers/accessscan-corpus-test-temp.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus-tooling');
const COMMITTED_CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');
const PACKAGE_ROOT = path.join(__dirname, '..');

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

test('corpus verify CLI is import-safe and replays fixtures with deterministic JSON', () => {
  const source = readFileSync(path.join(PACKAGE_ROOT, 'scripts/accessscan-corpus/verify.js'), 'utf8');
  assert.match(source, /runCorpusVerifyCli/);
  assert.doesNotMatch(source, /playwright/i);

  const { stdout, status } = runCli('scripts/accessscan-corpus/verify.js', [
    '--root',
    COMMITTED_CORPUS_ROOT,
  ]);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'corpus:verify');
  assert.equal(payload.caseCount, 9);
  assert.equal(payload.cases.find((entry) => entry.id === 'neutral-empty-list')?.diff.equivalent, true);
  const siteCases = payload.cases.filter((entry) => entry.id.startsWith('site-'));
  assert.equal(siteCases.length, 8);
  assert.ok(siteCases.every((entry) => entry.diff?.equivalent === true));
  assert.ok(siteCases.every((entry) => entry.replaySkipped !== true));
});

test('corpus capture CLI fails closed without live services when inputs are incomplete', () => {
  const { stdout, status } = runCli('scripts/accessscan-corpus/capture.js', []);
  assert.equal(status, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorCode, 'incomplete_report');
});

test('corpus capture CLI documents non-initial pageState limitation in help output', () => {
  const { stdout, status } = runCli('scripts/accessscan-corpus/capture.js', ['--help']);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.limitations));
  assert.match(payload.limitations.join(' '), /initial/i);
});

test('corpus capture CLI rejects non-initial pageState for live url capture', () => {
  const draftRoot = createTestTempDir('cli-page-state-');
  const draftDir = path.join(draftRoot, 'menu-open-case');
  const reportPath = path.join(draftRoot, 'report-menu-open.json');
  writeReportFixture(reportPath, {
    profile: 'standards',
    route: '/',
    pageState: 'menu-open',
    viewport: { width: 1280, height: 900 },
    findings: [
      {
        ruleId: 'ListEmpty',
        canonicalRuleId: 'ListEmpty',
        violationType: 'confirmed',
        evidence: { checkId: 'lists:list-empty' },
        element: {
          selector: 'main > ul:nth-of-type(1)',
          outerHTML: '<ul></ul>',
          framePath: [],
          shadowPath: [],
        },
      },
    ],
  });

  const { stdout, status } = runCli('scripts/accessscan-corpus/capture.js', [
    '--draft', draftDir,
    '--id', 'menu-open-case',
    '--report', reportPath,
    '--url', 'https://example.com',
  ]);
  assert.equal(status, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.errorCode, 'unsupported_page_state');
  assert.match(payload.message, /initial/i);

  rmSync(draftRoot, { recursive: true, force: true });
});

test('corpus capture CLI generates draft from injectable local fixtures', () => {
  const draftRoot = createTestTempDir('cli-draft-');
  const draftDir = path.join(draftRoot, 'cli-neutral-empty-list');

  const { stdout, status } = runCli('scripts/accessscan-corpus/capture.js', [
    '--draft', draftDir,
    '--id', 'cli-neutral-empty-list',
    '--report', path.join(FIXTURE_ROOT, 'report-neutral-empty-list.json'),
    '--snapshot', path.join(FIXTURE_ROOT, 'snapshot-neutral-stable.json'),
    '--page-html', path.join(COMMITTED_CORPUS_ROOT, 'cases/neutral-empty-list/page.html'),
  ]);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.caseId, 'cli-neutral-empty-list');
  assert.deepEqual(payload.files.sort(), ['expected.json', 'meta.json', 'page.html', 'snapshot.json']);

  rmSync(draftRoot, { recursive: true, force: true });
});

test('corpus drift CLI reports equivalent local fixtures with deterministic JSON', () => {
  const { stdout, status } = runCli('scripts/accessscan-corpus/drift.js', [
    '--root', COMMITTED_CORPUS_ROOT,
    '--case-id', 'neutral-empty-list',
    '--snapshot', path.join(FIXTURE_ROOT, 'snapshot-neutral-stable.json'),
    '--report', path.join(FIXTURE_ROOT, 'report-neutral-empty-list.json'),
  ]);
  assert.equal(status, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.findingsEquivalent, true);
  assert.equal(payload.snapshotDrift, false);
});

test('corpus capture CLI rejects forbidden committed fixture output root', () => {
  const { stdout, status } = runCli('scripts/accessscan-corpus/capture.js', [
    '--draft', path.join(COMMITTED_CORPUS_ROOT, 'cases/forbidden-draft'),
    '--id', 'forbidden-draft',
    '--report', path.join(FIXTURE_ROOT, 'report-neutral-empty-list.json'),
    '--snapshot', path.join(FIXTURE_ROOT, 'snapshot-neutral-stable.json'),
  ]);
  assert.equal(status, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.errorCode, 'forbidden_output_root');
});

function writeReportFixture(filePath, report) {
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
