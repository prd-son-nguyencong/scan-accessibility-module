import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CIS_POC_LIMITS, CIS_VALIDATION_LIMITS } from '../src/fix/cis/limits.js';
import {
  CIS_ACCESS_LIMITATION,
  validateFixture,
  validateLimits,
  assertBundleRedacted,
  listContractArtifacts,
} from './helpers/cis-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'cis');
const PROBE_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'cis-characterize.js');

test('production source exposes only immutable CIS limits under src/fix/cis', () => {
  assert.ok(existsSync(path.join(PACKAGE_ROOT, 'src/fix/cis/limits.js')));
  assert.ok(existsSync(path.join(PACKAGE_ROOT, 'src/fix/cis/transport.js')));
  assert.ok(existsSync(path.join(PACKAGE_ROOT, 'src/fix/cis/parser.js')));
  assert.ok(existsSync(path.join(PACKAGE_ROOT, 'src/fix/cis/advisory.js')));
  assert.ok(existsSync(path.join(PACKAGE_ROOT, 'src/fix/context/broker.js')));
  assert.equal(existsSync(path.join(PACKAGE_ROOT, 'src/cis/limits.js')), false);
  assert.equal(existsSync(path.join(PACKAGE_ROOT, 'src/cis/contract.js')), false);
});

test('Task 4 production modules do not import legacy src/fixer clients', () => {
  const modules = [
    'src/fix/cis/transport.js',
    'src/fix/cis/parser.js',
    'src/fix/cis/advisory.js',
    'src/fix/context/broker.js',
  ];
  for (const modulePath of modules) {
    const source = readFileSync(path.join(PACKAGE_ROOT, modulePath), 'utf8');
    assert.equal(source.includes("from '../../fixer/"), false, `${modulePath} must not import legacy fixer`);
    assert.equal(source.includes('from "../fixer/'), false, `${modulePath} must not import legacy fixer`);
  }
});

test('CIS_VALIDATION_LIMITS exports immutable derived bounds for Task 4 modules', () => {
  assert.throws(() => {
    CIS_VALIDATION_LIMITS.maxEditsPerPatch = 99;
  });
  assert.equal(CIS_VALIDATION_LIMITS.allowedTextExtensions.includes('.liquid'), true);
  assert.equal(CIS_VALIDATION_LIMITS.maxResponseBytes > 0, true);
});

test('CIS_POC_LIMITS exports immutable bounded PoC defaults', () => {
  validateLimits(CIS_POC_LIMITS);
  assert.equal(CIS_POC_LIMITS.maxContextRounds, 2);
  assert.equal(CIS_POC_LIMITS.maxGenerationAttempts, 2);
  assert.equal(CIS_POC_LIMITS.maxConcurrency, 2);
  assert.equal(CIS_POC_LIMITS.requestTimeoutMs, 30_000);
  assert.equal(CIS_POC_LIMITS.maxInputTokens, 8_192);
  assert.equal(CIS_POC_LIMITS.maxOutputTokens, 2_048);
  assert.equal(CIS_POC_LIMITS.sessionWallClockBudgetMs, 120_000);
  assert.equal(CIS_POC_LIMITS.sessionCallBudget, 2);
  assert.throws(() => {
    CIS_POC_LIMITS.maxContextRounds = 99;
  });
});

test('models-list request fixture matches Bruno query params', () => {
  const fixture = validateFixture('requests/models-list.json');
  assert.equal(fixture.meta.provenance, 'bruno-derived');
  assert.equal(fixture.request.query.bypass_auth, 'true');
  assert.equal(fixture.request.query.model, '');
  assert.equal(fixture.request.method, 'GET');
});

test('models inferred response fixture is synthetic-inferred not Bruno-established', () => {
  const fixture = validateFixture('responses/models-success.json');
  assert.equal(fixture.meta.provenance, 'synthetic-inferred');
  assert.equal(fixture.response.status, 200);
  assert.ok(Array.isArray(fixture.response.body.data));
  assert.ok(fixture.response.headers['x-request-id']);
});

test('models error response fixture is synthetic-inferred', () => {
  const fixture = validateFixture('responses/models-error-missing-feature-key.json');
  assert.equal(fixture.meta.provenance, 'synthetic-inferred');
  assert.equal(fixture.response.status, 401);
  assert.ok(fixture.response.body.error);
});

test('predictions success response fixture is synthetic-inferred with usage shape', () => {
  const fixture = validateFixture('responses/predictions-success.json');
  assert.equal(fixture.meta.provenance, 'synthetic-inferred');
  assert.equal(fixture.response.status, 200);
  assert.equal(fixture.response.body.prediction.type, 'openai-chat-completion-v1');
  assert.ok(fixture.response.body.prediction.output.usage);
  assert.equal(typeof fixture.response.body.prediction.output.usage.prompt_tokens, 'number');
  assert.equal(typeof fixture.response.body.prediction.output.usage.completion_tokens, 'number');
  assert.equal(typeof fixture.response.body.prediction.output.usage.total_tokens, 'number');
});

