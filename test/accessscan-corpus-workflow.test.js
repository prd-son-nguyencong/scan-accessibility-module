import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKAGE_ROOT = path.join(__dirname, '..');
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
  assert.match(workflow, /node-version-file:\s*['"]?\.nvmrc['"]?/);
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

test('accessscan-corpus workflow is a blocking frozen verify gate on push and pull_request', () => {
  const workflow = readWorkflow(CORPUS_WORKFLOW);

  assert.match(workflow, /on:\s*\n\s*push:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /corpus:verify/);
  assert.match(workflow, /node-version-file:\s*['"]?\.nvmrc['"]?/);
  assert.match(workflow, /playwright install/i);
  assert.doesNotMatch(workflow, /run-drift-nonblocking\.sh/);
  assert.doesNotMatch(workflow, /exit 0\s*#.*non-blocking/i);
});

test('accessscan-corpus workflow enforces blocking verify only gate', () => {
  const workflow = readWorkflow(CORPUS_WORKFLOW);
  assert.match(workflow, /corpus:verify/);
  assert.doesNotMatch(workflow, /corpus:drift/);
});
