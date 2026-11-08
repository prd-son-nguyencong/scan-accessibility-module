import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const REPO_ROOT = PACKAGE_ROOT;
const DRIFT_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/accessscan-drift.yml');
const CORPUS_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/accessscan-corpus.yml');
const DRIFT_WRAPPER = path.join(PACKAGE_ROOT, 'scripts/accessscan-corpus/run-drift-nonblocking.sh');

function readWorkflow(filePath) {
  return readFileSync(filePath, 'utf8');
}

test('accessscan-drift workflow is scheduled, manual, least-privilege, and non-blocking', () => {
  const workflow = readWorkflow(DRIFT_WORKFLOW);
  const wrapper = readFileSync(DRIFT_WRAPPER, 'utf8');

  assert.match(workflow, /on:\s*\n\s*schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /timeout-minutes:/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /pnpm\/action-setup/);
  assert.match(workflow, /playwright install/i);
  assert.match(workflow, /run-drift-nonblocking\.sh/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /retention-days:/);
  assert.match(wrapper, /drift\.js/);
  assert.match(wrapper, /--all/);
  assert.doesNotMatch(workflow, /secrets\./i);
  assert.doesNotMatch(workflow, /permissions:\s*\n\s*contents:\s*write/i);
});

test('accessscan-drift workflow records observed drift without failing the job', () => {
  const wrapper = readFileSync(DRIFT_WRAPPER, 'utf8');
  assert.match(wrapper, /observed_exit_code/i);
  assert.match(wrapper, /exit 0/);
});

test('accessscan-corpus workflow is a non-blocking frozen verify job on push and pull_request', () => {
  const workflow = readWorkflow(CORPUS_WORKFLOW);

  assert.match(workflow, /on:\s*\n\s*push:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /corpus:verify/);
  assert.match(workflow, /continue-on-error:\s*true/);
  assert.match(workflow, /playwright install/i);
  assert.doesNotMatch(workflow, /run-drift-nonblocking\.sh/);
  assert.doesNotMatch(workflow, /exit 0\s*#.*non-blocking/i);
});

test('accessscan-corpus workflow runs verify only', () => {
  const workflow = readWorkflow(CORPUS_WORKFLOW);
  assert.match(workflow, /corpus:verify/);
  assert.doesNotMatch(workflow, /corpus:drift/);
});

test('module workflows run from the module root and watch paths that exist', () => {
  for (const name of ['test', 'accessscan-corpus', 'accessscan-drift']) {
    const workflow = readWorkflow(path.join(REPO_ROOT, `.github/workflows/${name}.yml`));
    assert.doesNotMatch(workflow, /working-directory/);
    assert.doesNotMatch(workflow, /ada-scan\//);
    assert.doesNotMatch(workflow, /secrets\./i);
  }
  const test = readWorkflow(path.join(REPO_ROOT, '.github/workflows/test.yml'));
  assert.match(test, /continue-on-error:\s*true/);
  assert.match(test, /node:\s*\[22, 24\]/);
  const corpus = readWorkflow(path.join(REPO_ROOT, '.github/workflows/accessscan-corpus.yml'));
  for (const [, watched] of corpus.matchAll(/^\s+- '([^']+)'$/gm)) {
    const base = watched.replace(/\/\*\*$/, '');
    assert.ok(existsSync(path.join(REPO_ROOT, base)), `watched path missing: ${watched}`);
  }
});