test('predictions invalid-model error response fixture is synthetic-inferred', () => {
  const fixture = validateFixture('responses/predictions-error-invalid-model.json');
  assert.equal(fixture.meta.provenance, 'synthetic-inferred');
  assert.ok(fixture.response.status >= 400);
  assert.ok(fixture.response.body.error);
});

test('predictions timeout fixture is synthetic and documents abort behavior', () => {
  const fixture = validateFixture('responses/predictions-timeout.json');
  assert.equal(fixture.meta.provenance, 'synthetic');
  assert.equal(fixture.response.error, 'timeout');
  assert.equal(fixture.response.elapsedMs, CIS_POC_LIMITS.requestTimeoutMs);
});

test('predictions malformed-output fixture is synthetic advisory hazard sample', () => {
  const fixture = validateFixture('responses/predictions-malformed-output.json');
  assert.equal(fixture.meta.provenance, 'synthetic');
  assert.equal(fixture.response.status, 200);
  assert.equal(fixture.parseResult.validJson, false);
  assert.equal(fixture.parseResult.actionableContent, false);
});

test('predictions chat-completion request fixture matches Bruno envelope', () => {
  const fixture = validateFixture('requests/predictions-chat-completion.json');
  assert.equal(fixture.meta.provenance, 'bruno-derived');
  assert.deepEqual(fixture.request.target, {
    provider: 'aws',
    model: 'anthropic.claude-sonnet-4-20250514-v1:0',
  });
  assert.equal(fixture.request.task.type, 'openai-chat-completion-v1');
  assert.ok(Array.isArray(fixture.request.task.input.messages));
});

test('structured-output and tools request fixtures are synthetic-probe', () => {
  const structured = validateFixture('requests/predictions-structured-output.json');
  const tools = validateFixture('requests/predictions-tools.json');
  assert.equal(structured.meta.provenance, 'synthetic-probe');
  assert.equal(tools.meta.provenance, 'synthetic-probe');
  assert.equal(structured.request.task.input.response_format.type, 'json_object');
  assert.ok(Array.isArray(tools.request.task.input.tools));
  assert.equal(CIS_ACCESS_LIMITATION.structuredOutputPassThrough, 'unverified');
  assert.equal(CIS_ACCESS_LIMITATION.toolsPassThrough, 'unverified');
});

test('observed-environment fixture records network-unreachable characterization', () => {
  const fixture = validateFixture('responses/characterization-network-unreachable.json');
  assert.equal(fixture.meta.provenance, 'observed-environment');
  assert.equal(fixture.observation.reachable, false);
  assert.equal(fixture.observation.error, 'fetch failed');
  assert.ok(fixture.observation.probeScript);
});

test('bruno source manifest documents sanitized excerpts', () => {
  const manifestPath = path.join(FIXTURES_ROOT, 'bruno-source', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.externalSourcePath, '<operator-home>/Documents/bruno/ml-https');
  assert.ok(manifest.files.length >= 2);
  for (const entry of manifest.files) {
    const sanitizedPath = path.join(FIXTURES_ROOT, 'bruno-source', entry.file);
    assert.ok(existsSync(sanitizedPath));
    assertBundleRedacted(readFileSync(sanitizedPath, 'utf8'), entry.file);
  }
});

test('cis-characterize script is import-safe and uses shared redaction helpers', () => {
  const source = readFileSync(PROBE_SCRIPT, 'utf8');
  assert.match(source, /CIS_BASE_URL/);
  assert.match(source, /CIS_FEATURE_KEY/);
  assert.match(source, /CIS_MODEL/);
  assert.match(source, /CIS_PROBES/);
  assert.match(source, /sessionCallBudget/);
  assert.match(source, /isMain/);
  assert.match(source, /cis-redaction\.js/);
  assertBundleRedacted(source, PROBE_SCRIPT);
});

test('contract docs and fixtures contain no secrets or internal hosts', () => {
  const artifacts = listContractArtifacts();
  assert.ok(artifacts.length > 0);
  for (const artifact of artifacts) {
    assertBundleRedacted(readFileSync(artifact, 'utf8'), artifact);
  }
});

test('every fixture JSON includes valid provenance rules', () => {
  const files = readdirSync(FIXTURES_ROOT, { recursive: true })
    .filter((entry) => String(entry).endsWith('.json') && !String(entry).includes('bruno-source/manifest'))
    .map((entry) => path.join(FIXTURES_ROOT, entry));
  assert.ok(files.length >= 9);
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(parsed.meta?.provenance, `${file} missing meta.provenance`);
    validateFixture(path.relative(FIXTURES_ROOT, file));
  }
});
